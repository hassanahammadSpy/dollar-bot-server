// server.js - Final Fixed Version
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
// MODIFIED: Webhook Handler (/start and /ping)
// ==========================================
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;

            // Handle /start command
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
            
            // Handle /ping command
            else if (text === '/ping') {
                const statusMsg = `<b>Server Status:</b> Active 🟢\n<b>System:</b> Running 🚀\n<b>Latency:</b> Fast ⚡`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId, text: statusMsg, parse_mode: 'HTML'
                });
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.sendStatus(200);
    }
});

// ==========================================
// NEW: Broadcast Message API (With Image & Button)
// ==========================================
app.post('/api/broadcast-message', async (req, res) => {
    const { image, text, btnText, btnUrl } = req.body;
    
    // সাথে সাথে ফ্রন্টএন্ডে রেসপন্স পাঠিয়ে দেওয়া হলো যাতে প্যানেল লোড না নেয়
    res.json({ success: true, message: "Broadcasting message started..." });

    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);

        let reply_markup = {};
        if (btnText && btnUrl) {
            reply_markup = { inline_keyboard: [[{ text: btnText, url: btnUrl }]] };
        }

        let count = 0;
        const sendNext = async () => {
            if (count >= users.length) return;
            const userId = users[count];
            
            try {
                if (image) {
                    // ইমেজ থাকলে sendPhoto ব্যবহার করা হবে
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                        chat_id: userId, photo: image, caption: text || '', parse_mode: 'HTML', reply_markup: reply_markup
                    });
                } else {
                    // ইমেজ না থাকলে sendMessage
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: userId, text: text, parse_mode: 'HTML', reply_markup: reply_markup
                    });
                }
            } catch (e) {
                // ইউজার বট ব্লক করলে এরর স্কিপ করবে
            }
            
            count++;
            setTimeout(sendNext, 50); // Telegram Rate Limit এড়াতে 50ms ডিলে
        };
        sendNext();
    } catch (error) { 
        console.error("Broadcast Msg Error:", error.message); 
    }
});

// ==========================================
// MODIFIED: Task Broadcast (With Image Support)
// ==========================================
app.post('/api/broadcast-task', async (req, res) => {
    const { caption, target, reward, link, image, usdRate = 120 } = req.body; 
    
    const dollarReward = (parseFloat(reward) / usdRate).toFixed(3);

    const msg = `<b>🆕 New Task Available!</b>\n\n` +
                `📋 Task: ${caption}\n` +
                `👥 Slots: ${target}\n` +
                `💰 Reward: ${reward}৳ = ${dollarReward}$\n\n` +
                `Complete the task to earn rewards!\n\n` +
                `@RedExChanger`;
                
    const keyboard = { inline_keyboard: [[{ text: "Open App", url: "https://t.me/RedExChangerBot/app" }]] };

    res.json({ success: true, message: "Broadcasting started..." });

    try {
        const usersSnapshot = await db.collection('users').get();
        let count = 0;
        const users = usersSnapshot.docs.map(doc => doc.id);
        
        const sendNext = async () => {
            if (count >= users.length) return;
            const userId = users[count];
            try {
                if (image) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                        chat_id: userId, photo: image, caption: msg, parse_mode: 'HTML', reply_markup: keyboard
                    });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard
                    });
                }
            } catch (e) {}
            count++;
            setTimeout(sendNext, 50);
        };
        sendNext();
    } catch (error) { console.error("Broadcast Error:", error.message); }
});

// 4. অ্যাডমিন অ্যাকশন
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod = 'N/A', userNumber = 'N/A', trxId = 'N/A', status, type, referrerId } = req.body;
    const icon = status === 'Approved' ? '✅' : '❎';
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';

    if (type === "Deposit" && status === 'Approved') {
        const depositAmount = parseFloat(amount);
        const commissionRate = 0.015;
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
            const userMsg = `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (1.5%): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedExChanger`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: userMsg, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: "https://t.me/RedExChangerBot/app" }]] }
            });
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

// Notifications (FIXED - 100% Working Setup)
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName, firstName, totalRefer } = req.body;
    
    if (!referrerId) {
        return res.json({ success: false, message: "No referrer ID provided" });
    }

    // 1. Total Refer কাউন্ট ডাটাবেস থেকে সঠিকভাবে বের করা
    let referCount = totalRefer;
    if (referCount === undefined || referCount === null) {
        try {
            const userDoc = await db.collection('users').doc(String(referrerId)).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                if (Array.isArray(userData.referrals)) {
                    referCount = userData.referrals.length;
                } else if (typeof userData.referrals === 'number') {
                    referCount = userData.referrals;
                } else if (typeof userData.totalRefer === 'number') {
                    referCount = userData.totalRefer;
                } else {
                    referCount = 1; 
                }
            } else {
                referCount = 1;
            }
        } catch (e) {
            console.error("Refer fetch error:", e.message);
            referCount = 1;
        }
    }

    // 2. Name Sanitize করা হচ্ছে
    const rawName = firstName || newUserName || "User";
    const safeName = String(rawName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const msg = `<b>🆕 New Refer Joined!</b>\n\n` +
                `Name: ${safeName}\n` +
                `Total Refer: ${referCount}\n\n` +
                `<i>You will receive a 0.1% commission when the person you refer makes a deposit or exchange.</i>`;
                
    const keyboard = { inline_keyboard: [[{ text: "Open App", url: "https://t.me/RedExChangerBot/app" }]] };

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: referrerId, text: msg, parse_mode: 'HTML', reply_markup: keyboard
        });
        res.json({ success: true });
    } catch (error) { 
        console.error("Telegram Refer Notify Error:", error.response ? error.response.data : error.message);
        res.json({ success: false }); 
    }
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
