// server.js - Final Fixed Version with Admin Notifications and Faster Broadcast
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
const ADMIN_ID = process.env.ADMIN_ID || '7767338426'; 

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

// 1. চ্যানেল টাস্ক ভেরিফিকেশন (No changes needed)
app.post('/api/verify-channel-task', async (req, res) => {
    const { userId, taskId } = req.body;
    try {
        const taskRef = db.collection('tasks').doc(taskId);
        const taskSnap = await taskRef.get();
        if (!taskSnap.exists) { return res.status(404).json({ success: false, message: "Task not found" }); }
        const taskData = taskSnap.data();
        let link = taskData.link ? taskData.link.trim() : "";
        let channelUsername = "";
        if (link.includes("t.me/")) { channelUsername = link.split("t.me/")[1].split("/")[0].split("?")[0]; } 
        else if (link.startsWith("@")) { channelUsername = link.replace("@", ""); } 
        else { channelUsername = link; }
        if (!channelUsername.startsWith("@")) { channelUsername = "@" + channelUsername; }
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channelUsername}&user_id=${userId}`;
        const response = await axios.get(url);
        const status = response.data.result.status;
        const isMember =['creator', 'administrator', 'member', 'restricted'].includes(status);
        if (isMember) { res.json({ success: true }); } 
        else { res.json({ success: false, message: "Not joined yet! Please join first." }); }
    } catch (error) {
        if (error.response && error.response.data.description.includes("chat not found")) { return res.json({ success: false, message: "Bot not Admin or Invalid Link" }); }
        res.status(500).json({ success: false, message: "Server Error or Bot is not Admin" });
    }
});

// 2. অ্যাপ ওপেন মেম্বারশিপ চেক (No changes needed)
app.post('/api/verify-member', async (req, res) => {
    const { userId, channelUsername } = req.body;
    try {
        const channel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`;
        const response = await axios.get(url);
        const status = response.data.result.status;
        const isMember =['creator', 'administrator', 'member'].includes(status);
        res.json({ isMember: isMember });
    } catch (error) {
        res.json({ isMember: false });
    }
});

// Helper function to process admin actions from bot
async function processAdminAction(reqId, newStatus, adminName) {
    try {
        const reqRef = db.collection('requests').doc(reqId);
        const reqSnap = await reqRef.get();
        if (!reqSnap.exists) { return { success: false, message: "Request not found." }; }
        const r = reqSnap.data();
        if (r.status !== 'Pending') { return { success: false, message: `Request already ${r.status}.` }; }
        await reqRef.update({ status: newStatus });
        if (r.type === "Withdraw" && newStatus === "Rejected") { await db.collection('users').doc(r.userId).update({ mainBalance: admin.firestore.FieldValue.increment(r.amount) }); }
        await axios.post(`https://dollar-bot-server.onrender.com/api/admin/action`, { ...r, status: newStatus });
        return { success: true };
    } catch (error) {
        console.error("Error processing admin action:", error);
        return { success: false, message: "Server error during action." };
    }
}

// Webhook Handler (/start, /ping, and callback_query)
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            if (text === '/start') {
                const firstName = update.message.from.first_name || "User";
                const welcomeMsg = `Hi! ${firstName} Welcome to RedExChanger.\n\nHere you can exchange your small dollar amounts and receive payment via BKash / Nagad. You can also earn money by completing tasks.\n\nPlus, you’ll get commission by referring others. So don’t waste any time — start earning now!\n\nSupport: @RedExSupportBot`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "🚀 Open App", web_app: { url: "https://t.me/RedExChangerBot/app" } }],
                        [{ text: "📢 Join Channel", url: "https://t.me/RedExChanger" }, { text: "👥 Join Group", url: "https://t.me/RedExChangerGroup" }]
                    ]
                };
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: welcomeMsg, reply_markup: keyboard, parse_mode: 'HTML' });
            }
        } else if (update.callback_query) {
            const cbq = update.callback_query;
            const data = cbq.data;
            const adminUser = cbq.from;
            const message = cbq.message;
            if (data.startsWith('act_')) {
                const [_, reqId, status] = data.split('_');
                const adminName = adminUser.first_name || "Admin";
                const result = await processAdminAction(reqId, status, adminName);
                if (result.success) {
                    const newText = message.text + `\n\n<b>Status: ${status} by ${adminName}</b>`;
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, { chat_id: message.chat.id, message_id: message.message_id, text: newText, parse_mode: 'HTML', reply_markup: {} });
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cbq.id, text: `Request ${status}!` });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cbq.id, text: result.message, show_alert: true });
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.sendStatus(200);
    }
});


