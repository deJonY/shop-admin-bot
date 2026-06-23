const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

const PAYME_KEY = process.env.PAYME_KEY;

// ============================================
// AUTHENTICATION
// ============================================
function checkAuth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth) {
        return res.json({
            id: req.body.id || null,
            error: {
                code: -32504,
                message: "Insufficient privilege"
            }
        });
    }

    try {
        const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf-8');
        const key = decoded.split(':')[1];

        if (key !== PAYME_KEY) {
            return res.json({
                id: req.body.id || null,
                error: {
                    code: -32504,
                    message: "Insufficient privilege"
                }
            });
        }
    } catch (error) {
        return res.json({
            id: req.body.id || null,
            error: {
                code: -32504,
                message: "Invalid authentication"
            }
        });
    }

    next();
}

// ============================================
// PAYME WEBHOOK
// ============================================
router.post('/', checkAuth, async (req, res) => {
    const { id, method, params } = req.body;

    console.log(`📥 Payme webhook: ${method}`, { id, params });

    try {
        // ─── CheckPerformTransaction ─────────────────────────────────
        if (method === 'CheckPerformTransaction') {
            const orderId = params.account?.orderId;

            if (!orderId) {
                return res.json({
                    id,
                    error: {
                        code: -31050,
                        message: {
                            uz: "Buyurtma ID topilmadi",
                            ru: "ID заказа не найден",
                            en: "Order ID not found"
                        }
                    }
                });
            }

            const orderDoc = await db.collection('orders').doc(orderId).get();

            if (!orderDoc.exists) {
                return res.json({
                    id,
                    error: {
                        code: -31050,
                        message: {
                            uz: "Buyurtma topilmadi",
                            ru: "Заказ не найден",
                            en: "Order not found"
                        }
                    }
                });
            }

            const order = orderDoc.data();

            const expectedAmount = Math.round((order.totalUZS || order.total || 0) * 100); // so'm → tiyin

            if (params.amount !== expectedAmount) {
                return res.json({
                    id,
                    error: {
                        code: -31001,
                        message: {
                            uz: "Summa noto'g'ri",
                            ru: "Неверная сумма",
                            en: "Wrong amount"
                        }
                    }
                });
            }

            // Buyurtma allaqachon to'langanmi?
            if (order.paymentStatus === 'paid') {
                return res.json({
                    id,
                    error: {
                        code: -31060,
                        message: {
                            uz: "Buyurtma allaqachon to'langan",
                            ru: "Заказ уже оплачен",
                            en: "Order already paid"
                        }
                    }
                });
            }

            return res.json({ id, result: { allow: true } });
        }

        // ─── CreateTransaction ───────────────────────────────────────
        if (method === 'CreateTransaction') {
            const transactionId = params.id;
            const orderId = params.account?.orderId;

            if (!orderId) {
                return res.json({
                    id,
                    error: {
                        code: -31050,
                        message: "Order ID not found"
                    }
                });
            }

            // Tranzaksiya mavjudligini tekshirish
            const existingDoc = await db.collection('payme_transactions').doc(transactionId).get();

            if (existingDoc.exists) {
                const existing = existingDoc.data();
                if (existing.state !== 1) {
                    return res.json({
                        id,
                        error: {
                            code: -31008,
                            message: "Unable to complete operation"
                        }
                    });
                }
                return res.json({
                    id,
                    result: {
                        create_time: existing.createTime,
                        transaction: transactionId,
                        state: 1
                    }
                });
            }

            // Buyurtmani tekshirish
            const orderDoc = await db.collection('orders').doc(orderId).get();
            if (!orderDoc.exists) {
                return res.json({
                    id,
                    error: {
                        code: -31050,
                        message: {
                            uz: "Buyurtma topilmadi",
                            ru: "Заказ не найден",
                            en: "Order not found"
                        }
                    }
                });
            }

            // Payme 12 soatlik limit (43200000 ms)
            const TIMEOUT_MS = 12 * 60 * 60 * 1000;
            if (Date.now() - params.time > TIMEOUT_MS) {
                return res.json({
                    id,
                    error: {
                        code: -31008,
                        message: "Transaction timed out"
                    }
                });
            }

            // Yangi tranzaksiya yaratish
            const transaction = {
                id: transactionId,
                orderId,
                amount: params.amount,
                createTime: params.time, // Payme dan kelgan vaqt (ms)
                performTime: null,
                cancelTime: null,
                state: 1, // 1 = yaratilgan
                reason: null,
                createdAt: new Date().toISOString(),
            };

            await db.collection('payme_transactions').doc(transactionId).set(transaction);

            // Buyurtma statusini yangilash
            await db.collection('orders').doc(orderId).update({
                paymentStatus: 'processing',
                transactionId: transactionId,
            });

            return res.json({
                id,
                result: {
                    create_time: params.time,
                    transaction: transactionId,
                    state: 1
                }
            });
        }

        // ─── PerformTransaction ──────────────────────────────────────
        if (method === 'PerformTransaction') {
            const transactionId = params.id;
            const transDoc = await db.collection('payme_transactions').doc(transactionId).get();

            if (!transDoc.exists) {
                return res.json({
                    id,
                    error: {
                        code: -31003,
                        message: "Transaction not found"
                    }
                });
            }

            const trans = transDoc.data();

            // Agar allaqachon to'langan bo'lsa
            if (trans.state === 2) {
                return res.json({
                    id,
                    result: {
                        transaction: transactionId,
                        perform_time: trans.performTime,
                        state: 2
                    }
                });
            }

            // Faqat 1 (yaratilgan) holatdan to'lash mumkin
            if (trans.state !== 1) {
                return res.json({
                    id,
                    error: {
                        code: -31008,
                        message: "Unable to complete operation"
                    }
                });
            }

            // To'lovni amalga oshirish
            const performTime = Date.now();

            await db.collection('payme_transactions').doc(transactionId).update({
                state: 2, // 2 = to'langan
                performTime
            });

            // Buyurtmani to'langan deb belgilash
            await db.collection('orders').doc(trans.orderId).update({
                paymentStatus: 'paid',
                status: 'confirmed',
                paidAt: new Date().toISOString(),
            });

            // 🔴 QO'SHIMCHA: Admin botga xabar yuborish (agar kerak bo'lsa)
            // await sendNotificationToAdmin('Buyurtma to\'landi: ' + trans.orderId);

            return res.json({
                id,
                result: {
                    transaction: transactionId,
                    perform_time: performTime,
                    state: 2
                }
            });
        }

        // ─── CancelTransaction ───────────────────────────────────────
        if (method === 'CancelTransaction') {
            const transactionId = params.id;
            const transDoc = await db.collection('payme_transactions').doc(transactionId).get();

            if (!transDoc.exists) {
                return res.json({
                    id,
                    error: {
                        code: -31003,
                        message: "Transaction not found"
                    }
                });
            }

            const trans = transDoc.data();

            // Agar allaqachon bekor qilingan bo'lsa
            if (trans.state === -1) {
                return res.json({
                    id,
                    result: {
                        transaction: transactionId,
                        cancel_time: trans.cancelTime,
                        state: -1
                    }
                });
            }

            // To'langan buyurtmani bekor qilib bo'lmaydi
            if (trans.state === 2) {
                return res.json({
                    id,
                    error: {
                        code: -31007,
                        message: {
                            uz: "To'langan buyurtmani bekor qilib bo'lmaydi",
                            ru: "Нельзя отменить оплаченный заказ",
                            en: "Could not cancel. Order is already paid."
                        }
                    }
                });
            }

            // Bekor qilish
            const cancelTime = Date.now();

            await db.collection('payme_transactions').doc(transactionId).update({
                state: -1, // -1 = bekor qilingan
                cancelTime,
                reason: params.reason || null
            });

            // Buyurtmani bekor qilingan deb belgilash
            await db.collection('orders').doc(trans.orderId).update({
                paymentStatus: 'cancelled',
                status: 'cancelled',
                cancelledAt: new Date().toISOString(),
            });

            return res.json({
                id,
                result: {
                    transaction: transactionId,
                    cancel_time: cancelTime,
                    state: -1
                }
            });
        }

        // ─── CheckTransaction ────────────────────────────────────────
        if (method === 'CheckTransaction') {
            const transactionId = params.id;
            const transDoc = await db.collection('payme_transactions').doc(transactionId).get();

            if (!transDoc.exists) {
                return res.json({
                    id,
                    error: {
                        code: -31003,
                        message: "Transaction not found"
                    }
                });
            }

            const trans = transDoc.data();

            return res.json({
                id,
                result: {
                    create_time: trans.createTime,
                    perform_time: trans.performTime || 0,
                    cancel_time: trans.cancelTime || 0,
                    transaction: transactionId,
                    state: trans.state,
                    reason: trans.reason || null,
                },
            });
        }

        // ─── GetStatement ────────────────────────────────────────────
        if (method === 'GetStatement') {
            const { from, to } = params;

            const snapshot = await db.collection('payme_transactions')
                .where('createTime', '>=', from)
                .where('createTime', '<=', to)
                .get();

            const transactions = snapshot.docs.map(doc => {
                const t = doc.data();
                return {
                    id: t.id,
                    time: t.createTime,
                    amount: t.amount,
                    account: { orderId: t.orderId },
                    create_time: t.createTime,
                    perform_time: t.performTime || 0,
                    cancel_time: t.cancelTime || 0,
                    transaction: t.id,
                    state: t.state,
                    reason: t.reason || null,
                };
            });

            return res.json({ id, result: { transactions } });
        }

        // ─── Unknown Method ──────────────────────────────────────────
        return res.json({
            id,
            error: {
                code: -32601,
                message: "Method not found"
            }
        });

    } catch (error) {
        console.error('❌ Payme webhook xato:', error);
        return res.json({
            id: req.body.id || null,
            error: {
                code: -32400,
                message: error.message || "Internal error"
            }
        });
    }
});

module.exports = router;