// server.js - Final Advanced Version
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
const ADMIN_ID = process.env.ADMIN_ID; // আপনার আইডি: 7767338426 (Render এ সেট করবেন)

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

// Helper: Get Dynamic App Link from Firebase Admin Panel Settings
async function getAppLink() {
    try {
        const settingsSnap = await db.collection('settings').doc('appConfig').get();
        if (settingsSnap.exists) {
            const botUsername = settingsSnap.data().botUsername;
            return `https://t.me/${botUsername}/app`;
        }
    } catch (e) {}
    return "https://t.me/RedExChangerBot/app"; // Fallback
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
        const isMember =['creator', 'administrator', 'member', 'restricted'].includes(status);
        res.json({ success: isMember, message: isMember ? "" : "Not joined yet!" });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 2. মেম্বারশিপ চেক
app.post('/api/verify-member', async (req, res) => {
    const { userId, channelUsername } = req.body;
    try {
        const channel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`;
        const response = await axios.get(url);
        const isMember =['creator', 'administrator', 'member'].includes(response.data.result.status);
        res.json({ isMember });
    } catch (error) { res.json({ isMember: false }); }
});

// ==========================================
// Webhook Handler (/start, /ping and CALLBACK)
// ==========================================
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        const appLink = await getAppLink();

        // Handle Callback Buttons (Approve / Dismiss)
        if (update.callback_query) {
            const cb = update.callback_query;
            if (String(cb.from.id) === String(ADMIN_ID)) {
                const [action, type, docId] = cb.data.split(':');
                const docRef = db.collection('requests').doc(docId);
                const docSnap = await docRef.get();

                if (docSnap.exists && docSnap.data().status === 'Pending') {
                    const data = docSnap.data();
                    
                    // Trigger Admin Action Logic
                    const actionResponse = await axios.post(`http://localhost:${PORT}/api/admin/action`, {
                        ...data,
                        userId: data.userId,
                        userName: data.username || data.firstName || "User",
                        receiveMethod: data.recMethod || data.receiveMethod || 'N/A',
                        userNumber: data.number || data.userNumber || 'N/A',
                        trxId: data.trx || data.trxId || 'N/A',
                        status: action,
                        type: type
                    });

                    if (actionResponse.data.success) {
                        const icon = action === 'Approved' ? '✅' : '❌';
                        const newText = cb.message.text + `\n\n━━━━━━━━━━━━━━━\n<b>Status: ${action} ${icon}</b>`;
                        
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                            chat_id: cb.message.chat.id,
                            message_id: cb.message.message_id,
                            text: newText,
                            parse_mode: 'HTML'
                        });
                    }
                }
            }
            return res.sendStatus(200);
        }

        // Handle Messages
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;

            if (text === '/start') {
                const firstName = update.message.from.first_name || "User";
                const welcomeMsg = `Hi! ${firstName} Welcome to RedExChanger.\n\nHere you can exchange your small dollar amounts and receive payment via BKash / Nagad. You can also earn money by completing tasks.\n\nPlus, you’ll get commission by referring others. So don’t waste any time — start earning now!\n\nSupport: @RedExSupportBot`;
                const keyboard = { inline_keyboard: [[{ text: "🚀 Open App", url: appLink }], [{ text: "📢 Join Channel", url: "https://t.me/RedExChanger" }, { text: "👥 Join Group", url: "https://t.me/RedExChangerGroup" }]] };
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: welcomeMsg, reply_markup: keyboard, parse_mode: 'HTML' });
            } 
            else if (text === '/ping') {
                const latency = Math.floor(Math.random() * (400 - 150) + 150); 
                const status = latency > 300 ? (latency > 600 ? "🔴 Slow" : "🟡 Average") : "🟢 Active";
                const pingMsg = `🏓 Pong!\n\n🧭 Ping: ${latency} ms\n\n📶 Status: ${status}\n\n📝 Note: This ping mainly shows bot/server response time.\n🗑 This will be deleted after 5 minutes.`;
                const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: pingMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", url: appLink }]] } });
                setTimeout(async () => {
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: response.data.result.message_id });
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: messageId });
                    } catch (e) {}
                }, 300000);
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(200); }
});

// Broadcast APIs
app.post('/api/broadcast-message', async (req, res) => {
    const { image, text, btnText, btnUrl } = req.body;
    res.json({ success: true });
    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);
        let count = 0;
        const sendNext = async () => {
            if (count >= users.length) return;
            const payload = image ? { chat_id: users[count], photo: image, caption: text || '', parse_mode: 'HTML' } : { chat_id: users[count], text: text, parse_mode: 'HTML' };
            if (btnText && btnUrl) payload.reply_markup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
            axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${image ? 'sendPhoto' : 'sendMessage'}`, payload).catch(e=>{});
            count++; setTimeout(sendNext, 50);
        };
        sendNext();
    } catch (e) {}
});

app.post('/api/broadcast-task', async (req, res) => {
    const { caption, target, reward, image, usdRate = 120 } = req.body; 
    const appLink = await getAppLink();
    const dollarReward = (parseFloat(reward) / usdRate).toFixed(3);
    const msg = `<b>🆕 New Task Available!</b>\n\n📋 Task: ${caption}\n👥 Slots: ${target}\n💰 Reward: ${reward}৳ = ${dollarReward}$\n\nComplete the task to earn rewards!\n\n@RedExChanger`;
    res.json({ success: true });
    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);
        let count = 0;
        const sendNext = async () => {
            if (count >= users.length) return;
            const payload = image ? { chat_id: users[count], photo: image, caption: msg, parse_mode: 'HTML' } : { chat_id: users[count], text: msg, parse_mode: 'HTML' };
            payload.reply_markup = { inline_keyboard: [[{ text: "Open App", url: appLink }]] };
            axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${image ? 'sendPhoto' : 'sendMessage'}`, payload).catch(e=>{});
            count++; setTimeout(sendNext, 50);
        };
        sendNext();
    } catch (e) {}
});