// ==========================================
// MODIFIED: Broadcast APIs (Faster & More Reliable)
// ==========================================
app.post('/api/broadcast-message', async (req, res) => {
    const { image, text, buttons } = req.body;
    res.json({ success: true, message: "Broadcasting message started..." });

    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);
        
        let reply_markup = {};
        if (buttons && Array.isArray(buttons) && buttons.length > 0) {
            // This creates a new row for each button.
            reply_markup = { inline_keyboard: buttons.map(btn => [{ text: btn.text, url: btn.url }]) };
        }

        // Batch sending logic
        const CHUNK_SIZE = 25; // Send to 25 users at a time
        const DELAY = 1000;    // Wait 1 second between batches

        for (let i = 0; i < users.length; i += CHUNK_SIZE) {
            const chunk = users.slice(i, i + CHUNK_SIZE);
            const promises = chunk.map(userId => {
                const payload = image ? 
                    { chat_id: userId, photo: image, caption: text || '', parse_mode: 'HTML', reply_markup } :
                    { chat_id: userId, text: text, parse_mode: 'HTML', reply_markup };
                
                const url = image ? 
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto` :
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

                return axios.post(url, payload).catch(err => {
                    // Log errors for blocked users, etc., but don't stop the broadcast
                    console.log(`Failed to send to ${userId}: ${err.response?.data?.description || err.message}`);
                });
            });
            
            await Promise.all(promises); // Wait for the current batch to finish
            await new Promise(resolve => setTimeout(resolve, DELAY)); // Wait before sending the next batch
        }
    } catch (error) { 
        console.error("Broadcast Msg Error:", error.message); 
    }
});


app.post('/api/broadcast-task', async (req, res) => {
    const { caption, target, reward, image, usdRate = 120 } = req.body; 
    const dollarReward = (parseFloat(reward) / usdRate).toFixed(3);
    const msg = `<b>🆕 New Task Available!</b>\n\n📋 Task: ${caption}\n👥 Slots: ${target}\n💰 Reward: ${reward}৳ = ${dollarReward}$\n\nComplete the task to earn rewards!\n\n@RedExChanger`;
    const keyboard = { inline_keyboard: [[{ text: "Open App", url: "https://t.me/RedExChangerBot/app" }]] };
    res.json({ success: true, message: "Broadcasting started..." });

    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);

        const CHUNK_SIZE = 25;
        const DELAY = 1000;

        for (let i = 0; i < users.length; i += CHUNK_SIZE) {
            const chunk = users.slice(i, i + CHUNK_SIZE);
            const promises = chunk.map(userId => {
                 const payload = image ? 
                    { chat_id: userId, photo: image, caption: msg, parse_mode: 'HTML', reply_markup: keyboard } :
                    { chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard };

                const url = image ?
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto` :
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
                
                return axios.post(url, payload).catch(err => {});
            });
            await Promise.all(promises);
            await new Promise(resolve => setTimeout(resolve, DELAY));
        }
    } catch (error) { console.error("Broadcast Error:", error.message); }
});

