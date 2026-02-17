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
        const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin Initialized");
    } catch (e) {
        console.error("Firebase Key Error:", e.message);
    }
} else {
    console.warn("Warning: FIREBASE_KEY not found.");
}
const db = admin.firestore();

// 1. চ্যানেল টাস্ক ভেরিফিকেশন (FIXED)
app.post('/api/verify-channel-task', async (req, res) => {
    const { userId, taskId } = req.body;

    try {
        // ১. ডাটাবেস থেকে টাস্কের লিংক আনা
        const taskRef = db.collection('tasks').doc(taskId);
        const taskSnap = await taskRef.get();

        if (!taskSnap.exists) {
            return res.json({ success: false, message: "Task expired or removed" });
        }

        const taskData = taskSnap.data();
        let link = taskData.link;

        // লিংক থেকে ইউজারনেম বের করা (ex: https://t.me/mychannel -> @mychannel)
        let channelUsername = "";
        if (link.includes("t.me/")) {
            channelUsername = "@" + link.split("t.me/")[1].replace("/", "");
        } else if (link.startsWith("@")) {
            channelUsername = link;
        } else {
            // যদি লিংক সঠিক না হয়, তবুও ম্যানুয়ালি সাকসেস দেওয়া (সেফটি)
            return res.json({ success: true });
        }
        
        // ২. টেলিগ্রাম API দিয়ে মেম্বারশিপ চেক
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channelUsername}&user_id=${userId}`;
        const response = await axios.get(url);
        
        const status = response.data.result.status;
        const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(status);

        if (isMember) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Not joined" });
        }

    } catch (error) {
        console.error("Task Verify Error:", error.message);
        // যদি বট ওই চ্যানেলে এডমিন না থাকে, তবে এরর দিবে। 
        // ইউজারকে আটকানোর চেয়ে এরর হলে সাকসেস দেওয়া ভালো, অথবা ফলস দিতে পারেন।
        res.json({ success: false, message: "Bot is not admin in that channel or Invalid Link" });
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

// 3. টাস্ক ব্রডকাস্ট (সবাইকে মেসেজ পাঠানো)
app.post('/api/broadcast-task', async (req, res) => {
    const { caption, target, reward, link } = req.body;

    const msg = `New Task Created ✅\n\n` +
                `Task Caption : ${caption}\n` +
                `Target User : ${target}\n` +
                `Reward : ${reward} ৳\n\n` +
                `@RedoExchange`;

    const keyboard = {
        inline_keyboard: [[{ text: "Join Task 👈", url: link || "https://t.me/RedoExchangeBot/app" }]]
    };

    // রেসপন্স আগে পাঠিয়ে দেওয়া যাতে অ্যাডমিন প্যানেল হ্যাং না করে
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
                    chat_id: userId,
                    text: msg,
                    reply_markup: keyboard
                });
            } catch (e) { 
                // ইউজার ব্লক করলে ইগনোর করবে
            }
            count++;
            setTimeout(sendNext, 50); // ৫০ মিলি সেকেন্ড বিরতি
        };
        sendNext();

    } catch (error) {
        console.error("Broadcast Error:", error.message);
    }
});

// 4. অ্যাডমিন অ্যাকশন (Deposit & Exchange Approval)
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod, userNumber, trxId, status, type, referrerId } = req.body;

    const icon = status === 'Approved' ? '✅' : '❎';
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';

    // --- DEPOSIT LOGIC ---
    if (type === "Deposit" && status === 'Approved') {
        const depositAmount = parseFloat(amount);
        const commissionRate = 0.015; // 1.5%
        const commission = depositAmount * commissionRate;
        const userFinalAmount = depositAmount - commission; // ইউজারের অ্যামাউন্ট থেকে কমিশন কাটা হলো

        try {
            // ১. ইউজারের মেইন ব্যালেন্স আপডেট
            await db.collection('users').doc(String(userId)).update({
                mainBalance: admin.firestore.FieldValue.increment(userFinalAmount)
            });

            // ২. রেফারার থাকলে তাকে ১.৫% কমিশন দেওয়া
            if (referrerId) {
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(commission),
                    refEarnings: admin.firestore.FieldValue.increment(commission)
                });

                // রেফারারকে মেসেজ
                const refMsg = `New Deposit Commission Added 💰\n` +
                               `From User: @${userName}\n` +
                               `Commission: ${commission.toFixed(2)} ৳\n` +
                               `<blockquote>(1.5% from Deposit)</blockquote>`;
                
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: referrerId, text: refMsg, parse_mode: 'HTML'
                }).catch(e => {});
            }

            // ৩. ডিপোজিটকারীকে মেসেজ
            const userMsg = `Your Deposit Approved! ${icon}\n\n` +
                            `Original Amount: ${amount} ৳\n` +
                            `Fee (1.5%): -${commission.toFixed(2)} ৳\n` +
                            `Added to Balance: ${userFinalAmount.toFixed(2)} ৳\n\n` +
                            `@RedoExchange`;
            
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: userMsg, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: "https://t.me/RedoExchangeBot/app" }]] }
            });

            return res.json({ success: true });

        } catch (error) {
            console.error("Deposit Error:", error);
            return res.json({ success: false });
        }
    }

    // --- EXCHANGE LOGIC ---
    if (type === "Exchange") {
        const msg = `Your Exchange Request ${actionText}. ${icon}\n\n` +
                    `Username : @${userName}\n` +
                    `Amount : $${amount}\n` +
                    `Payment Method : ${receiveMethod}\n` +
                    `Payment Number : <code>${userNumber}</code>\n` +
                    `Transaction ID : <code>${trxId}</code>\n` +
                    `Date : ${new Date().toLocaleString()}\n\n` +
                    `@RedoExchange`;

        const keyboard = {
            inline_keyboard: [[{ text: "CHECK HISTORY 📝", url: "https://t.me/RedoExchangeBot/app" }]]
        };

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard
            });

            // এক্সচেঞ্জ এপ্রুভ হলে রেফার কমিশন
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(parseFloat(exCommission)),
                    refEarnings: admin.firestore.FieldValue.increment(parseFloat(exCommission))
                });
            }
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false });
        }
    } 
    // Withdraw বা অন্যান্য রিজেকশন মেসেজ
    else {
        if (status === 'Rejected') {
             await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: `Your ${type} request has been Rejected. ❌`, parse_mode: 'HTML'
            }).catch(e=>{});
        }
        res.json({ success: true });
    }
});

// 5. নতুন রেফার জয়েন নোটিফিকেশন
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName } = req.body;
    const msg = `New Refer 🎉\n` +
                `Username : ${newUserName}\n\n` +
                `<blockquote>(আপনার রেফার করা ব্যক্তি Exchange/Deposit করলে আপনি ১.৫% কমিশন পাবেন)</blockquote>`;

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: referrerId, text: msg, parse_mode: 'HTML'
        });
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// 6. এডমিন নোটিফিকেশনস
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
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId, text: text, parse_mode: 'HTML'
        });
    } catch (e) { console.error(e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
