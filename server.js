require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const os = require('os');
const { exec } = require('child_process');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID || '7767338426'; 
const BOT_START_TIME = Date.now();

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

// --- Helper: get exchange fee % for a given exchange method name ---
async function getExchangeFeePercent(methodName) {
    if (!methodName) return 0;
    try {
        const snap = await db.collection('exchange_methods').where('name', '==', methodName).limit(1).get();
        if (snap.empty) return 0;
        const fee = parseFloat(snap.docs[0].data().fee);
        return isNaN(fee) ? 0 : fee;
    } catch (e) {
        console.error("getExchangeFeePercent error:", e.message);
        return 0;
    }
}

// --- Helper: get app settings (cached lightly per-call, simple direct read) ---
async function getAppSettings() {
    try {
        const s = await db.collection('settings').doc('appConfig').get();
        return s.exists ? s.data() : {};
    } catch (e) {
        return {};
    }
}

// 1. চ্যানেল টাস্ক ভেরিফিকেশন
app.post('/api/verify-channel-task', async (req, res) => {
    const { userId, taskId } = req.body;
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


// Helper function to process admin actions from bot
async function processAdminAction(reqId, newStatus, adminName) {
    try {
        const reqRef = db.collection('requests').doc(reqId);
        const reqSnap = await reqRef.get();
        if (!reqSnap.exists) {
            return { success: false, message: "Request not found." };
        }
        
        const r = reqSnap.data();
        
        if (r.status !== 'Pending') {
            return { success: false, message: `Request already ${r.status}.` };
        }
        
        await reqRef.update({ status: newStatus });
        
        if (r.type === "Withdraw" && newStatus === "Rejected") {
            await db.collection('users').doc(r.userId).update({
                mainBalance: admin.firestore.FieldValue.increment(r.amount)
            });
        }
        
        await axios.post(`https://dollar-bot-server.onrender.com/api/admin/action`, {
             ...r,
             status: newStatus
        });
        
        return { success: true, originalMessage: `Request from @${r.userName} processed.` };
        
    } catch (error) {
        console.error("Error processing admin action:", error);
        return { success: false, message: "Server error during action." };
    }
}

// --- Ping message builder (shared between private chat and group) ---
async function buildPingMessage(latencyMs) {
    const uptimeSec = Math.floor(process.uptime());
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const uptimeStr = `${days}d ${String(hours).padStart(2,'0')}h ${String(mins).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s`;

    // CPU load (approx, based on 1-minute load average vs core count)
    const cpuCount = os.cpus().length || 1;
    const load1 = os.loadavg()[0];
    const cpuPercent = Math.min(100, (load1 / cpuCount) * 100).toFixed(2);

    // RAM usage
    const totalMemGB = os.totalmem() / (1024 ** 3);
    const freeMemGB = os.freemem() / (1024 ** 3);
    const usedMemGB = totalMemGB - freeMemGB;

    // Disk space via `df` (Linux). Falls back to 0.00/0.00 if unavailable (e.g. on Windows or restricted hosts).
    const diskInfo = await new Promise((resolve) => {
        exec("df -k / | tail -1 | awk '{print $2, $3}'", (err, stdout) => {
            if (err || !stdout) return resolve({ usedGB: 0, totalGB: 0 });
            const parts = stdout.trim().split(/\s+/).map(Number);
            const totalGB = (parts[0] || 0) / (1024 * 1024);
            const usedGB = (parts[1] || 0) / (1024 * 1024);
            resolve({ usedGB, totalGB });
        });
    });

    return `ᴘᴏɴɢ! — ${latencyMs} ms\n\n` +
        `ꜱʏꜱᴛᴇᴍ ꜱᴛᴀᴛᴜꜱ\n` +
        `─────────────────────\n` +
        `• ᴜᴘᴛɪᴍᴇ: ${uptimeStr}\n` +
        `• ᴄᴘᴜ ʟᴏᴀᴅ: ${cpuPercent}%\n` +
        `• ʀᴀᴍ ᴜꜱᴀɢᴇ: ${usedMemGB.toFixed(2)} / ${totalMemGB.toFixed(2)} GB\n` +
        `• ᴅɪꜱᴋ ꜱᴘᴀᴄᴇ: ${diskInfo.usedGB.toFixed(2)} / ${diskInfo.totalGB.toFixed(2)} GB\n` +
        `─────────────────────`;
}

// Webhook Handler (/start, /ping, callback_query)
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;
            // Support "/ping@YourBotUsername" style commands used in groups
            const command = text.split('@')[0].split(' ')[0];

            if (command === '/start') {
                const firstName = update.message.from.first_name || "User";
                const welcomeMsg = `Hi! ${firstName} Welcome to RedExChanger.\n\nHere you can exchange your small dollar amounts and receive payment via BKash / Nagad. You can also earn money by completing tasks.\n\nPlus, you’ll get commission by referring others. So don’t waste any time — start earning now!\n\nSupport: @RedExSupportBot`;
                const keyboard = { inline_keyboard: [[{ text: "🚀 Open App", url: "https://t.me/RedExChangerBot/app" }], [{ text: "📢 Join Channel", url: "https://t.me/RedExChanger" }, { text: "👥 Join Group", url: "https://t.me/RedExChangerGroup" }]] };
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: welcomeMsg, reply_markup: keyboard, parse_mode: 'HTML' });
            } 
            else if (command === '/ping') {
                // Note: Telegram inline buttons cannot be given a custom color via the Bot API —
                // button color is controlled by the Telegram client itself, not by bots.
                const t0 = Date.now();
                const pingKeyboard = { inline_keyboard: [[{ text: "🛠 Support", url: "https://t.me/RedExSupportBot" }]] };

                // Send a lightweight placeholder first so we can measure real round-trip latency,
                // then edit it with the final stats message.
                const sent = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId, text: "Pinging...", reply_to_message_id: messageId
                });
                const latency = Date.now() - t0;
                const botMsgId = sent.data.result.message_id;
                const pingMsg = await buildPingMessage(latency);

                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                    chat_id: chatId, message_id: botMsgId, text: pingMsg, reply_markup: pingKeyboard
                });

                // Auto-delete both messages after 5 minutes (works the same in private chats and groups,
                // as long as the bot has delete-message rights in that group).
                setTimeout(async () => {
                    try {
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: botMsgId });
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: messageId });
                    } catch (e) {}
                }, 300000);
            }
        } 
        
        else if (update.callback_query) {
            const cbq = update.callback_query;
            const data = cbq.data;
            const adminUser = cbq.from;
            const message = cbq.message;
            
            if (data.startsWith('act_')) {
                const [_, reqId, status] = data.split('_');
                const adminName = adminUser.first_name || "Admin";

                const result = await processAdminAction(reqId, status, adminName);
                
                if (result.success) {
                    const newText = message.caption ? message.caption + `\n\n<b>Status: ${status} by ${adminName}</b>` : message.text + `\n\n<b>Status: ${status} by ${adminName}</b>`;
                    
                    if(message.photo) {
                         await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageCaption`, {
                            chat_id: message.chat.id, message_id: message.message_id, caption: newText, parse_mode: 'HTML', reply_markup: {} 
                        });
                    } else {
                         await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                            chat_id: message.chat.id, message_id: message.message_id, text: newText, parse_mode: 'HTML', reply_markup: {} 
                        });
                    }
                    
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cbq.id, text: `Request ${status}!` });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cbq.id, text: result.message, show_alert: true });
                }
            }
        }
        res.sendStatus(200);
    } catch (error) { res.sendStatus(200); }
});


// Broadcast APIs
app.post('/api/broadcast-message', async (req, res) => {
    const { image, text, buttons, pinAll } = req.body;
    res.json({ success: true, message: "Broadcasting message started..." });
    try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => doc.id);
        let reply_markup = {};
        if (buttons && Array.isArray(buttons) && buttons.length > 0) {
            reply_markup = { inline_keyboard: buttons.map(btn => [{ text: btn.text, url: btn.url }]) };
        }
        let count = 0;
        const sendNext = async () => {
            if (count >= users.length) return;
            const userId = users[count];
            try {
                let sentMsg;
                if (image) {
                    sentMsg = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { chat_id: userId, photo: image, caption: text || '', parse_mode: 'HTML', reply_markup: reply_markup });
                } else {
                    sentMsg = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: text, parse_mode: 'HTML', reply_markup: reply_markup });
                }
                // Pin All User option: pin the just-sent broadcast message in each user's private chat with the bot
                if (pinAll && sentMsg && sentMsg.data && sentMsg.data.result) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
                        chat_id: userId, message_id: sentMsg.data.result.message_id, disable_notification: true
                    }).catch(() => {}); // ignore if user blocked bot or pin not allowed
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

// Admin Actions (Approve/Reject) WITH Commission Generated Tracking
app.post('/api/admin/action', async (req, res) => {
    const { userId, userName, amount, bdtAmount, receiveMethod = 'N/A', sendMethod = 'N/A', userNumber = 'N/A', trxId = 'N/A', status, type, referrerId } = req.body;
    const icon = status === 'Approved' ? '✅' : '❎';
    const actionText = status === 'Approved' ? 'Approved' : 'Rejected';

    if (type === "Deposit" && status === 'Approved') {
        const depositAmount = parseFloat(amount);
        const commissionRate = 0.10; // 10% Commission
        const commission = depositAmount * commissionRate;
        const userFinalAmount = depositAmount - commission;

        try {
            await db.collection('users').doc(String(userId)).update({
                mainBalance: admin.firestore.FieldValue.increment(userFinalAmount),
                commissionGenerated: admin.firestore.FieldValue.increment(commission) // Track Commission from this user
            });
            if (referrerId) {
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(commission),
                    refEarnings: admin.firestore.FieldValue.increment(commission)
                });
                const refMsg = `<b>New Deposit Commission Added 💰</b>\nUser: @${userName}\nAmount: ${commission.toFixed(2)} ৳\n<blockquote>(10% from Deposit)</blockquote>`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: refMsg, parse_mode: 'HTML' }).catch(e => {});
            }
            const userMsg = `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (10% Refer): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedExChanger`;
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: userId, text: userMsg, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "Check Wallet 💰", url: "https://t.me/RedExChangerBot/app" }]] }
            });
            return res.json({ success: true });
        } catch (error) { return res.json({ success: false }); }
    }

    if (type === "Exchange") {
        // Exchange fee (set per Exchange Method in Admin Panel) is deducted first,
        // then referral commission (10%) is taken from what remains.
        let bdt = parseFloat(bdtAmount) || 0;
        const feePercent = await getExchangeFeePercent(sendMethod);
        const exchangeFeeAmount = bdt * (feePercent / 100);
        const afterFee = bdt - exchangeFeeAmount;

        let refCommission = 0;
        if (referrerId && afterFee) {
            refCommission = afterFee * 0.10; // ১০% কমিশন হিসাব (fee কাটার পরে remaining amount থেকে)
        }
        let finalBdtAmount = afterFee - refCommission;

        const msg = `Your Exchange Request ${actionText}. ${icon}\n\n` +
                    `Username : @${userName}\n` +
                    `Amount : $${amount} (${bdt.toFixed(2)} ৳)\n` +
                    `Exchange Fee (${feePercent}%) : -${exchangeFeeAmount.toFixed(2)} ৳\n` +
                    `Ref Commission : -${refCommission.toFixed(2)} ৳\n` +
                    `Received : ${finalBdtAmount.toFixed(2)} ৳\n` +
                    `To : ${receiveMethod}\n` +
                    `TrxID : -------------------\n\n` +
                    `@RedExChanger`;
                    
        const keyboard = { inline_keyboard: [[{ text: "CHECK HISTORY 📝", url: "https://t.me/RedExChangerBot/app" }]] };
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard });
            
            // 10% Commission for Exchange and Tracking
            if (status === 'Approved' && referrerId && refCommission > 0) {
                await db.collection('users').doc(String(referrerId)).update({
                    mainBalance: admin.firestore.FieldValue.increment(refCommission),
                    refEarnings: admin.firestore.FieldValue.increment(refCommission)
                });
                
                await db.collection('users').doc(String(userId)).update({
                    commissionGenerated: admin.firestore.FieldValue.increment(refCommission) // Track Commission from this user
                });
                
                const refMsg = `<b>New Exchange Commission Added 💰</b>\nUser: @${userName}\nAmount: ${refCommission.toFixed(2)} ৳\n<blockquote>(10% from Exchange)</blockquote>`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: refMsg, parse_mode: 'HTML' }).catch(e => {});
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


// Admin Notifications 
app.post('/api/notify-deposit', async (req, res) => {
    const { requestId, username, userId, amount, method, number, trx, imageUrl } = req.body;
    const adminMsg = `<b>💰 New Deposit Request</b>\n\n` +
                     `User: @${username || 'N/A'}\n` +
                     `User ID: <code>${userId}</code>\n` +
                     `Amount: ${amount} Tk\n` +
                     `Method: ${method}\n` +
                     `Sender Num: <code>${number}</code>\n` +
                     `TrxID: <code>${trx}</code>`;
    const keyboard = {
        inline_keyboard: [[
            { text: "✅ Approve", callback_data: `act_${requestId}_Approved` },
            { text: "❌ Reject", callback_data: `act_${requestId}_Rejected` }
        ]]
    };
    await sendMessageToTelegram(ADMIN_ID, adminMsg, keyboard, imageUrl);
    res.json({ success: true });
});

app.post('/api/notify-withdraw', async (req, res) => {
    const { requestId, username, userId, amount, method, number } = req.body;
    const adminMsg = `<b>📤 New Withdraw Request</b>\n\n` +
                     `User: @${username || 'N/A'}\n` +
                     `User ID: <code>${userId || 'N/A'}</code>\n` +
                     `Amount: ${amount} Tk\n` +
                     `Method: ${method}\n` +
                     `Receiver Num: <code>${number}</code>`;
    const keyboard = {
        inline_keyboard: [[
            { text: "✅ Approve", callback_data: `act_${requestId}_Approved` },
            { text: "❌ Reject", callback_data: `act_${requestId}_Rejected` }
        ]]
    };             
    await sendMessageToTelegram(ADMIN_ID, adminMsg, keyboard);
    res.json({ success: true });
});

app.post('/api/notify-exchange', async (req, res) => {
    const { requestId, username, firstName, userId, sendMethod, recMethod, number, trx, amount, bdtAmount, imageUrl } = req.body;
    
    try {
        // User এর রেফার আইডি বের করা হচ্ছে
        const userDoc = await db.collection('users').doc(String(userId)).get();
        const referrerId = userDoc.exists ? userDoc.data().referredBy : null;

        const feePercent = await getExchangeFeePercent(sendMethod);
        let bdt = parseFloat(bdtAmount) || 0;
        const exchangeFeeAmount = bdt * (feePercent / 100);
        const afterFee = bdt - exchangeFeeAmount;

        let refCommission = 0;
        if (referrerId && afterFee) {
            refCommission = afterFee * 0.10; // ১০% কমিশন হিসাব (fee কাটার পরে)
        }
        let finalBdt = afterFee - refCommission;

        // ---- Admin notification (Approve/Reject buttons) - unchanged behaviour ----
        const adminMsg = `<b>🔄 New Exchange Request</b>\n\n` +
                         `User: @${username || 'N/A'}\n` +
                         `User ID: <code>${userId}</code>\n` +
                         `Exchange: ${sendMethod} ➔ ${recMethod}\n` +
                         `Amount: $${amount} (${bdt.toFixed(2)} Tk)\n` +
                         `Exchange Fee (${feePercent}%): -${exchangeFeeAmount.toFixed(2)} Tk\n` +
                         `Ref Commission: -${refCommission.toFixed(2)} Tk\n` +
                         `Payable: ${finalBdt.toFixed(2)} Tk\n` +
                         `Payment Num: <code>${number}</code>\n` +
                         `TrxID: <code>${trx}</code>`;
                         
        const keyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `act_${requestId}_Approved` },
                { text: "❌ Reject", callback_data: `act_${requestId}_Rejected` }
            ]]
        };                 
        await sendMessageToTelegram(ADMIN_ID, adminMsg, keyboard, imageUrl);

        // ---- Public Notification Channel/Group (set from Admin Panel Settings) ----
        // Note: Telegram inline buttons cannot be colored via the Bot API — the "Let's Exchange Now"
        // button will use Telegram's default button style, not a custom red color.
        const settings = await getAppSettings();
        const notifyChatId = settings.notifyChatId;
        if (notifyChatId) {
            const groupMsg = `<b>🚨 New Exchange Request</b>\n\n` +
                `Name → <code>${firstName || username || 'User'}</code>\n` +
                `Amount → <code>$${amount}</code>\n` +
                `Pay Amount → <code>${finalBdt.toFixed(2)}৳</code>\n` +
                `Exchange fee → <code>${feePercent}%</code>\n` +
                `Ref Commission → <code>${refCommission.toFixed(2)}৳</code>\n` +
                `Exchange Method → <code>${sendMethod}</code>\n` +
                `Payment Method → <code>${recMethod}</code>\n\n` +
                `<blockquote>এখন খুচরো ডলার বিক্রি করুন সহজে পেমেন্ট নিন বিকাশ/নগদ এ।</blockquote>`;
            const groupKeyboard = { inline_keyboard: [[{ text: "Let's Exchange Now", url: "https://t.me/RedExChangerBot/app?startapp" }]] };
            await sendMessageToTelegram(notifyChatId, groupMsg, groupKeyboard).catch(e => {});
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Notify Exchange Error:", error);
        res.json({ success: false });
    }
});

// Notify New Referral
app.post('/api/notify-refer-join', async (req, res) => {
    const { referrerId, newUserName, firstName } = req.body;
    if (!referrerId) return res.json({ success: false });

    try {
        const referSnap = await db.collection('users').where('referredBy', '==', String(referrerId)).get();
        const referCount = referSnap.size || 1; 

        const rawName = firstName || newUserName || "User";
        const safeName = String(rawName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        const msg = `<b>🆕 New Refer Joined!</b>\n\n` +
                    `Name: ${safeName}\n` +
                    `Total Refer: ${referCount}\n\n` +
                    `<i>You will receive a 10% commission when the person you refer makes a deposit or exchange.</i>`;
                    
        const keyboard = { inline_keyboard: [[{ text: "Open App", url: "https://t.me/RedExChangerBot/app" }]] };

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: referrerId, text: msg, parse_mode: 'HTML', reply_markup: keyboard
        });
        res.json({ success: true });
    } catch (error) { res.json({ success: false }); }
});

// NEW API: Get My Referrals List (WITH PAGINATION AND COMMISSION)
app.get('/api/my-referrals/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const lastId = req.query.lastId;
        const usersRef = db.collection('users');
        
        let q = usersRef.where('referredBy', '==', String(userId)).limit(50);
        
        if (lastId) {
            const lastDoc = await usersRef.doc(lastId).get();
            if (lastDoc.exists) {
                q = q.startAfter(lastDoc);
            }
        }
        
        const snapshot = await q.get();
        
        let referList = [];
        let newLastId = null;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            newLastId = doc.id;
            referList.push({
                id: doc.id,
                name: data.name || data.firstName || data.username || "Unknown",
                photo: data.photo || data.photoUrl || null,
                joinedAt: data.joinedAt || "Recently",
                commission: data.commissionGenerated || 0
            });
        });
        
        res.json({ success: true, list: referList, lastId: newLastId, hasMore: referList.length === 50 });
    } catch (error) {
        console.error("Fetch My Referrals Error:", error);
        res.json({ success: false, list: [] });
    }
});


// Utility to send message with optional keyboard & Image Support
async function sendMessageToTelegram(chatId, text, reply_markup = {}, imageUrl = null) {
    try { 
        if (imageUrl && imageUrl.startsWith('http')) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                chat_id: chatId,
                photo: imageUrl,
                caption: text,
                parse_mode: 'HTML',
                reply_markup: reply_markup
            });
        } else {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { 
                chat_id: chatId, 
                text: text, 
                parse_mode: 'HTML',
                reply_markup: reply_markup
            }); 
        }
    } catch (e) {
        console.error("Admin Notify Error:", e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