// Admin Actions (Approve/Reject) from Admin Panel
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod = 'N/A', trxId = 'N/A', status, type, referrerId } = req.body;
    const icon = status === 'Approved' ? '✅' : '❎';
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';

    if (type === "Deposit" && status === 'Approved') {
        const depositAmount = parseFloat(amount);
        const commission = depositAmount * 0.015;
        const userFinalAmount = depositAmount - commission;
        try {
            await db.collection('users').doc(String(userId)).update({ mainBalance: admin.firestore.FieldValue.increment(userFinalAmount) });
            if (referrerId) {
                await db.collection('users').doc(String(referrerId)).update({ mainBalance: admin.firestore.FieldValue.increment(commission), refEarnings: admin.firestore.FieldValue.increment(commission) });
                const refMsg = `New Deposit Commission Added 💰\nUser: @${userName}\nAmount: ${commission.toFixed(2)} ৳\n<blockquote>(1.5% from Deposit)</blockquote>`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: refMsg, parse_mode: 'HTML' }).catch(e => {});
            }
            const userMsg = `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (1.5%): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedExChanger`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: userMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: "https://t.me/RedExChangerBot/app" }]] } });
            return res.json({ success: true });
        } catch (error) { return res.json({ success: false }); }
    }

    if (type === "Exchange") {
        const msg = `Your Exchange Request ${actionText}. ${icon}\n\nUsername : @${userName}\nAmount : $${amount}\nTo : ${receiveMethod}\nTrxID : <code>${trxId}</code>\n\n@RedExChanger`;
        const keyboard = { inline_keyboard: [[{ text: "CHECK HISTORY 📝", url: "https://t.me/RedExChangerBot/app" }]] };
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                await db.collection('users').doc(String(referrerId)).update({ mainBalance: admin.firestore.FieldValue.increment(parseFloat(exCommission)), refEarnings: admin.firestore.FieldValue.increment(parseFloat(exCommission)) });
            }
            res.json({ success: true });
        } catch (error) { res.json({ success: false }); }
    } else {
        if (status === 'Rejected') {
             await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: `Your ${type} request has been Rejected. ❌`, parse_mode: 'HTML' }).catch(e=>{});
        }
        res.json({ success: true });
    }
});

// Admin Notifications with action buttons
app.post('/api/notify-deposit', async (req, res) => {
    const { requestId, username, userId, amount, method, number, trx } = req.body;
    const adminMsg = `<b>💰 New Deposit Request</b>\n\nUser: @${username || 'N/A'}\nUser ID: <code>${userId}</code>\nAmount: ${amount} Tk\nMethod: ${method}\nSender Num: <code>${number}</code>\nTrxID: <code>${trx}</code>`;
    const keyboard = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `act_${requestId}_Approved` }, { text: "❌ Reject", callback_data: `act_${requestId}_Rejected` }]] };
    await sendMessageToTelegram(ADMIN_ID, adminMsg, keyboard);
    res.json({ success: true });
});

app.post('/api/notify-withdraw', async (req, res) => {
    const { requestId, username, userId, amount, method, number } = req.body;
    const adminMsg = `<b>📤 New Withdraw Request</b>\n\nUser: @${username || 'N/A'}\nUser ID: <code>${userId || 'N/A'}</code>\nAmount: ${amount} Tk\nMethod: ${method}\nReceiver Num: <code>${number}</code>`;
    const keyboard = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `act_${requestId}_Approved` }, { text: "❌ Reject", callback_data: `act_${requestId}_Rejected` }]] };             
    await sendMessageToTelegram(ADMIN_ID, adminMsg, keyboard);
    res.json({ success: true });
});

app.post('/api/notify-exchange', async (req, res) => {
    const { requestId, username, userId, sendMethod, recMethod, number, trx, amount, bdtAmount } = req.body;
    const adminMsg = `<b>🔄 New Exchange Request</b>\n\nUser: @${username || 'N/A'}\nUser ID: <code>${userId}</code>\nExchange: ${sendMethod} ➔ ${recMethod}\nAmount: $${amount} (${bdtAmount} Tk)\nPayment Num: <code>${number}</code>\nTrxID: <code>${trx}</code>`;
    const keyboard = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `act_${requestId}_Approved` }, { text: "❌ Reject", callback_data: `act_${requestId}_Rejected` }]] };                 
    await sendMessageToTelegram(ADMIN_ID, adminMsg, keyboard);
    res.json({ success: true });
});

app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName, firstName } = req.body;
    if (!referrerId) return res.json({ success: false });
    const rawName = firstName || newUserName || "User";
    const safeName = String(rawName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const msg = `<b>🆕 New Refer Joined!</b>\n\nName: ${safeName}\n\n<i>You will receive a 1.5% commission when the person you refer makes a deposit or exchange.</i>`;
    const keyboard = { inline_keyboard: [[{ text: "Open App", url: "https://t.me/RedExChangerBot/app" }]] };
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
        res.json({ success: true });
    } catch (error) { res.json({ success: false }); }
});

async function sendMessageToTelegram(chatId, text, reply_markup = {}) {
    try { 
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: text, parse_mode: 'HTML', reply_markup: reply_markup }); 
    } catch (e) { console.error("Admin Notify Error:", e.response?.data || e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });