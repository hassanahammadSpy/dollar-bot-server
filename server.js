// server.js - Complete System (Updated Refer Join Message)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// Render থেকে ভেরিয়েবল নিবে
const BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 

// 1. মেম্বারশিপ চেক
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

// 2. অ্যাডমিন অ্যাকশন (Exchange Approve & Commission)
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod, userNumber, trxId, status, type, referrerId } = req.body;

    if (type === "Exchange") {
        const icon = status === 'Approved' ? '✅' : '❎';
        const actionText = status === 'Approved' ? 'Approved' : 'Rejected'; 

        // ইউজারকে মেসেজ
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

            // রেফার কমিশন মেসেজ (শুধুমাত্র Approve হলে)
            if (status === 'Approved' && referrerId && bdtAmount) {
                const commission = (parseFloat(bdtAmount) * 0.015).toFixed(2);
                const refMsg = `New Refer Commission Added 💰\n` +
                               `User: @${userName}\n` +
                               `Amount: ${commission} BDT\n\n` +
                               `<blockquote>(Commission 1.5% from Exchange)</blockquote>`;

                const refKeyboard = {
                    inline_keyboard: [[{ text: "Check Balance 💰", url: "https://t.me/RedoExchangeBot/app" }]]
                };

                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: referrerId, text: refMsg, parse_mode: 'HTML', reply_markup: refKeyboard
                }).catch(e => console.log("Refer Msg Blocked"));
            }
            res.json({ success: true });
        } catch (error) {
            console.error("Admin Error:", error.message);
            res.json({ success: false });
        }
    } else {
        res.json({ success: true });
    }
});

// 3. নতুন রেফার জয়েন মেসেজ (New Join Notification)
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName } = req.body;

    // আপনার চাওয়া ফরম্যাট অনুযায়ী মেসেজ
    const msg = `New Refer 🎉\n` +
                `Username : ${newUserName}\n\n` +
                `<blockquote>(আপনার রেফার করা ব্যক্তি Exchange করলে সেখান থেকে আপনি ১.৫% কমিশন পাবেন)</blockquote>`;

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: referrerId,
            text: msg,
            parse_mode: 'HTML' // HTML মোড অন করা হয়েছে যাতে quote কাজ করে
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Refer Join Error:", error.message);
        res.json({ success: false });
    }
});

// 4. এডমিন নোটিফিকেশনস
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
