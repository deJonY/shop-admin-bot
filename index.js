// index.js — Shop-bot admin bot (auto-parts)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');

// ENV
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_BOT_TOKEN = process.env.USER_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://spiffy-dusk-9fbdd8.netlify.app/';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const admins = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

// Bonus konstantalar
const BONUS_DISCOUNT_PERCENT = 15; // 2-buyurtma uchun chegirma

// Firebase init
let db;
try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON topilmadi.");
    }
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log("✅ Firebase ulangan.");
} catch (error) {
    console.error("❌ Firebase sozlashda xato!", error.message);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Buyurtma listener
if (db) {
    const botStartTime = admin.firestore.Timestamp.now();
    console.log("🔔 Order listener faol...");

    db.collection('orders')
        .where('status', '==', 'new')
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const orderData = change.doc.data();
                    const orderId = change.doc.id;
                    let isNew = false;
                    if (orderData.createdAt) {
                        const orderTime = orderData.createdAt.toMillis ? orderData.createdAt.toMillis() : new Date(orderData.createdAt).getTime();
                        if (orderTime > botStartTime.toMillis()) isNew = true;
                    } else {
                        isNew = true;
                    }
                    if (isNew) notifyAdminsNewOrder(orderId, orderData);
                }
            });
        }, error => console.error("❌ Order listener xatosi:", error));

    function notifyAdminsNewOrder(orderId, orderData) {
        let itemsText = '';
        if (orderData.items && orderData.items.length > 0) {
            itemsText = orderData.items.map(item => {
                const totalPrice = (item.price * item.quantity).toLocaleString("uz-UZ");
                return `- ${item.quantity} x ${item.name} — ${totalPrice} so'm`;
            }).join('\n');
        } else {
            itemsText = "Mahsulotlar yo'q";
        }

        const paymentMethodText = orderData.paymentMethod === 'cash' ? 'Naqt' : 'Karta';

        // BONUS BLOK
        let bonusBlock = '';
        if (orderData.orderType === 'discount') {
            bonusBlock = `🎁 Buyurtma turi: 2-buyurtma — ${BONUS_DISCOUNT_PERCENT}% chegirma\n\n`;
        } else if (orderData.orderType === 'bonus') {
            const bonusName = orderData.bonusItem?.name || "Bonus mahsulot";
            bonusBlock = `🎁 Buyurtma turi: 3-buyurtma — 1+1 BONUS\n🎁 Bonus mahsulot: ${bonusName}\n\n`;
        } else {
            bonusBlock = `🎁 Buyurtma turi: 1-buyurtma — to'liq narx\n\n`;
        }

        // YETKAZIB BERISH
        let deliveryBlock = '';
        if (orderData.deliveryMethod === 'pickup') {
            deliveryBlock = `📦 Yetkazib berish: O'zim olib ketaman\n🏪 Manzil: ${orderData.pickupAddress || 'Belgilanmagan'}\n\n`;
        } else if (orderData.deliveryMethod === 'delivery') {
            const distance = orderData.distanceKm ? `${orderData.distanceKm.toFixed(1)} km` : "Noma'lum";
            const deliveryFeeUZS = orderData.deliveryFee || 0;
            const deliveryFeeText = deliveryFeeUZS === 0
                ? "Bepul"
                : `${deliveryFeeUZS.toLocaleString("uz-UZ")} so'm`;
            deliveryBlock = `📦 Yetkazib berish: Yetkazib berish\n📏 Masofa: ~${distance}\n🚚 Narx: ${deliveryFeeText}\n📍 Manzil: ${orderData.deliveryAddress || 'Kiritilmagan'}\n\n`;
        } else {
            deliveryBlock = `📍 Manzil: ${orderData.deliveryAddress || 'Kiritilmagan'}\n\n`;
        }

        const message = `🛒 YANGI BUYURTMA!\n\n` +
            `👤 Mijoz: ${orderData.customerName || 'Noma\'lum'}\n` +
            `📞 Telefon: ${orderData.customerPhone || 'Noma\'lum'}\n` +
            `🆔 Telegram ID: ${orderData.customerTelegramId || 'Yo\'q'}\n\n` +
            bonusBlock +
            deliveryBlock +
            `🛍 Mahsulotlar:\n${itemsText}\n\n` +
            `💰 Jami: ${(orderData.totalUZS || 0).toLocaleString("uz-UZ")} so'm\n` +
            `💳 To'lov: ${paymentMethodText}`;

        const inlineKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Tasdiqlash", callback_data: `confirm_order_${orderId}` },
                    { text: "❌ Bekor qilish", callback_data: `cancel_order_${orderId}` }
                ]
            ]
        };

        admins.forEach(adminId => {
            bot.sendMessage(adminId, message, { reply_markup: inlineKeyboard }).catch(err => {
                console.error(`Admin ${adminId} ga xabar yuborishda xato:`, err.message);
            });
        });
    }
}

const userState = {};

// KEYBOARDS
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🛍 Mahsulot qo'shish" }, { text: "📂 Kategoriya qo'shish" }],
            [{ text: "📂 Kategoriya yangilash" }, { text: "🔄 Mahsulotni yangilash" }],
            [{ text: "👥 Mijoz qo'shish" }, { text: "👥 Mijozlar ro'yxati" }],
            [{ text: "📊 Statistika" }, { text: "📦 Buyurtmalar" }],
            [{ text: "❌ Bekor qilish" }],
        ],
        resize_keyboard: true,
    },
};

const backKeyboard = {
    reply_markup: { keyboard: [["Orqaga"]], resize_keyboard: true }
};

const mainBackKeyboard = {
    reply_markup: {
        keyboard: [
            ...mainKeyboard.reply_markup.keyboard.slice(0, -1),
            [{ text: "❌ Bekor qilish" }, { text: "Orqaga" }]
        ],
        resize_keyboard: true,
    },
};

// HELPERS
async function getNextId(collectionName) {
    if (!db) return -1;
    try {
        const snapshot = await db.collection(collectionName).orderBy('id', 'desc').limit(1).get();
        if (snapshot.empty) return 1;
        const lastId = snapshot.docs[0].data().id;
        const lastIdNum = parseInt(lastId);
        if (isNaN(lastIdNum) || lastIdNum <= 0) return 1;
        return lastIdNum + 1;
    } catch (error) {
        console.error(`getNextId xato:`, error);
        return -1;
    }
}

async function uploadToImgBB(fileId) {
    try {
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        const form = new FormData();
        form.append('key', IMGBB_API_KEY);
        form.append('image', buffer, { filename: 'product_image.jpg', contentType: 'image/jpeg' });
        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', form, {
            headers: { ...form.getHeaders() }
        });
        if (uploadResponse.data.success) return uploadResponse.data.data.url;
        return null;
    } catch (error) {
        console.error('ImgBB xato:', error.message);
        return null;
    }
}

async function getProductsInCategory(categoryName) {
    if (!db) return 0;
    try {
        const snapshot = await db.collection('products').where('category', '==', categoryName).get();
        return snapshot.size;
    } catch (error) {
        return 0;
    }
}

function resetUserState(chatId) {
    userState[chatId] = { step: 'none', data: {}, steps: [] };
}

function parseNumberInput(input, isPrice = false) {
    if (typeof input !== 'string') return null;
    let normalized = input.replace(/,/g, '.');
    const parsed = parseFloat(normalized);
    if (isNaN(parsed) || parsed < 0) return null;
    if (isPrice) {
        const parts = normalized.split('.');
        if (parts.length === 2 && parts[1].length > 3) {
            normalized = parts[0] + '.' + parts[1].substring(0, 3);
        }
        return parseFloat(normalized);
    }
    return parsed;
}

function formatTimestamp(ts) {
    if (!ts) return "Yo'q";
    try {
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        return `${dd}.${mm}.${date.getFullYear()}`;
    } catch (e) {
        return "Yo'q";
    }
}

function parseDateDDMMYYYY(text) {
    const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) return null;
    const day = parseInt(match[1]);
    const month = parseInt(match[2]);
    const year = parseInt(match[3]);
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2024 || year > 2100) return null;
    const dateObj = new Date(year, month - 1, day, 0, 0, 0);
    if (dateObj.getDate() !== day || dateObj.getMonth() !== month - 1 || dateObj.getFullYear() !== year) return null;
    return dateObj;
}

// VIEW FUNKSIYALAR
async function showCategoryView(chatId, categoryId, messageId) {
    try {
        const doc = await db.collection('categories').doc(String(categoryId)).get();
        if (!doc.exists) {
            if (messageId) bot.editMessageText("Kategoriya topilmadi!", { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            return;
        }
        const categoryData = doc.data();
        const updateKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Nomi: ${categoryData.name}`, callback_data: `cat_update_name_${categoryId}` }],
                    [{ text: `Ikonka: ${categoryData.icon}`, callback_data: `cat_update_icon_${categoryId}` }],
                    [{ text: "🗑 Kategoriyani o'chirish", callback_data: `delete_category_${categoryId}` }],
                    [{ text: "⬅️ Orqaga", callback_data: 'back_to_prev' }]
                ],
            },
        };
        const message = `📝 Kategoriya: ${categoryData.icon} ${categoryData.name} (ID: ${categoryId})\nQaysi maydonni yangilashni xohlaysiz?`;
        if (messageId) {
            bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: updateKeyboard.reply_markup });
        } else {
            bot.sendMessage(chatId, message, updateKeyboard);
        }
    } catch (error) {
        console.error("Kategoriya view xato:", error);
    }
}

async function showProductView(chatId, productId, messageId) {
    try {
        const doc = await db.collection('products').doc(String(productId)).get();
        if (!doc.exists) {
            if (messageId) bot.editMessageText("Mahsulot topilmadi!", { chat_id: chatId, message_id: messageId });
            return;
        }
        const p = doc.data();
        const startDateText = formatTimestamp(p.discountStartDate);
        const endDateText = formatTimestamp(p.discountEndDate);

        const updateKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Nomi: ${p.name}`, callback_data: `update_field_name_${productId}` }],
                    [{ text: `Narx: ${(p.price || 0).toLocaleString('uz-UZ')} so'm`, callback_data: `update_field_price_${productId}` }],
                    [{ text: `Chegirma: ${p.discount || 0}%`, callback_data: `update_field_discount_${productId}` }],
                    [{ text: `📅 Chegirma boshlanishi: ${startDateText}`, callback_data: `update_field_discountStart_${productId}` }],
                    [{ text: `📅 Chegirma tugashi: ${endDateText}`, callback_data: `update_field_discountEnd_${productId}` }],
                    [{ text: `Stock: ${(p.stock || 0).toLocaleString()} dona`, callback_data: `update_field_stock_${productId}` }],
                    [{ text: `Tavsif: ${p.description ? p.description.substring(0, 20) + '...' : 'Yo\'q'}`, callback_data: `update_field_description_${productId}` }],
                    [{ text: `Rasm: ${p.image ? 'Bor' : 'Yo\'q'}`, callback_data: `update_field_image_${productId}` }],
                    [{ text: "🗑 Mahsulotni o'chirish", callback_data: `delete_product_${productId}` }],
                    [{ text: "⬅️ Orqaga", callback_data: 'back_to_prev' }]
                ],
            },
        };
        const message = `📝 Mahsulot: ${p.name} (ID: ${productId})\n` +
            `• Narx: ${(p.price || 0).toLocaleString('uz-UZ')} so'm\n` +
            `• Chegirma: ${p.discount || 0}%\n` +
            `• Chegirma boshlanishi: ${startDateText}\n` +
            `• Chegirma tugashi: ${endDateText}\n` +
            `• Stock: ${(p.stock || 0).toLocaleString()} dona\n` +
            `• Kategoriya: ${p.category}\n` +
            `• Tavsif: ${p.description || 'Belgilanmagan'}\n` +
            `• Rasm: ${p.image ? 'URL mavjud' : 'Yo\'q'}\n` +
            `Qaysi maydonni yangilashni xohlaysiz?`;
        if (messageId) {
            bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: updateKeyboard.reply_markup });
        } else {
            bot.sendMessage(chatId, message, updateKeyboard);
        }
    } catch (error) {
        console.error("Mahsulot view xato:", error);
    }
}

async function showCategoryUpdateSelect(chatId, messageId = null) {
    try {
        const snapshot = await db.collection('categories').get();
        if (snapshot.empty) {
            const text = "Hech qanday kategoriya topilmadi.";
            if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            return;
        }
        const cats = snapshot.docs.map(d => { const x = d.data(); return { id: x.id, name: x.name, icon: x.icon }; });
        const kb = { reply_markup: { inline_keyboard: [] } };
        for (let i = 0; i < cats.length; i += 2) {
            const row = [{ text: `${cats[i].icon} ${cats[i].name}`, callback_data: `cat_select_${cats[i].id}` }];
            if (i + 1 < cats.length) row.push({ text: `${cats[i + 1].icon} ${cats[i + 1].name}`, callback_data: `cat_select_${cats[i + 1].id}` });
            kb.reply_markup.inline_keyboard.push(row);
        }
        const text = "Qaysi kategoriyani yangilashni xohlaysiz?";
        if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: kb.reply_markup });
        else bot.sendMessage(chatId, text, kb);
    } catch (error) {
        console.error("Kategoriyalarni olishda xato:", error);
    }
}

async function showProductUpdateCategorySelect(chatId, messageId = null) {
    try {
        const snapshot = await db.collection('categories').get();
        if (snapshot.empty) {
            const text = "Hech qanday kategoriya topilmadi.";
            if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            return;
        }
        const cats = snapshot.docs.map(d => { const x = d.data(); return { id: x.id, name: x.name, icon: x.icon }; });
        const kb = { reply_markup: { inline_keyboard: [] } };
        for (let i = 0; i < cats.length; i += 2) {
            const row = [{ text: `${cats[i].icon} ${cats[i].name}`, callback_data: `select_category_${cats[i].id}` }];
            if (i + 1 < cats.length) row.push({ text: `${cats[i + 1].icon} ${cats[i + 1].name}`, callback_data: `select_category_${cats[i + 1].id}` });
            kb.reply_markup.inline_keyboard.push(row);
        }
        const text = "Qaysi kategoriyadagi mahsulotni yangilashni xohlaysiz?";
        if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: kb.reply_markup });
        else bot.sendMessage(chatId, text, kb);
    } catch (error) {
        console.error("Xato:", error);
    }
}

async function showProductsInCategory(chatId, categoryName, messageId = null) {
    try {
        const snapshot = await db.collection('products').where('category', '==', categoryName).get();
        if (snapshot.empty) {
            const text = `"${categoryName}" kategoriyasida mahsulot yo'q.`;
            if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, text, mainKeyboard);
            resetUserState(chatId);
            return;
        }
        const products = snapshot.docs.map(d => { const x = d.data(); return { id: x.id, name: x.name }; });
        const kb = { reply_markup: { inline_keyboard: [] } };
        for (let i = 0; i < products.length; i += 2) {
            const row = [{ text: products[i].name, callback_data: `update_product_${products[i].id}` }];
            if (i + 1 < products.length) row.push({ text: products[i + 1].name, callback_data: `update_product_${products[i + 1].id}` });
            kb.reply_markup.inline_keyboard.push(row);
        }
        kb.reply_markup.inline_keyboard.push([{ text: "⬅️ Orqaga", callback_data: 'back_to_prev' }]);
        const text = `"${categoryName}" kategoriyasidagi mahsulotlar:`;
        if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: kb.reply_markup });
        else bot.sendMessage(chatId, text, kb);
        const state = userState[chatId];
        if (state) state.data.selectedCategory = categoryName;
    } catch (error) {
        console.error("Xato:", error);
    }
}

// HANDLE BACK
async function handleBack(chatId) {
    const state = userState[chatId];
    if (!state || state.steps.length === 0) {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        return;
    }
    const prevStep = state.steps.pop();
    state.step = prevStep;

    if (prevStep === 'product_update_view') {
        await showProductView(chatId, state.data.productId, state.data.messageId);
    } else if (prevStep === 'product_update_product_select') {
        if (state.data.selectedCategory) await showProductsInCategory(chatId, state.data.selectedCategory, state.data.messageId);
        else { resetUserState(chatId); bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard); }
    } else if (['update_product_name', 'update_product_description', 'update_product_image', 'update_value', 'update_discount_date'].includes(prevStep)) {
        await showProductView(chatId, state.data.productId, state.data.messageId);
    } else if (prevStep === 'category_update_view') {
        await showCategoryView(chatId, state.data.categoryId, state.data.messageId);
    } else if (['update_category_name', 'update_category_icon'].includes(prevStep)) {
        await showCategoryView(chatId, state.data.categoryId, state.data.messageId);
    } else if (prevStep.startsWith('customer_')) {
        const stepMessages = {
            'customer_firstName': "1/5. Mijozning ismini kiriting:",
            'customer_lastName': "2/5. Familiyasini kiriting:",
            'customer_phone': "3/5. Telefon raqamini kiriting (mas: +998901234567):",
            'customer_login': "4/5. Login yarating (mas: jonibek_123, faqat lotin harflar/raqamlar/_, kamida 3 belgi):",
            'customer_password': "5/5. Parol yarating (kamida 4 belgi):",
        };
        bot.sendMessage(chatId, stepMessages[prevStep] || "Bosh menyu.", backKeyboard);
    } else if (prevStep.startsWith('product_')) {
        await handleProductStep(chatId, prevStep, true);
    } else if (prevStep.startsWith('category_')) {
        await handleCategoryStep(chatId, prevStep, true);
    } else {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    }
}

async function handleInlineBack(chatId, messageId) {
    const state = userState[chatId];
    if (!state || state.steps.length === 0) {
        resetUserState(chatId);
        bot.editMessageText("Bekor qilindi.", { chat_id: chatId, message_id: messageId });
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        return;
    }
    const prevStep = state.steps.pop();
    state.step = prevStep;
    if (prevStep === 'category_update_select') await showCategoryUpdateSelect(chatId, messageId);
    else if (prevStep === 'product_update_category_select') await showProductUpdateCategorySelect(chatId, messageId);
    else if (prevStep === 'product_update_product_select') {
        if (state.data.selectedCategory) await showProductsInCategory(chatId, state.data.selectedCategory, messageId);
        else await showProductUpdateCategorySelect(chatId, messageId);
    } else if (prevStep === 'category_update_view') await showCategoryView(chatId, state.data.categoryId, messageId);
    else if (prevStep === 'product_update_view') await showProductView(chatId, state.data.productId, messageId);
    else {
        resetUserState(chatId);
        bot.editMessageText("Bekor qilindi.", { chat_id: chatId, message_id: messageId });
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    }
}

// MAIN COMMANDS
async function handleCommand(chatId, text) {
    resetUserState(chatId);
    if (!db) {
        bot.sendMessage(chatId, "❌ Database ulanmagan.", mainKeyboard);
        return;
    }
    if (text === "🛍 Mahsulot qo'shish") {
        const snapshot = await db.collection('categories').get();
        const categoryNames = snapshot.docs.map(d => d.data().name);
        if (categoryNames.length === 0) {
            bot.sendMessage(chatId, "Avval kategoriya qo'shing.", mainKeyboard);
            return;
        }
        userState[chatId] = { step: 'product_name', data: { categoryNames }, steps: [] };
        bot.sendMessage(chatId, "1/8. Mahsulot nomini kiriting:", backKeyboard);
        return;
    }
    if (text === "📂 Kategoriya qo'shish") {
        userState[chatId] = { step: 'category_name', data: {}, steps: [] };
        bot.sendMessage(chatId, "1/2. Kategoriya nomini kiriting:", backKeyboard);
        return;
    }
    if (text === "📂 Kategoriya yangilash") {
        userState[chatId] = { step: 'category_update_select', data: {}, steps: [] };
        await showCategoryUpdateSelect(chatId);
        return;
    }
    if (text === "🔄 Mahsulotni yangilash") {
        userState[chatId] = { step: 'product_update_category_select', data: {}, steps: [] };
        await showProductUpdateCategorySelect(chatId);
        return;
    }
    if (text === "👥 Mijoz qo'shish") {
        userState[chatId] = { step: 'customer_firstName', data: {}, steps: [] };
        bot.sendMessage(chatId, "1/5. Mijozning ismini kiriting:", backKeyboard);
        return;
    }
    if (text === "👥 Mijozlar ro'yxati") {
        try {
            const snapshot = await db.collection('customers').orderBy('createdAt', 'desc').limit(20).get();
            if (snapshot.empty) {
                bot.sendMessage(chatId, "Hali mijozlar yo'q.", mainKeyboard);
                return;
            }
            let msg = `👥 Mijozlar ro'yxati (oxirgi 20):\n\n`;
            snapshot.docs.forEach((doc, idx) => {
                const c = doc.data();
                const tgStatus = c.telegramId ? `✅ TG: ${c.telegramId}` : `⏳ Hali kirmagan`;
                msg += `${idx + 1}. ${c.firstName} ${c.lastName}\n`;
                msg += `   📞 ${c.phone}\n`;
                msg += `   🔑 Login: ${c.login} | Parol: ${c.password}\n`;
                msg += `   ${tgStatus}\n`;
                msg += `   📦 Buyurtmalar: ${c.totalOrders || 0} ta (bonus: ${c.ordersCount || 0}/3)\n\n`;
            });
            bot.sendMessage(chatId, msg, mainKeyboard);
        } catch (error) {
            console.error("Mijozlarni olishda xato:", error);
            bot.sendMessage(chatId, "❌ Xato!", mainKeyboard);
        }
        return;
    }
    if (text === "❌ Bekor qilish") {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Bekor qilindi.", mainKeyboard);
        return;
    }
    if (text === "📊 Statistika") {
        try {
            const p = await db.collection('products').get();
            const c = await db.collection('categories').get();
            const o = await db.collection('orders').get();
            const cust = await db.collection('customers').get();
            bot.sendMessage(chatId,
                `📊 Statistika:\n` +
                `🔹 Mahsulotlar: ${p.size}\n` +
                `🔹 Kategoriyalar: ${c.size}\n` +
                `🔹 Buyurtmalar: ${o.size}\n` +
                `🔹 Mijozlar: ${cust.size}`,
                mainKeyboard
            );
        } catch (error) {
            bot.sendMessage(chatId, "❌ Xato!", mainKeyboard);
        }
        return;
    }
    if (text === "📦 Buyurtmalar") {
        try {
            const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').limit(10).get();
            if (snapshot.empty) {
                bot.sendMessage(chatId, "Buyurtmalar yo'q.", mainKeyboard);
                return;
            }
            const kb = { inline_keyboard: [] };
            snapshot.docs.forEach(doc => {
                const o = doc.data();
                let emoji = "🆕";
                if (o.status === 'confirmed') emoji = "✅";
                else if (o.status === 'cancelled') emoji = "❌";
                const btn = `${emoji} ${o.customerName || 'Noma\'lum'} — ${(o.totalUZS || 0).toLocaleString("uz-UZ")} so'm`;
                kb.inline_keyboard.push([{ text: btn, callback_data: `order_detail_${doc.id}` }]);
            });
            bot.sendMessage(chatId, "So'nggi 10 ta buyurtma:", { reply_markup: kb });
        } catch (error) {
            bot.sendMessage(chatId, "❌ Xato!", mainKeyboard);
        }
        return;
    }
    bot.sendMessage(chatId, "Tugmalardan tanlang:", mainKeyboard);
}

async function handleProductStep(chatId, currentStep, isBack = false) {
    const state = userState[chatId];
    const data = state.data;
    const oldStep = state.step;
    if (!isBack) state.steps.push(oldStep);
    state.step = currentStep;
    switch (currentStep) {
        case 'product_name': bot.sendMessage(chatId, "1/8. Mahsulot nomini kiriting:", backKeyboard); break;
        case 'product_price': bot.sendMessage(chatId, "2/8. Narxni so'mda kiriting (mas: 250000):", backKeyboard); break;
        case 'product_discount': bot.sendMessage(chatId, "3/8. Chegirma (0-100, mas: 10 yoki 0):", backKeyboard); break;
        case 'product_category':
            const kb = { reply_markup: { keyboard: [...data.categoryNames.map(n => [{ text: n }]), ["Orqaga"]], resize_keyboard: true, one_time_keyboard: true } };
            bot.sendMessage(chatId, "4/8. Kategoriyani tanlang:", kb);
            break;
        case 'product_image': bot.sendMessage(chatId, "5/8. Rasm yuboring (photo formatida):", mainBackKeyboard); break;
        case 'product_description': bot.sendMessage(chatId, "6/8. Tavsifni kiriting:", backKeyboard); break;
        case 'product_stock': bot.sendMessage(chatId, "7/8. Ombordagi miqdor (mas: 50):", backKeyboard); break;
    }
}

async function handleCategoryStep(chatId, currentStep, isBack = false) {
    const state = userState[chatId];
    const oldStep = state.step;
    if (!isBack) state.steps.push(oldStep);
    state.step = currentStep;
    if (currentStep === 'category_name') bot.sendMessage(chatId, "1/2. Kategoriya nomini kiriting:", backKeyboard);
    else if (currentStep === 'category_icon') bot.sendMessage(chatId, "2/2. Ikonka (emoji, mas: 🔧):", backKeyboard);
}

const commandButtons = ["🛍 Mahsulot qo'shish", "📂 Kategoriya qo'shish", "📂 Kategoriya yangilash", "🔄 Mahsulotni yangilash", "👥 Mijoz qo'shish", "👥 Mijozlar ro'yxati", "📊 Statistika", "📦 Buyurtmalar", "❌ Bekor qilish"];

