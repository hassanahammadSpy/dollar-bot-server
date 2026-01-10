// server.js - Complete Security System
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// Render Environment Variables থেকে ডাটা নিবে
const BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 

// 1. মেম্বারশিপ চেক (চ্যানেল জয়েন ফিক্স)
app.post('/api/verify-member', async (req, res) => {
    const { userId, channelUsername } = req.body;
    try {
        const channel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
        // টেলিগ্রাম API কল
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`;
        const response = await axios.get(url);
        
        const status = response.data.result.status;
        const isMember = ['creator', 'administrator', 'member'].includes(status);
        
        res.json({ isMember: isMember });
    } catch (error) {
        console.error("Verify Error:", error.message);
        // এরর হলে ফলস পাঠাবে যাতে পপআপ থেকে যায়
        res.json({ isMember: false });
    }
});

// 2. অ্যাডমিন অ্যাকশন (Approve/Reject)
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, receiveMethod, userNumber, trxId, status, type } = req.body;

    if (type === "Exchange") {
        const icon = status === 'Approved' ? '✅' : '❎';
        const actionText = status === 'Approved' ? 'Approved' : 'Resected'; 

        const msg = `You are Exchange Request ${actionText}. ${icon}\n\n` +
                    `Username : @${userName}\n` +
                    `Amount : $${amount}\n` +
                    `Payment Mathod : ${receiveMethod}\n` +
                    `Payment Number : <code>${userNumber}</code>\n` +
                    `Transaction ID : <code>${trxId}</code>\n` +
                    `Date : ${new Date().toLocaleString()}\n\n` +
                    `@RedoExchange`;

        const keyboard = {
            inline_keyboard: [[{ text: "CHECK HISTORY 📝", url: "https://t.me/RedoExchangeBot/app?startapp=7767338426" }]]
        };

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId,
                text: msg,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
            res.json({ success: true });
        } catch (error) {
            console.error("Admin Action Error:", error.message);
            res.json({ success: false });
        }
    } else {
        res.json({ success: true });
    }
});

// 3. সাধারণ নোটিফিকেশন (Withdraw/Referral)
app.post('/api/notify-withdraw', async (req, res) => {
    const { username, amount, method, number } = req.body;
    const msg = `<b>New Withdraw Request</b>\n\n👤 User: @${username}\n💰 Amount: ${amount} Pts\nMethod: ${method}\n📱 Number: ${number}`;
    await sendMessageToTelegram(ADMIN_ID, msg);
    res.json({ success: true });
});

app.post('/api/notify-exchange', async (req, res) => {
    const { username, userId, sendMethod, recMethod, number, trx, amount, bdtAmount } = req.body;
    const msg = `New Exchange Request Submitted ✅\n\nUsername: @${username}\nChat id: <code>${userId}</code>\nExchange Method: ${sendMethod}\nPayment Method: ${recMethod}\nNumber: <code>${number}</code>\nTrx ID: <code>${trx}</code>\nAmount: $${amount}\nConverted: ${bdtAmount} Tk`;
    await sendMessageToTelegram(ADMIN_ID, msg);
    res.json({ success: true });
});

app.post('/api/notify-referral', async (req, res) => {
    const { referrerId, newUserName } = req.body;
    await sendMessageToTelegram(referrerId, `🎉 New Referral: @${newUserName}\n💰 +50 Points`);
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
    console.log(`Server is running on port ${PORT}`);
});
