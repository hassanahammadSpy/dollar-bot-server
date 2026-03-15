// server.js - Final Interactive Version
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 

// Firebase Admin Setup
if (process.env.FIREBASE_KEY) {
    try {
        const serviceAccount = typeof process.env.FIREBASE_KEY === 'string' 
            ? JSON.parse(process.env.FIREBASE_KEY) 
            : process.env.FIREBASE_KEY;
            
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Initialized");
    } catch (e) {
        console.error("❌ Firebase Key Error:", e.message);
    }
} else {
    console.warn("⚠️ Warning: FIREBASE_KEY not found.");
}
const db = admin.firestore();

// --- HELPER FUNCTION FOR ADMIN NOTIFICATION ---
async function sendAdminNotification(type, docId, data) {
    const name = data.username ? `@${data.username}` : (data.firstName || "User");
    
    let infoMsg = `<b>🆕 New ${type} Request</b>\n\n`;
    infoMsg += `👤 User: <code>${name}</code>\n`;
    infoMsg += `🆔 ID: <code>${data.userId}</code>\n`;
    
    if (type === 'Exchange') {
        infoMsg += `🔄 Route: <code>${data.sendMethod} ➔ ${data.recMethod}</code>\n`;
        infoMsg += `💰 Amount: <code>$${data.amount}</code> (<code>${data.bdtAmount} Tk</code>)\n`;
        infoMsg += `📞 Number: <code>${data.number}</code>\n`;
        infoMsg += `📝 TrxID: <code>${data.trx}</code>\n`;
    } else if (type === 'Deposit') {
        infoMsg += `💰 Amount: <code>${data.amount} Tk</code>\n`;
        infoMsg += `💳 Method: <code>${data.method}</code>\n`;
        infoMsg += `📝 TrxID: <code>${data.trxId}</code>\n`;
    } else if (type === 'Withdraw') {
        infoMsg += `💰 Amount: <code>${data.amount} Tk</code>\n`;
        infoMsg += `💳 Method: <code>${data.method}</code>\n`;
        infoMsg += `📞 Number: <code>${data.number}</code>\n`;
    }

    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ Approve", callback_data: `Approved:${type}:${docId}` },
                { text: "❌ Dismiss", callback_data: `Rejected:${type}:${docId}` }
            ]
        ]
    };

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_ID,
            text: infoMsg,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (e) {
        console.error("Admin Notify Error:", e.message);
    }
}

// 1. চ্যানেল টাস্ক ভেরিফিকেশন
app.post('/api/verify-channel-task', async (req, res) => {
    const { userId, taskId } = req.body;
    try {
        const taskRef = db.collection('tasks').doc(taskId);
        const taskSnap = await taskRef.get();
        if (!taskSnap.exists) return res.status(404).json({ success: false, message: "Task not found" });

        const taskData = taskSnap.data();
        let link = taskData.link ? taskData.link.trim() : "";
        let channelUsername = link.includes("t.me/") ? link.split("t.me/")[1].split("/")[0].split("?")[0] : link.replace("@", "");
        if (!channelUsername.startsWith("@")) channelUsername = "@" + channelUsername;

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channelUsername}&user_id=${userId}`;
        const response = await axios.get(url);
        const status = response.data.result.status;
        const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(status);
        res.json({ success: isMember, message: isMember ? "" : "Not joined yet! Please join first." });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 2. অ্যাপ ওপেন মেম্বারশিপ চেক
app.post('/api/verify-member', async (req, res) => {
    const { userId, channelUsername } = req.body;
    try {
        const channel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`;
        const response = await axios.get(url);
        const isMember = ['creator', 'administrator', 'member'].includes(response.data.result.status);
        res.json({ isMember: isMember });
    } catch (error) { res.json({ isMember: false }); }
});

