// server.js - Final Fixed Version (With Better Link Parsing)
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
        // ফায়ারবেস কি যদি স্ট্রিং হয়, পার্স করবে
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

// 1. চ্যানেল টাস্ক ভেরিফিকেশন (IMPROVED LOGIC)
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
        let link = taskData.link.trim(); // লিংক থেকে স্পেস সরাবে
        let channelUsername = "";

        // লিংক থেকে ইউজারনেম বের করার লজিক
        if (link.includes("t.me/")) {
            // https://t.me/username -> username
            channelUsername = link.split("t.me/")[1].split("/")[0].split("?")[0];
        } else if (link.startsWith("@")) {
            // @username -> username
            channelUsername = link.replace("@", "");
        } else {
            channelUsername = link; // শুধু username দেওয়া থাকলে
        }

        // সামনে @ যুক্ত করা (Telegram API এর জন্য)
        if (!channelUsername.startsWith("@")) {
            channelUsername = "@" + channelUsername;
        }

        console.log(`Verifying against channel: ${channelUsername}`);

        // টেলিগ্রাম API কল
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channelUsername}&user_id=${userId}`;
        const response = await axios.get(url);
        
        const status = response.data.result.status;
        const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(status);

        if (isMember) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Not joined yet! Please join first." });
        }

    } catch (error) {
        console.error("Verify API Error:", error.response ? error.response.data : error.message);
        
        // বট এডমিন না থাকলে বা চ্যানেল প্রাইভেট হলে এই এরর হ্যান্ডেলিং
        if (error.response && error.response.data.description.includes("chat not found")) {
             return res.json({ success: false, message: "Invalid Channel Link or Bot not Admin" });
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
        const isMember = ['creator', 'administrator', 'member'].includes(status);
        res.json({ isMember: isMember });
    } catch (error) {
        res.json({ isMember: false });
    }
});

// 3. টাস্ক ব্রডকাস্ট
app.post('/api/broadcast-task', async (req, res) => {
    const { caption, target, reward, link } = req.body;
    const msg = `New Task Created ✅\n\n` +
                `Task Caption : ${caption}\n` +
                `Target User : ${target}\n` +
                `Reward : ${reward} ৳\n\n` +
                `@RedoExchange`;
    const keyboard = { inline_keyboard: [[{ text: "Join Task 👈", url: link || "https://t.me/RedoExchangeBot/app" }]] };

    res.json({ success: true, message: "Broadcasting started..." });

    try {
        const usersSnapshot = await db.collection('users').get();
        let count = 0;
        const users = usersSnapshot.docs.map(doc => doc.id);
        const sendNext = async () => {
            if (count >= users.length) return;
            const userId = users[count];
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: userId, text: msg, reply_markup: keyboard
                });
            } catch (e) {}
            count++;
            setTimeout(sendNext, 50);
        };
        sendNext();
    } catch (error) { console.error("Broadcast Error:", error.message); }
});

// 4. অ্যাডমিন অ্যাকশন (Deposit & Exchange)
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod, userNumber, trxId, status, type, referrerId } = req.body;
    const icon = status === 'Approved' ? '✅' : '❎';
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';

    // DEPOSIT LOGIC
    if (type === "Deposit" && status === 'Approved') {
        const depositAmount = parseFloat(amount);
        const commissionRate = 0.015; // 1.5%
        const commission = depositAmount * commissionRate;
        const userFinalAmount = depositAmount - commission;

        try {
            await db.collection('users').doc(String(userId)).update({
                mainBalance: admin.firestore.FieldValue.increment(userFinalAmount)
            });
            if (referrerId) {
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(commission),
                    refEarnings: admin.firestore.FieldValue.increment(commission)
                });
                const refMsg = `New Deposit Commission Added 💰\nUser: @${userName}\nAmount: ${commission.toFixed(2)} ৳\n<blockquote>(1.5% from Deposit)</blockquote>`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: refMsg, parse_mode: 'HTML' }).catch(e => {});
            }
            const userMsg = `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (1.5%): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedoExchange`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: userMsg, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: "https://t.me/RedoExchangeBot/app" }]] }
            });
            return res.json({ success: true });
        } catch (error) { return res.json({ success: false }); }
    }

    // EXCHANGE LOGIC
    if (type === "Exchange") {
        const msg = `Your Exchange Request ${actionText}. ${icon}\n\nUsername : @${userName}\nAmount : $${amount}\nTo : ${receiveMethod}\nTrxID : <code>${trxId}</code>\n\n@RedoExchange`;
        const keyboard = { inline_keyboard: [[{ text: "CHECK HISTORY 📝", url: "https://t.me/RedoExchangeBot/app" }]] };
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(parseFloat(exCommission)),
                    refEarnings: admin.firestore.FieldValue.increment(parseFloat(exCommission))
                });
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

// Notifications
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName } = req.body;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: referrerId, text: `New Refer 🎉\nUsername : ${newUserName}\n\n<blockquote>(You get 1.5% commission on their Exchange/Deposit)</blockquote>`, parse_mode: 'HTML'
        });
        res.json({ success: true });
    } catch (error) { res.json({ success: false }); }
});

app.post('/api/notify-withdraw', async (req, res) => {
    const { username, amount, method, number } = req.body;
    await sendMessageToTelegram(ADMIN_ID, `<b>Withdraw Request</b>\nUser: @${username}\nAmount: ${amount} Tk\nMethod: ${method}\nNumber: ${number}`);
    res.json({ success: true });
});

app.post('/api/notify-exchange', async (req, res) => {
    const { username, userId, sendMethod, recMethod, number, trx, amount, bdtAmount } = req.body;
    await sendMessageToTelegram(ADMIN_ID, `New Exchange ✅\nUser: @${username}\nID: <code>${userId}</code>\n${sendMethod} -> ${recMethod}\nNum: <code>${number}</code>\nTrx: <code>${trx}</code>\nAmt: $${amount} (${bdtAmount} Tk)`);
    res.json({ success: true });
});

async function sendMessageToTelegram(chatId, text) {
    try { await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: text, parse_mode: 'HTML' }); } catch (e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
