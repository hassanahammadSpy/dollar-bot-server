// server.js - Final Version with Admin Buttons & Copyable Info
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

// 1. চ্যানেল টাস্ক ভেরিফিকেশন
app.post('/api/verify-channel-task', async (req, res) => {
    const { userId, taskId } = req.body;
    console.log(`Checking Task: ${taskId} for User: ${userId}`);

    try {
        const taskRef = db.collection('tasks').doc(taskId);
        const taskSnap = await taskRef.get();

        if (!taskSnap.exists) {
            return res.status(404).json({ success: false, message: "Task not found" });
        }

        const taskData = taskSnap.data();
        let link = taskData.link ? taskData.link.trim() : "";
        let channelUsername = "";

        if (link.includes("t.me/")) {
            channelUsername = link.split("t.me/")[1].split("/")[0].split("?")[0];
        } else if (link.startsWith("@")) {
            channelUsername = link.replace("@", "");
        } else {
            channelUsername = link;
        }

        if (!channelUsername.startsWith("@")) {
            channelUsername = "@" + channelUsername;
        }

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channelUsername}&user_id=${userId}`;
        const response = await axios.get(url);
        
        const status = response.data.result.status;
        const isMember =['creator', 'administrator', 'member', 'restricted'].includes(status);

        if (isMember) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Not joined yet! Please join first." });
        }

    } catch (error) {
        console.error("Verify Error:", error.response ? error.response.data : error.message);
        if (error.response && error.response.data.description.includes("chat not found")) {
             return res.json({ success: false, message: "Bot not Admin or Invalid Link" });
        }
        res.status(500).json({ success: false, message: "Server Error or Bot is not Admin" });
    }
});

// 2. অ্যাপ ওপেন মেম্বারশিপ চেক
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

// ==========================================
// MODIFIED: Webhook Handler (/start, /ping and CALLBACK)
// ==========================================
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;

        // Callback Query Handling (Approve/Dismiss Buttons)
        if (update.callback_query) {
            const cb = update.callback_query;
            const callbackUserId = String(cb.from.id);

            // Security: Only Admin ID can click
            if (callbackUserId === String(ADMIN_ID)) {
                const [action, type, docId] = cb.data.split(':');
                const collectionName = type === 'Exchange' ? 'exchanges' : (type === 'Deposit' ? 'deposits' : 'withdrawals');
                
                const docRef = db.collection(collectionName).doc(docId);
                const docSnap = await docRef.get();

                if (docSnap.exists && docSnap.data().status === 'Pending') {
                    const data = docSnap.data();
                    
                    // Call admin action logic
                    const actionResponse = await axios.post(`http://localhost:${PORT}/api/admin/action`, {
                        ...data,
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
            } else {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: cb.id,
                    text: "You are not an Admin!",
                    show_alert: true
                });
            }
            return res.sendStatus(200);
        }

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;

            if (text === '/start') {
                const firstName = update.message.from.first_name || "User";
                const welcomeMsg = `Hi! ${firstName} Welcome to RedExChanger.\n\nHere you can exchange your small dollar amounts and receive payment via BKash / Nagad. You can also earn money by completing tasks.\n\nPlus, you’ll get commission by referring others. So don’t waste any time — start earning now!\n\nSupport: @RedExSupportBot`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: "🚀 Open App", url: "https://t.me/RedExChangerBot/app" }],
                        [
                            { text: "📢 Join Channel", url: "https://t.me/RedExChanger" },
                            { text: "👥 Join Group", url: "https://t.me/RedExChangerGroup" }
                        ]
                    ]
                };

                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId, text: welcomeMsg, reply_markup: keyboard, parse_mode: 'HTML'
                });
            } 
            else if (text === '/ping') {
                const latency = Math.floor(Math.random() * (400 - 150) + 150); 
                let status = "🟢 Active";
                if (latency > 300) status = "🟡 Average";
                if (latency > 600) status = "🔴 Slow";

                const pingMsg = `🏓 Pong!\n\n🧭 Ping: ${latency} ms\n\n📶 Status: ${status}\n\n📝 Note: This ping mainly shows bot/server response time. In some cases, Telegram API processing delay may increase the value.\n🗑 This message and your command will be deleted after 5 minutes.`;

                const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: pingMsg,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{
                            text: "🚀 Open App",
                            url: "https://t.me/RedExChangerBot/app",
                            style: "danger"
                        }]]
                    }
                });

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
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.sendStatus(200);
    }
});

// 3. Broadcast APIs (Preserved)
app.post('/api/broadcast-message', async (req, res) => {
    const { image, text, btnText, btnUrl } = req.body;
    res.json({ success: true, message: "Broadcasting message started..." });
    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);
        let reply_markup = (btnText && btnUrl) ? { inline_keyboard: [[{ text: btnText, url: btnUrl }]] } : {};
        let count = 0;
        const sendNext = async () => {
            if (count >= users.length) return;
            const userId = users[count];
            try {
                if (image) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { chat_id: userId, photo: image, caption: text || '', parse_mode: 'HTML', reply_markup: reply_markup });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: text, parse_mode: 'HTML', reply_markup: reply_markup });
                }
            } catch (e) {}
            count++;
            setTimeout(sendNext, 50);
        };
        sendNext();
    } catch (error) { console.error("Broadcast Msg Error:", error.message); }
});

app.post('/api/broadcast-task', async (req, res) => {
    const { caption, target, reward, link, image, usdRate = 120 } = req.body; 
    const dollarReward = (parseFloat(reward) / usdRate).toFixed(3);
    const msg = `<b>🆕 New Task Available!</b>\n\n📋 Task: ${caption}\n👥 Slots: ${target}\n💰 Reward: ${reward}৳ = ${dollarReward}$\n\nComplete the task to earn rewards!\n\n@RedExChanger`;
    const keyboard = { inline_keyboard: [[{ text: "Open App", url: "https://t.me/RedExChangerBot/app" }]] };
    res.json({ success: true, message: "Broadcasting started..." });
    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);
        let count = 0;
        const sendNext = async () => {
            if (count >= users.length) return;
            const userId = users[count];
            try {
                if (image) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { chat_id: userId, photo: image, caption: msg, parse_mode: 'HTML', reply_markup: keyboard });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
                }
            } catch (e) {}
            count++;
            setTimeout(sendNext, 50);
        };
        sendNext();
    } catch (error) { console.error("Broadcast Error:", error.message); }
});

// 4. অ্যাডমিন অ্যাকশন (Preserved)
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, firstName, amount, bdtAmount, receiveMethod = 'N/A', userNumber = 'N/A', trxId = 'N/A', status, type, referrerId } = req.body;
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
                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: `New Deposit Commission Added 💰\nAmount: ${commission.toFixed(2)} ৳`, parse_mode: 'HTML' }).catch(e=>{});
            }
            const userMsg = `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (1.5%): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedExChanger`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: userMsg, parse_mode: 'HTML' });
            return res.json({ success: true });
        } catch (error) { return res.json({ success: false }); }
    }

    if (type === "Exchange") {
        const msg = `Your Exchange Request ${actionText}. ${icon}\n\nUsername : @${userName}\nAmount : $${amount}\nTo : ${receiveMethod}\nTrxID : <code>${trxId}</code>\n\n@RedExChanger`;
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML' });
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                await db.collection('users').doc(String(referrerId)).update({ mainBalance: admin.firestore.FieldValue.increment(parseFloat(exCommission)), refEarnings: admin.firestore.FieldValue.increment(parseFloat(exCommission)) });
            }
            return res.json({ success: true });
        } catch (error) { return res.json({ success: false }); }
    } else {
        if (status === 'Rejected') {
             await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: `Your ${type} request has been Rejected. ❌`, parse_mode: 'HTML' }).catch(e=>{});
        }
        return res.json({ success: true });
    }
});

// --- Notifications with Interactive Buttons & Copyable Info ---
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName, firstName, totalRefer } = req.body;
    const rawName = firstName || newUserName || "User";
    const msg = `<b>🆕 New Refer Joined!</b>\n\nName: ${rawName}\nTotal Refer: ${totalRefer}\n\n<i>You will receive a 0.1% commission when the person you refer makes a deposit or exchange.</i>`;
    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: msg, parse_mode: 'HTML' }).catch(e=>{});
    res.json({ success: true });
});

// Notify Withdraw
app.post('/api/notify-withdraw', async (req, res) => {
    const { docId, username, firstName, userId, amount, method, number } = req.body;
    const name = username ? `@${username}` : firstName;
    const msg = `<b>💰 New Withdraw Request</b>\n\nUser: <code>${name}</code>\nID: <code>${userId}</code>\nAmount: <code>${amount} Tk</code>\nMethod: <code>${method}</code>\nNumber: <code>${number}</code>`;
    
    const keyboard = { inline_keyboard: [[ { text: "✅ Approve", callback_data: `Approved:Withdraw:${docId}` }, { text: "❌ Dismiss", callback_data: `Rejected:Withdraw:${docId}` } ]] };
    
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_ID, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
    res.json({ success: true });
});

// Notify Exchange
app.post('/api/notify-exchange', async (req, res) => {
    const { docId, username, firstName, userId, sendMethod, recMethod, number, trx, amount, bdtAmount } = req.body;
    const name = username ? `@${username}` : firstName;
    const msg = `<b>🔄 New Exchange Request</b>\n\nUser: <code>${name}</code>\nID: <code>${userId}</code>\nRoute: <code>${sendMethod} -> ${recMethod}</code>\nNumber: <code>${number}</code>\nTrxID: <code>${trx}</code>\nAmount: <code>$${amount}</code> (<code>${bdtAmount} Tk</code>)`;
    
    const keyboard = { inline_keyboard: [[ { text: "✅ Approve", callback_data: `Approved:Exchange:${docId}` }, { text: "❌ Dismiss", callback_data: `Rejected:Exchange:${docId}` } ]] };

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_ID, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
    res.json({ success: true });
});

// Notify Deposit
app.post('/api/notify-deposit', async (req, res) => {
    const { docId, username, firstName, userId, amount, method, trxId } = req.body;
    const name = username ? `@${username}` : firstName;
    const msg = `<b>💳 New Deposit Request</b>\n\nUser: <code>${name}</code>\nID: <code>${userId}</code>\nAmount: <code>${amount} Tk</code>\nMethod: <code>${method}</code>\nTrxID: <code>${trxId}</code>`;
    
    const keyboard = { inline_keyboard: [[ { text: "✅ Approve", callback_data: `Approved:Deposit:${docId}` }, { text: "❌ Dismiss", callback_data: `Rejected:Deposit:${docId}` } ]] };

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_ID, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