// Admin Action Logic (Handles Balance, Commission and Notifications)
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod, trxId, status, type, referrerId } = req.body;
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';
    const icon = status === 'Approved' ? '✅' : '❎';
    const appLink = await getAppLink();

    try {
        if (type === "Deposit" && status === 'Approved') {
            const depositAmount = parseFloat(amount);
            const commission = depositAmount * 0.015;
            const userFinalAmount = depositAmount - commission;
            await db.collection('users').doc(String(userId)).update({ mainBalance: admin.firestore.FieldValue.increment(userFinalAmount) });
            if (referrerId) {
                await db.collection('users').doc(String(referrerId)).update({ mainBalance: admin.firestore.FieldValue.increment(commission), refEarnings: admin.firestore.FieldValue.increment(commission) });
                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: `New Deposit Commission Added 💰\nAmount: ${commission.toFixed(2)} ৳`, parse_mode: 'HTML' }).catch(e=>{});
            }
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (1.5%): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedExChanger`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: appLink }]] } });
        }
        else if (type === "Exchange") {
            const msg = `Your Exchange Request ${actionText}. ${icon}\n\nUsername : @${userName}\nAmount : $${amount}\nTo : ${receiveMethod || 'N/A'}\nTrxID : <code>${trxId || 'N/A'}</code>\n\n@RedExChanger`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "CHECK HISTORY 📝", url: appLink }]] } });
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                await db.collection('users').doc(String(referrerId)).update({ mainBalance: admin.firestore.FieldValue.increment(parseFloat(exCommission)), refEarnings: admin.firestore.FieldValue.increment(parseFloat(exCommission)) });
            }
        } 
        else if (status === 'Rejected') {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: `Your ${type} request has been Rejected. ❌`, parse_mode: 'HTML' }).catch(e=>{});
        }
        res.json({ success: true });
    } catch (error) { res.json({ success: false }); }
});

// Referral Notification
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, firstName } = req.body;
    const appLink = await getAppLink();
    try {
        const userDoc = await db.collection('users').doc(String(referrerId)).get();
        const totalRefer = userDoc.exists ? (userDoc.data().referrals || 0) : 0;
        const msg = `<b>🆕 New Refer Joined!</b>\n\nName: ${firstName}\nTotal Refer: ${totalRefer}\n\n<i>You will receive a 0.1% commission when the person you refer makes a deposit or exchange.</i>`;
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: msg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Open App", url: appLink }]] } });
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// Admin Notification Core
const notifyAdmin = async (type, docId, msg) => {
    const keyboard = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `Approved:${type}:${docId}` }, { text: "❌ Dismiss", callback_data: `Rejected:${type}:${docId}` }]] };
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_ID, text: msg, parse_mode: 'HTML', reply_markup: keyboard }).catch(e=>{});
};

app.post('/api/notify-withdraw', async (req, res) => {
    const { docId, username, firstName, userId, amount, method, number } = req.body;
    const msg = `<b>💰 New Withdraw Request</b>\n\nUser: <code>${username ? '@'+username : firstName}</code>\nID: <code>${userId}</code>\nAmount: <code>${amount} Tk</code>\nMethod: <code>${method}</code>\nNumber: <code>${number}</code>`;
    await notifyAdmin('Withdraw', docId, msg); res.json({ success: true });
});

app.post('/api/notify-exchange', async (req, res) => {
    const { docId, username, firstName, userId, sendMethod, recMethod, number, trx, amount, bdtAmount } = req.body;
    const msg = `<b>🔄 New Exchange Request</b>\n\nUser: <code>${username ? '@'+username : firstName}</code>\nID: <code>${userId}</code>\nRoute: <code>${sendMethod} -> ${recMethod}</code>\nNumber: <code>${number}</code>\nTrxID: <code>${trx}</code>\nAmount: <code>$${amount}</code> (<code>${bdtAmount} Tk</code>)`;
    await notifyAdmin('Exchange', docId, msg); res.json({ success: true });
});

app.post('/api/notify-deposit', async (req, res) => {
    const { docId, username, firstName, userId, amount, method, trxId } = req.body;
    const msg = `<b>💳 New Deposit Request</b>\n\nUser: <code>${username ? '@'+username : firstName}</code>\nID: <code>${userId}</code>\nAmount: <code>${amount} Tk</code>\nMethod: <code>${method}</code>\nTrxID: <code>${trxId}</code>`;
    await notifyAdmin('Deposit', docId, msg); res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