// MESSAGE HANDLER
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const photo = msg.photo;

    if (!admins.includes(chatId)) {
        bot.sendMessage(chatId, `Bu bot faqat administratorlar uchun.\nSizning ID: ${chatId}`);
        return;
    }
    if (!db) { bot.sendMessage(chatId, "❌ Database ulanmagan."); return; }
    if (text && text.startsWith('/')) {
        if (text === '/start') {
            resetUserState(chatId);
            bot.sendMessage(chatId, "Xush kelibsiz! Shop-bot admin paneli.", mainKeyboard);
        } else bot.sendMessage(chatId, "Noma'lum buyruq. /start ni bosing.", mainKeyboard);
        return;
    }
    if (text === "Orqaga") { await handleBack(chatId); return; }
    if (text && commandButtons.includes(text)) { await handleCommand(chatId, text); return; }
    if (photo && !text) return bot.emit('photo', msg);
    if (!userState[chatId] || userState[chatId].step === 'none') {
        bot.sendMessage(chatId, "Tugmalardan tanlang:", mainKeyboard);
        return;
    }

    const state = userState[chatId];
    const step = state.step;
    let data = state.data;

    // MAHSULOT QO'SHISH
    if (step.startsWith('product_')) {
        const oldStep = step;
        switch (step) {
            case 'product_name':
                data.name = text;
                state.steps.push(oldStep);
                state.step = 'product_price';
                bot.sendMessage(chatId, "2/8. Narxni so'mda kiriting (mas: 250000):", backKeyboard);
                break;
            case 'product_price':
                const price = parseNumberInput(text);
                if (price === null || price <= 0) { bot.sendMessage(chatId, "Musbat son kiriting!"); return; }
                data.price = Math.floor(price);
                state.steps.push(oldStep);
                state.step = 'product_discount';
                bot.sendMessage(chatId, "3/8. Chegirma (0-100, mas: 10 yoki 0):", backKeyboard);
                break;
            case 'product_discount':
                if (!/^\d+$/.test(text) || parseInt(text) < 0 || parseInt(text) > 100) {
                    bot.sendMessage(chatId, "0 dan 100 gacha son kiriting!");
                    return;
                }
                data.discount = parseInt(text);
                state.steps.push(oldStep);
                state.step = 'product_category';
                const ckb = { reply_markup: { keyboard: data.categoryNames.map(n => [{ text: n }]).concat([["Orqaga"]]), resize_keyboard: true, one_time_keyboard: true } };
                bot.sendMessage(chatId, "4/8. Kategoriyani tanlang:", ckb);
                break;
            case 'product_category':
                if (!data.categoryNames.includes(text)) { bot.sendMessage(chatId, "Tugmalardan tanlang!"); return; }
                data.category = text;
                state.steps.push(oldStep);
                state.step = 'product_image';
                bot.sendMessage(chatId, "5/8. Rasm yuboring (photo formatida):", mainBackKeyboard);
                break;
            case 'product_image': return;
            case 'product_description':
                data.description = text;
                state.steps.push(oldStep);
                state.step = 'product_stock';
                bot.sendMessage(chatId, "7/8. Ombordagi miqdor (mas: 50):", backKeyboard);
                break;
            case 'product_stock':
                if (!/^\d+$/.test(text) || parseInt(text) < 0) { bot.sendMessage(chatId, "0 yoki musbat son!"); return; }
                data.stock = parseInt(text);

                const newId = await getNextId('products');
                if (newId === -1) { bot.sendMessage(chatId, "❌ ID xato!", mainKeyboard); resetUserState(chatId); return; }
                const newProduct = {
                    id: newId,
                    name: data.name,
                    price: data.price,
                    discount: data.discount || 0,
                    category: data.category,
                    image: data.image,
                    description: data.description,
                    stock: data.stock,
                };
                try {
                    await db.collection('products').doc(String(newId)).set(newProduct);
                    bot.sendMessage(chatId,
                        `✅ Mahsulot qo'shildi!\n\n` +
                        `📦 ${newProduct.name}\n` +
                        `💰 ${newProduct.price.toLocaleString('uz-UZ')} so'm\n` +
                        `🏷 Chegirma: ${newProduct.discount}%\n` +
                        `📂 ${newProduct.category}\n` +
                        `📊 Stock: ${newProduct.stock} ta\n\n` +
                        `Chegirma sanalari qo'shish uchun "Mahsulotni yangilash" → ushbu mahsulot → "Chegirma boshlanishi/tugashi" tugmalarini ishlating.`,
                        mainKeyboard
                    );
                } catch (error) {
                    console.error("Saqlashda xato:", error);
                    bot.sendMessage(chatId, "❌ Saqlashda xato!", mainKeyboard);
                }
                resetUserState(chatId);
                break;
        }
        state.data = data;
        return;
    }

    // KATEGORIYA QO'SHISH
    if (step.startsWith('category_')) {
        const oldStep = step;
        if (step === 'category_name') {
            data.name = text;
            state.steps.push(oldStep);
            state.step = 'category_icon';
            bot.sendMessage(chatId, "2/2. Ikonka (emoji, mas: 🔧):", backKeyboard);
        } else if (step === 'category_icon') {
            data.icon = text;
            const newId = await getNextId('categories');
            if (newId === -1) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); return; }
            try {
                await db.collection('categories').doc(String(newId)).set({ id: newId, name: data.name, icon: data.icon });
                bot.sendMessage(chatId, `✅ Kategoriya qo'shildi!\n${data.icon} ${data.name}`, mainKeyboard);
            } catch (error) {
                bot.sendMessage(chatId, "❌ Xato!", mainKeyboard);
            }
            resetUserState(chatId);
        }
        state.data = data;
        return;
    }

    // KATEGORIYA YANGILASH
    if (state.step === 'update_category_name') {
        try {
            await db.collection('categories').doc(String(state.data.categoryId)).update({ name: text });
            state.step = 'category_update_view';
            await showCategoryView(chatId, state.data.categoryId, state.data.messageId);
            bot.sendMessage(chatId, `✅ Nom yangilandi: ${text}`, backKeyboard);
        } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
        return;
    }
    if (state.step === 'update_category_icon') {
        try {
            await db.collection('categories').doc(String(state.data.categoryId)).update({ icon: text });
            state.step = 'category_update_view';
            await showCategoryView(chatId, state.data.categoryId, state.data.messageId);
            bot.sendMessage(chatId, `✅ Ikonka yangilandi: ${text}`, backKeyboard);
        } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
        return;
    }

    // MAHSULOT YANGILASH - CHEGIRMA SANASI
    if (state.step === 'update_discount_date') {
        const stateData = state.data;
        const dateField = stateData.dateField;
        const dateLabel = stateData.dateLabel;
        if (text === "0") {
            try {
                await db.collection('products').doc(String(stateData.productId)).update({ [dateField]: admin.firestore.FieldValue.delete() });
                state.step = 'product_update_view';
                await showProductView(chatId, stateData.productId, stateData.messageId);
                bot.sendMessage(chatId, `✅ ${dateLabel} o'chirildi.`, backKeyboard);
            } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
            return;
        }
        const dateObj = parseDateDDMMYYYY(text);
        if (!dateObj) { bot.sendMessage(chatId, "❌ Format: DD.MM.YYYY (mas: 13.05.2026)\nO'chirish uchun: 0"); return; }
        try {
            const timestamp = admin.firestore.Timestamp.fromDate(dateObj);
            await db.collection('products').doc(String(stateData.productId)).update({ [dateField]: timestamp });
            state.step = 'product_update_view';
            await showProductView(chatId, stateData.productId, stateData.messageId);
            bot.sendMessage(chatId, `✅ ${dateLabel} yangilandi: ${text}`, backKeyboard);
        } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
        return;
    }

    // MAHSULOT YANGILASH - VALUE
    if (state.step === 'update_value') {
        const stateData = state.data;
        let value;
        const fieldType = stateData.field;
        if (fieldType === 'price') {
            const parsed = parseNumberInput(text);
            if (parsed === null || parsed <= 0) { bot.sendMessage(chatId, "Musbat son kiriting!"); return; }
            value = Math.floor(parsed);
        } else if (fieldType === 'discount') {
            if (!/^\d+$/.test(text) || parseInt(text) < 0 || parseInt(text) > 100) { bot.sendMessage(chatId, "0-100 oralig'ida!"); return; }
            value = parseInt(text);
        } else if (fieldType === 'stock') {
            if (!/^\d+$/.test(text) || parseInt(text) < 0) { bot.sendMessage(chatId, "0 yoki musbat son!"); return; }
            value = parseInt(text);
        } else { bot.sendMessage(chatId, "Xato!"); resetUserState(chatId); return; }
        try {
            await db.collection('products').doc(String(stateData.productId)).update({ [fieldType]: value });
            state.step = 'product_update_view';
            await showProductView(chatId, stateData.productId, stateData.messageId);
            bot.sendMessage(chatId, `✅ Yangilandi: ${value}`, backKeyboard);
        } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
        return;
    }
    if (state.step === 'update_product_description') {
        try {
            await db.collection('products').doc(String(state.data.productId)).update({ description: text });
            state.step = 'product_update_view';
            await showProductView(chatId, state.data.productId, state.data.messageId);
            bot.sendMessage(chatId, `✅ Tavsif yangilandi`, backKeyboard);
        } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
        return;
    }
    if (state.step === 'update_product_name') {
        try {
            await db.collection('products').doc(String(state.data.productId)).update({ name: text });
            state.step = 'product_update_view';
            await showProductView(chatId, state.data.productId, state.data.messageId);
            bot.sendMessage(chatId, `✅ Nom yangilandi: ${text}`, backKeyboard);
        } catch (error) { bot.sendMessage(chatId, "❌ Xato!", mainKeyboard); resetUserState(chatId); }
        return;
    }

    // MIJOZ QO'SHISH BOSQICHLARI
    if (step.startsWith('customer_')) {
        const oldStep = step;
        switch (step) {
            case 'customer_firstName':
                if (!text || text.length < 2) {
                    bot.sendMessage(chatId, "Ism kamida 2 belgi bo'lsin!");
                    return;
                }
                data.firstName = text.trim();
                state.steps.push(oldStep);
                state.step = 'customer_lastName';
                bot.sendMessage(chatId, "2/5. Familiyasini kiriting:", backKeyboard);
                break;

            case 'customer_lastName':
                if (!text || text.length < 2) {
                    bot.sendMessage(chatId, "Familiya kamida 2 belgi bo'lsin!");
                    return;
                }
                data.lastName = text.trim();
                state.steps.push(oldStep);
                state.step = 'customer_phone';
                bot.sendMessage(chatId, "3/5. Telefon raqamini kiriting (mas: +998901234567):", backKeyboard);
                break;

            case 'customer_phone':
                const phoneRegex = /^\+?\d{9,15}$/;
                if (!phoneRegex.test(text.replace(/\s/g, ''))) {
                    bot.sendMessage(chatId, "❌ Telefon noto'g'ri! Format: +998901234567");
                    return;
                }
                data.phone = text.replace(/\s/g, '');
                state.steps.push(oldStep);
                state.step = 'customer_login';
                bot.sendMessage(chatId, "4/5. Login yarating (mas: jonibek_123, faqat lotin harflar/raqamlar/_, kamida 3 belgi):", backKeyboard);
                break;

            case 'customer_login':
                const loginRegex = /^[a-zA-Z0-9_]{3,30}$/;
                if (!loginRegex.test(text)) {
                    bot.sendMessage(chatId, "❌ Login noto'g'ri! Faqat lotin harflar, raqamlar, _. Kamida 3 belgi.");
                    return;
                }
                const login = text.toLowerCase().trim();
                // Tekshirish: bunday login mavjudmi
                const existing = await db.collection('customers').doc(login).get();
                if (existing.exists) {
                    bot.sendMessage(chatId, "❌ Bunday login allaqachon mavjud! Boshqa login tanlang.");
                    return;
                }
                data.login = login;
                state.steps.push(oldStep);
                state.step = 'customer_password';
                bot.sendMessage(chatId, "5/5. Parol yarating (kamida 4 belgi):", backKeyboard);
                break;

            case 'customer_password':
                if (!text || text.length < 4) {
                    bot.sendMessage(chatId, "❌ Parol kamida 4 belgi bo'lsin!");
                    return;
                }
                data.password = text;

                // Mijozni Firebase'ga saqlash
                const newCustomer = {
                    login: data.login,
                    password: data.password,
                    firstName: data.firstName,
                    lastName: data.lastName,
                    phone: data.phone,
                    telegramId: null, // 1-marta saytga kirganida qo'shiladi
                    ordersCount: 0,
                    totalOrders: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };

                try {
                    await db.collection('customers').doc(data.login).set(newCustomer);
                    bot.sendMessage(chatId,
                        `✅ Mijoz qo'shildi!\n\n` +
                        `👤 ${data.firstName} ${data.lastName}\n` +
                        `📞 ${data.phone}\n\n` +
                        `🔑 LOGIN MA'LUMOTLARI (mijozga jo'nating):\n` +
                        `Login: ${data.login}\n` +
                        `Parol: ${data.password}\n\n` +
                        `📲 Mijoz Telegram Mini App orqali shu ma'lumotlar bilan kirsin.`,
                        mainKeyboard
                    );
                } catch (error) {
                    console.error("Mijoz saqlashda xato:", error);
                    bot.sendMessage(chatId, "❌ Mijozni saqlashda xato!", mainKeyboard);
                }
                resetUserState(chatId);
                break;
        }
        state.data = data;
        return;
    }

    bot.sendMessage(chatId, "Tushunmadim. Tugmalardan tanlang:", mainKeyboard);
});

// PHOTO HANDLER
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    if (!admins.includes(chatId)) return;
    if (!db) return;
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const state = userState[chatId];
    if (state && (state.step === 'product_image' || state.step === 'update_product_image')) {
        const waitMsg = await bot.sendMessage(chatId, "Rasm yuklanmoqda... ⏳");
        const imageUrl = await uploadToImgBB(fileId);
        if (imageUrl) {
            state.data.image = imageUrl;
            if (state.step === 'product_image') {
                state.steps.push(state.step);
                state.step = 'product_description';
                bot.editMessageText("✅ Rasm yuklandi!\n6/8. Tavsifni kiriting:", { chat_id: chatId, message_id: waitMsg.message_id });
                bot.sendMessage(chatId, "Tavsif:", backKeyboard);
            } else {
                try {
                    await db.collection('products').doc(String(state.data.productId)).update({ image: imageUrl });
                    state.step = 'product_update_view';
                    await showProductView(chatId, state.data.productId, state.data.messageId);
                    bot.editMessageText("✅ Rasm yangilandi!", { chat_id: chatId, message_id: waitMsg.message_id });
                    bot.sendMessage(chatId, "Davom eting.", backKeyboard);
                } catch (error) {
                    bot.editMessageText("❌ Xato!", { chat_id: chatId, message_id: waitMsg.message_id });
                }
            }
        } else {
            bot.editMessageText("❌ Rasm yuklashda xato!", { chat_id: chatId, message_id: waitMsg.message_id });
        }
    } else {
        bot.sendMessage(chatId, "Rasm kutilmayapti.", mainKeyboard);
    }
});

// CALLBACK QUERY HANDLER
bot.on('callback_query', async (cq) => {
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const data = cq.data;
    if (!data || !admins.includes(chatId)) { bot.answerCallbackQuery(cq.id, { text: "Ruxsat yo'q!" }); return; }
    if (!db) { bot.answerCallbackQuery(cq.id, { text: "Database yo'q." }); return; }

    // ORDER DETAIL
    if (data.startsWith('order_detail_')) {
        const orderId = data.replace('order_detail_', '');
        try {
            const doc = await db.collection('orders').doc(orderId).get();
            if (!doc.exists) { bot.answerCallbackQuery(cq.id, { text: "Topilmadi!" }); return; }
            const o = doc.data();
            let itemsText = o.items?.map(item => `- ${item.quantity} x ${item.name} — ${(item.price * item.quantity).toLocaleString("uz-UZ")} so'm`).join('\n') || "Mahsulot yo'q";
            let bonusText = o.orderType === 'discount' ? `🎁 ${BONUS_DISCOUNT_PERCENT}% chegirma\n` : o.orderType === 'bonus' ? `🎁 1+1 bonus\n` : '';
            let statusEmoji = o.status === 'confirmed' ? "✅" : o.status === 'cancelled' ? "❌" : "🆕";
            let statusText = o.status === 'confirmed' ? "Tasdiqlangan" : o.status === 'cancelled' ? "Bekor qilingan" : "Yangi";
            const msg = `📋 BUYURTMA\n\n🆔 ${orderId}\n👤 ${o.customerName}\n📞 ${o.customerPhone}\n${bonusText}\n🛍 Mahsulotlar:\n${itemsText}\n\n💰 Jami: ${(o.totalUZS || 0).toLocaleString("uz-UZ")} so'm\n📊 Status: ${statusEmoji} ${statusText}`;
            const kb = { inline_keyboard: [] };
            if (o.status === 'new') kb.inline_keyboard.push([{ text: "✅ Tasdiqlash", callback_data: `confirm_order_${orderId}` }, { text: "❌ Bekor", callback_data: `cancel_order_${orderId}` }]);
            kb.inline_keyboard.push([{ text: "⬅️ Orqaga", callback_data: "back_to_orders" }]);
            bot.editMessageText(msg, { chat_id: chatId, message_id: messageId, reply_markup: kb });
            bot.answerCallbackQuery(cq.id);
        } catch (error) { bot.answerCallbackQuery(cq.id, { text: "Xato!" }); }
        return;
    }

    if (data === 'back_to_orders') {
        try {
            const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').limit(10).get();
            if (snapshot.empty) { bot.editMessageText("Buyurtmalar yo'q.", { chat_id: chatId, message_id: messageId }); bot.answerCallbackQuery(cq.id); return; }
            const kb = { inline_keyboard: [] };
            snapshot.docs.forEach(d => {
                const o = d.data();
                const emoji = o.status === 'confirmed' ? "✅" : o.status === 'cancelled' ? "❌" : "🆕";
                kb.inline_keyboard.push([{ text: `${emoji} ${o.customerName || 'Noma\'lum'} — ${(o.totalUZS || 0).toLocaleString("uz-UZ")} so'm`, callback_data: `order_detail_${d.id}` }]);
            });
            bot.editMessageText("So'nggi 10 ta buyurtma:", { chat_id: chatId, message_id: messageId, reply_markup: kb });
            bot.answerCallbackQuery(cq.id);
        } catch (error) { bot.answerCallbackQuery(cq.id, { text: "Xato!" }); }
        return;
    }

    // CONFIRM / CANCEL ORDER + BONUS COUNTER
    if (data.startsWith('confirm_order_') || data.startsWith('cancel_order_')) {
        const isConfirm = data.startsWith('confirm_order_');
        const orderId = isConfirm ? data.replace('confirm_order_', '') : data.replace('cancel_order_', '');
        try {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await orderRef.get();
            if (!doc.exists) { bot.answerCallbackQuery(cq.id, { text: "Topilmadi!" }); return; }
            const orderData = doc.data();
            if (orderData.status !== 'new') { bot.answerCallbackQuery(cq.id, { text: `Allaqachon ${orderData.status}!` }); return; }

            const newStatus = isConfirm ? 'confirmed' : 'cancelled';
            await orderRef.update({ status: newStatus });

            // BONUS COUNTER — faqat tasdiqlangan buyurtmalarda
            if (isConfirm && orderData.customerTelegramId) {
                const customerRef = db.collection('customers').doc(String(orderData.customerTelegramId));
                const customerDoc = await customerRef.get();
                if (customerDoc.exists) {
                    const c = customerDoc.data();
                    const currentCount = c.ordersCount || 0;
                    const newCount = currentCount >= 2 ? 0 : currentCount + 1;
                    await customerRef.update({
                        ordersCount: newCount,
                        totalOrders: (c.totalOrders || 0) + 1,
                    });
                    console.log(`✅ Mijoz ${orderData.customerTelegramId}: ordersCount ${currentCount} → ${newCount}`);
                }
            }

            const adminName = cq.from.first_name || "Admin";
            const statusText = isConfirm ? `✅ Tasdiqlandi — ${adminName}` : `❌ Bekor qilindi — ${adminName}`;
            bot.editMessageText(`${cq.message.text}\n\n=================\n${statusText}`, { chat_id: chatId, message_id: messageId });
            bot.answerCallbackQuery(cq.id, { text: isConfirm ? "Tasdiqlandi" : "Bekor qilindi" });
            admins.forEach(aId => {
                if (aId !== chatId) bot.sendMessage(aId, `Buyurtma ${orderId} ${isConfirm ? 'tasdiqlandi' : 'bekor'} → ${adminName}`);
            });
        } catch (error) {
            console.error("Buyurtma xato:", error);
            bot.answerCallbackQuery(cq.id, { text: "Xato!" });
        }
        return;
    }

    if (data === 'back_to_prev') { await handleInlineBack(chatId, messageId); bot.answerCallbackQuery(cq.id); return; }

    if (data.startsWith('cat_select_')) {
        const id = parseInt(data.replace('cat_select_', ''));
        const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
        state.steps.push(state.step);
        state.step = 'category_update_view';
        state.data.categoryId = id;
        state.data.messageId = messageId;
        userState[chatId] = state;
        await showCategoryView(chatId, id, messageId);
        bot.answerCallbackQuery(cq.id);
        return;
    }
    if (data.startsWith('cat_update_name_')) {
        const id = parseInt(data.replace('cat_update_name_', ''));
        const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
        userState[chatId] = { step: 'update_category_name', data: { categoryId: id, messageId }, steps: state.steps || [] };
        bot.sendMessage(chatId, 'Yangi nomni kiriting:', backKeyboard);
        bot.answerCallbackQuery(cq.id);
        return;
    }
    if (data.startsWith('cat_update_icon_')) {
        const id = parseInt(data.replace('cat_update_icon_', ''));
        const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
        userState[chatId] = { step: 'update_category_icon', data: { categoryId: id, messageId }, steps: state.steps || [] };
        bot.sendMessage(chatId, 'Yangi ikonkani kiriting:', backKeyboard);
        bot.answerCallbackQuery(cq.id);
        return;
    }
    if (data.startsWith('delete_category_')) {
        const id = parseInt(data.replace('delete_category_', ''));
        try {
            const doc = await db.collection('categories').doc(String(id)).get();
            if (!doc.exists) { bot.answerCallbackQuery(cq.id, { text: "Topilmadi!" }); return; }
            const cat = doc.data();
            const count = await getProductsInCategory(cat.name);
            if (count === 0) {
                await db.collection('categories').doc(String(id)).delete();
                bot.editMessageText(`✅ "${cat.name}" o'chirildi.`, { chat_id: chatId, message_id: messageId });
            } else {
                bot.editMessageText(`⚠️ "${cat.name}" ichida ${count} ta mahsulot bor. Avval ularni boshqa kategoriyaga o'tkazing yoki o'chiring.`, { chat_id: chatId, message_id: messageId });
            }
            bot.answerCallbackQuery(cq.id);
        } catch (error) { bot.answerCallbackQuery(cq.id, { text: "Xato!" }); }
        return;
    }

    if (data.startsWith('select_category_')) {
        const id = parseInt(data.replace('select_category_', ''));
        try {
            const doc = await db.collection('categories').doc(String(id)).get();
            if (!doc.exists) { bot.answerCallbackQuery(cq.id, { text: "Topilmadi!" }); return; }
            const cat = doc.data();
            const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
            state.steps.push(state.step);
            state.step = 'product_update_product_select';
            state.data.selectedCategory = cat.name;
            state.data.messageId = messageId;
            userState[chatId] = state;
            await showProductsInCategory(chatId, cat.name, messageId);
            bot.answerCallbackQuery(cq.id);
        } catch (error) { bot.answerCallbackQuery(cq.id, { text: "Xato!" }); }
        return;
    }

    if (data.startsWith('update_product_')) {
        const id = parseInt(data.replace('update_product_', ''));
        try {
            const doc = await db.collection('products').doc(String(id)).get();
            if (!doc.exists) { bot.answerCallbackQuery(cq.id, { text: "Topilmadi!" }); return; }
            const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
            state.steps.push(state.step);
            state.step = 'product_update_view';
            state.data.productId = id;
            state.data.messageId = messageId;
            userState[chatId] = state;
            await showProductView(chatId, id, messageId);
            bot.answerCallbackQuery(cq.id);
        } catch (error) { bot.answerCallbackQuery(cq.id, { text: "Xato!" }); }
        return;
    }

    // UPDATE FIELD
    if (data.startsWith('update_field_')) {
        // Chegirma sanalari maxsus
        if (data.startsWith('update_field_discountStart_') || data.startsWith('update_field_discountEnd_')) {
            const isStart = data.startsWith('update_field_discountStart_');
            const id = parseInt(isStart ? data.replace('update_field_discountStart_', '') : data.replace('update_field_discountEnd_', ''));
            const fieldName = isStart ? 'discountStartDate' : 'discountEndDate';
            const fieldLabel = isStart ? 'Chegirma boshlanish sanasi' : 'Chegirma tugash sanasi';
            const cur = userState[chatId] || { step: 'none', data: {}, steps: [] };
            userState[chatId] = {
                step: 'update_discount_date',
                data: { productId: id, dateField: fieldName, dateLabel: fieldLabel, selectedCategory: cur.data.selectedCategory, messageId },
                steps: cur.steps || []
            };
            bot.sendMessage(chatId, `${fieldLabel}ni kiriting:\nFormat: DD.MM.YYYY (mas: 13.05.2026)\nO'chirish uchun: 0`, backKeyboard);
            bot.answerCallbackQuery(cq.id);
            return;
        }
        const parts = data.split('_');
        const fieldType = parts[2];
        const id = parseInt(parts[3]);
        const cur = userState[chatId] || { step: 'none', data: {}, steps: [] };
        const preserve = { selectedCategory: cur.data.selectedCategory, messageId };
        if (fieldType === 'name') {
            userState[chatId] = { step: 'update_product_name', data: { productId: id, ...preserve }, steps: cur.steps || [] };
            bot.sendMessage(chatId, 'Yangi nomni kiriting:', backKeyboard);
        } else if (fieldType === 'description') {
            userState[chatId] = { step: 'update_product_description', data: { productId: id, ...preserve }, steps: cur.steps || [] };
            bot.sendMessage(chatId, 'Yangi tavsifni kiriting:', backKeyboard);
        } else if (fieldType === 'image') {
            userState[chatId] = { step: 'update_product_image', data: { productId: id, ...preserve }, steps: cur.steps || [] };
            bot.sendMessage(chatId, 'Yangi rasm yuboring:', mainBackKeyboard);
        } else {
            userState[chatId] = { step: 'update_value', data: { productId: id, field: fieldType, ...preserve }, steps: cur.steps || [] };
            const labelMap = { price: 'Narx (so\'m)', discount: 'Chegirma (%)', stock: 'Stock' };
            bot.sendMessage(chatId, `${labelMap[fieldType] || fieldType} uchun yangi qiymatni yuboring:`, backKeyboard);
        }
        bot.answerCallbackQuery(cq.id);
        return;
    }

    if (data.startsWith('delete_product_')) {
        const id = parseInt(data.replace('delete_product_', ''));
        try {
            const doc = await db.collection('products').doc(String(id)).get();
            if (!doc.exists) { bot.answerCallbackQuery(cq.id, { text: "Topilmadi!" }); return; }
            const p = doc.data();
            await db.collection('products').doc(String(id)).delete();
            bot.editMessageText(`✅ "${p.name}" o'chirildi.`, { chat_id: chatId, message_id: messageId });
            bot.answerCallbackQuery(cq.id);
        } catch (error) { bot.answerCallbackQuery(cq.id, { text: "Xato!" }); }
        return;
    }
});