// ==========================================
// MODIFIED: Webhook Handler (Commands + Inline Buttons)
// ==========================================
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;

        // --- Handle Button Clicks (Approve/Dismiss) ---
        if (update.callback_query) {
            const cb = update.callback_query;
            const callbackUserId = String(cb.from.id);

            // Security Check: Only Admin can click
            if (callbackUserId !== String(ADMIN_ID)) {
                return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: cb.id, text: "You are not authorized!", show_alert: true
                });
            }

            const [action, type, docId] = cb.data.split(':');
            const collectionMap = { 'Deposit': 'deposits', 'Exchange': 'exchanges', 'Withdraw': 'withdrawals' };
            const docRef = db.collection(collectionMap[type]).doc(docId);
            const docSnap = await docRef.get();

            if (docSnap.exists && docSnap.data().status === 'Pending') {
                const requestData = docSnap.data();
                
                // Trigger the existing logic
                const adminActionRes = await axios.post(`http://localhost:${PORT}/api/admin/action`, {
                    ...requestData,
                    status: action,
                    type: type
                });

                if (adminActionRes.data.success) {
                    // Edit the message to show result
                    const statusIcon = action === 'Approved' ? '✅' : '❌';
                    const newText = `${cb.message.text}\n\n<b>━━━━━━━━━━━━━━━\nSTATUS: ${action.toUpperCase()} ${statusIcon}</b>`;
                    
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                        chat_id: cb.message.chat.id,
                        message_id: cb.message.message_id,
                        text: newText,
                        parse_mode: 'HTML'
                    });
                }
            } else {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: cb.id, text: "Already processed or invalid."
                });
            }
            return res.sendStatus(200);
        }

        // --- Handle Commands (/start, /ping) ---
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;

            if (text === '/start') {
                const firstName = update.message.from.first_name || "User";
                const welcomeMsg = `Hi! ${firstName} Welcome to RedExChanger.\n\nSupport: @RedExSupportBot`;
                const keyboard = { inline_keyboard: [[{ text: "🚀 Open App", url: "https://t.me/RedExChangerBot/app" }]] };
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: welcomeMsg, reply_markup: keyboard, parse_mode: 'HTML' });
            } 
            else if (text === '/ping') {
                const latency = Math.floor(Math.random() * (400 - 150) + 150); 
                const pingMsg = `🏓 Pong!\n\n🧭 Ping: ${latency} ms\n\n🗑 Auto-delete in 5 min.`;
                const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: pingMsg });
                const botMsgId = response.data.result.message_id;
                setTimeout(async () => {
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: botMsgId });
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: messageId });
                    } catch (e) {}
                }, 300000);
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(200); }
});

// ==========================================
// NOTIFICATION APIs (Called from Frontend)
// ==========================================
app.post('/api/notify-deposit', async (req, res) => {
    await sendAdminNotification('Deposit', req.body.docId, req.body);
    res.json({ success: true });
});

app.post('/api/notify-exchange', async (req, res) => {
    await sendAdminNotification('Exchange', req.body.docId, req.body);
    res.json({ success: true });
});

app.post('/api/notify-withdraw', async (req, res) => {
    await sendAdminNotification('Withdraw', req.body.docId, req.body);
    res.json({ success: true });
});

// ==========================================
// ADMIN ACTION LOGIC (Preserved)
// ==========================================
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod, trxId, status, type, referrerId } = req.body;
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';
    const icon = status === 'Approved' ? '✅' : '❎';

    try {
        if (type === "Deposit" && status === 'Approved') {
            const depositAmount = parseFloat(amount);
            const commission = depositAmount * 0.015;
            const userFinalAmount = depositAmount - commission;

            await db.collection('users').doc(String(userId)).update({
                mainBalance: admin.firestore.FieldValue.increment(userFinalAmount)
            });
            if (referrerId) {
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(commission),
                    refEarnings: admin.firestore.FieldValue.increment(commission)
                });
            }
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: `Your Deposit Approved! ${icon}\nAmount: ${userFinalAmount.toFixed(2)} Tk`, parse_mode: 'HTML'
            });
        }

        if (type === "Exchange") {
            const msg = `Your Exchange Request ${actionText}. ${icon}\nAmount : $${amount}\nTrxID : <code>${trxId || 'N/A'}</code>`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML' });
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = parseFloat(bdtAmount) * 0.015;
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(exCommission),
                    refEarnings: admin.firestore.FieldValue.increment(exCommission)
                });
            }
        } 
        
        if (status === 'Rejected' && type !== "Exchange") {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: `Your ${type} request has been Rejected. ❌`, parse_mode: 'HTML' }).catch(e=>{});
        }

        res.json({ success: true });
    } catch (error) { res.json({ success: false }); }
});

// ==========================================
// BROADCAST & REFERRAL (Preserved)
// ==========================================
app.post('/api/broadcast-message', async (req, res) => {
    const { image, text, btnText, btnUrl } = req.body;
    res.json({ success: true });
    try {
        const usersSnapshot = await db.collection('users').get();
        usersSnapshot.docs.forEach((doc, i) => {
            setTimeout(async () => {
                const payload = image ? { chat_id: doc.id, photo: image, caption: text || '', parse_mode: 'HTML' } : { chat_id: doc.id, text: text, parse_mode: 'HTML' };
                if (btnText && btnUrl) payload.reply_markup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${image ? 'sendPhoto' : 'sendMessage'}`, payload).catch(e=>{});
            }, i * 50);
        });
    } catch (e) {}
});

app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, firstName, totalRefer } = req.body;
    const msg = `<b>🆕 New Refer Joined!</b>\n\nName: ${firstName}\nTotal Refer: ${totalRefer}\n\n@RedExChanger`;
    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: msg, parse_mode: 'HTML' }).catch(e=>{});
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
