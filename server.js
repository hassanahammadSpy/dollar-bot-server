// server.js - Complete System (Task Broadcast + Deposit Commission)
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

// Firebase Admin Setup (ব্যালেন্স আপডেট ও ইউজার লিস্ট পাওয়ার জন্য)
// আপনার Render Environment Variable এ 'FIREBASE_KEY' নামে Service Account JSON টি রাখবেন
if (process.env.FIREBASE_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.warn("Warning: FIREBASE_KEY not found. Database operations will fail.");
}
const db = admin.firestore();

// 1. মেম্বারশিপ চেক (চ্যানেল জয়েন টাস্কের জন্য)
app.post('/api/verify-channel-task', async (req, res) => {
    const { userId, taskId } = req.body;
    // এখানে আপনি চাইলে taskId দিয়ে টাস্কের চ্যানেল লিঙ্ক চেক করতে পারেন
    // আপাতত আমরা ধরে নিচ্ছি ইউজারের Bot টি সেই চ্যানেলে এডমিন আছে
    // এই লজিকটি আপনার Bot এবং Channel এর ওপর নির্ভর করে
    
    // For simplicity, returning success true for now or implement logic like /api/verify-member
    res.json({ success: true });
});

// পুরনো মেম্বারশিপ চেক
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
        console.error("Verify Error:", error.message);
        res.json({ isMember: false });
    }
});

// 2. টাস্ক ব্রডকাস্ট (Task Broadcast API) - NEW ✅
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

    try {
        // ফায়ারবেস থেকে সব ইউজার আইডি আনা
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);

        res.json({ success: true, message: "Broadcasting started..." });

        // সব ইউজারকে মেসেজ পাঠানো (Delay সহ যাতে Telegram Block না করে)
        let count = 0;
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
                // ইউজার ব্লক করলে বা এরর হলে ইগনোর করবে
            }
            count++;
            setTimeout(sendNext, 50); // 50ms delay per user
        };
        sendNext();

    } catch (error) {
        console.error("Broadcast Error:", error.message);
        // যদি রেসপন্স আগে না পাঠিয়ে থাকেন তবে পাঠাবেন
        if (!res.headersSent) res.json({ success: false });
    }
});

// 3. অ্যাডমিন অ্যাকশন (Exchange/Deposit Approve & Commission) - UPDATED ✅
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod, userNumber, trxId, status, type, referrerId } = req.body;

    const icon = status === 'Approved' ? '✅' : '❎';
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';

    // ১. Deposit লজিক (কমিশন + ব্যালেন্স আপডেট)
    if (type === "Deposit" && status === 'Approved') {
        const depositAmount = parseFloat(amount);
        const commissionRate = 0.015; // 1.5%
        const commission = depositAmount * commissionRate;
        const userFinalAmount = depositAmount - commission;

        try {
            // ইউজারের ব্যালেন্স আপডেট (1.5% কেটে রাখা অ্যামাউন্ট)
            await db.collection('users').doc(String(userId)).update({
                mainBalance: admin.firestore.FieldValue.increment(userFinalAmount)
            });

            // রেফারার থাকলে তাকে 1.5% কমিশন দেওয়া
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
                }).catch(e => console.log("Refer Msg Error"));
            }

            // ডিপোজিটকারী ইউজারকে মেসেজ
            const userMsg = `Your Deposit Approved! ${icon}\n\n` +
                            `Amount: ${amount} ৳\n` +
                            `Fee (1.5%): -${commission.toFixed(2)} ৳\n` +
                            `Added to Balance: ${userFinalAmount.toFixed(2)} ৳\n\n` +
                            `@RedoExchange`;
            
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: userMsg, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: "https://t.me/RedoExchangeBot/app" }]] }
            });

            return res.json({ success: true });

        } catch (error) {
            console.error("Deposit DB Error:", error);
            return res.json({ success: false, error: error.message });
        }
    }

    // ২. Exchange লজিক (আগের মতোই)
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

            // Exchange রেফার কমিশন (যদি থাকে)
            if (status === 'Approved' && referrerId && bdtAmount) {
                const exCommission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(parseFloat(exCommission)),
                    refEarnings: admin.firestore.FieldValue.increment(parseFloat(exCommission))
                });
                // Optional: Send msg to referrer
            }
            res.json({ success: true });
        } catch (error) {
            console.error("Exchange Msg Error:", error.message);
            res.json({ success: false });
        }
    } else {
        // অন্যান্য রিকোয়েস্ট (Withdraw etc.) এর জন্য সাধারণ মেসেজ বা কিছুই না
        if (status === 'Rejected') {
             await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: `Your ${type} request has been Rejected. ❌`, parse_mode: 'HTML'
            }).catch(e=>{});
        }
        res.json({ success: true });
    }
});

// 4. নতুন রেফার জয়েন নোটিফিকেশন
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

// 5. এডমিন নোটিফিকেশনস
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