// =====================================================
// USER BOT — Foydalanuvchilar uchun (@sako_m10_bot)
// Faqat /start ga javob berib, Mini App ochish tugmasini yuboradi
// =====================================================
if (USER_BOT_TOKEN) {
    const userBot = new TelegramBot(USER_BOT_TOKEN, { polling: true });
    console.log("✅ User bot ishga tushdi...");
    
    userBot.on('polling_error', (error) => {
        console.error("User bot polling xatosi:", error.message);
    });
    
    userBot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const firstName = msg.from.first_name || 'mijoz';
        
        const welcomeMessage = 
            `Salom, ${firstName}! 👋\n\n` +
            `🚗 *Nanokill* botiga xush kelibsiz!\n\n` +
            `Sifatli avtomobil ehtiyot qismlari va tezkor yetkazib berish.\n\n` +
            `Do'kondan foydalanish uchun pastdagi tugmani bosing 👇`;
        
        const inlineKeyboard = {
            inline_keyboard: [[
                { 
                    text: "🛍 Ilovani ochish", 
                    web_app: { url: MINI_APP_URL }
                }
            ]]
        };
        
        userBot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard
        }).catch(err => {
            console.error("User botga xabar yuborishda xato:", err.message);
        });
    });
} else {
    console.warn("⚠️ USER_BOT_TOKEN topilmadi — user bot ishlamaydi.");
}

console.log("Bot ishga tushdi va polling boshlandi...");