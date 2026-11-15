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
const REFERRAL_COMMISSION_PERCENT = 10; // used consistently in payout logic AND in any message text that mentions the rate
const PARTY_POPPER_EFFECT_ID = "5046509860389126442"; // 🎉 Telegram message effect (private chats only, Bot API 7.2+)
const FIRE_EFFECT_ID = "5104841245755180586"; // 🔥 Telegram message effect (private chats only, Bot API 7.2+)

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

// --- Helper: parse a t.me post link into {chatId, messageId} for forwardMessage ---
// Supports public posts: https://t.me/<username>/<msgId>
// And private channel/group posts (bot must be a member): https://t.me/c/<internalId>/<msgId>
function parseTelegramPostLink(link) {
    if (!link) return null;
    try {
        const url = new URL(link.trim());
        if (!url.hostname.includes('t.me')) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'c' && parts.length >= 3) {
            const internalId = parts[1];
            const msgId = parseInt(parts[2], 10);
            if (!internalId || !msgId) return null;
            return { chatId: `-100${internalId}`, messageId: msgId };
        } else if (parts.length >= 2) {
            const username = parts[0];
            const msgId = parseInt(parts[1], 10);
            if (!username || !msgId) return null;
            return { chatId: `@${username}`, messageId: msgId };
        }
        return null;
    } catch (e) {
        return null;
    }
}

// --- Helper: send something to every user in Firestore with limited concurrency,
// batching requests to stay under Telegram's ~30 messages/second global rate limit,
// and reporting live progress back into a broadcast_history document. ---
async function broadcastToAllUsers(sendOneFn, historyRef) {
    const usersSnapshot = await db.collection('users').get();
    const users = usersSnapshot.docs.map(d => d.id);
    const BATCH_SIZE = 25;
    let success = 0, fail = 0;
    let lastError = null;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(uid => sendOneFn(uid).then(
            () => ({ ok: true }),
            (err) => ({ ok: false, err })
        )));
        results.forEach(r => {
            if (r.ok) { success++; }
            else {
                fail++;
                // Keep the most recent real error message so it's visible in the Admin Panel's
                // Broadcast History (instead of only ever showing "0 success" with no explanation).
                const apiErr = r.err && r.err.response && r.err.response.data && r.err.response.data.description;
                lastError = apiErr || (r.err && r.err.message) || 'Unknown error';
                console.error("Broadcast send failed for a user:", lastError);
            }
        });
        if (historyRef) {
            const update = { successCount: success, failCount: fail, total: users.length };
            if (lastError) update.lastError = lastError;
            await historyRef.update(update).catch(() => {});
        }
        if (i + BATCH_SIZE < users.length) await new Promise(r => setTimeout(r, 1000));
    }
    return { success, fail, total: users.length, lastError };
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

// --- Helper: compute a user's own referral stats (used by both the "New Refer Joined" push
// notification and the on-demand /ref command) ---
// --- Helper: average ৳-per-$ rate across all configured Exchange Methods (no single method is marked
// as "the" reference rate, so this averages all of them). Falls back to 125 if none are configured. ---
async function getAverageBdtRate() {
    const methodsSnap = await db.collection('exchange_methods').get();
    let avgRate = 0;
    if (!methodsSnap.empty) {
        let sum = 0, n = 0;
        methodsSnap.forEach(d => { const r = parseFloat(d.data().rate); if (!isNaN(r) && r > 0) { sum += r; n++; } });
        avgRate = n > 0 ? sum / n : 0;
    }
    return avgRate > 0 ? avgRate : 125; // fallback default
}

async function getReferStats(userId) {
    const referSnap = await db.collection('users').where('referredBy', '==', String(userId)).get();
    const referCount = referSnap.size || 0;

    const userDoc = await db.collection('users').doc(String(userId)).get();
    const refEarnings = userDoc.exists ? (parseFloat(userDoc.data().refEarnings) || 0) : 0;

    // Refer link uses the tracking format (?startapp=<userId>) so shares of it correctly attribute
    // new joins back to this user — same pattern the mini-app's own "My Refer" tab uses.
    const settings = await getAppSettings();
    const botUsername = settings.botUsername || "RedExChangerBot";
    const referLink = `https://t.me/${botUsername}?startapp=${userId}`;

    const bdtRate = await getAverageBdtRate();
    const dollarEquivalent = refEarnings / bdtRate;

    return { referCount, refEarnings, dollarEquivalent, referLink };
}

// --- Helper: send the /ref stats summary on demand ---
async function sendReferStatsCommand(userId) {
    const { referCount, refEarnings, dollarEquivalent, referLink } = await getReferStats(userId);

    const msg = `<b>📊 Your Refer Stats</b>\n\n` +
                `Total Refer: <code>${referCount} User</code>\n` +
                `Total Commission: <code>${refEarnings.toFixed(2)}৳ =${dollarEquivalent.toFixed(2)}$</code>\n` +
                `Refer Link: <code>${referLink}</code>\n\n` +
                `<i>You will receive a ${REFERRAL_COMMISSION_PERCENT}% commission when the person you refer makes a deposit or exchange.</i>`;

    const keyboard = { inline_keyboard: [[{ text: "📋 Copy Refer Link", copy_text: { text: referLink } }]] };

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: userId, text: msg, parse_mode: 'HTML', reply_markup: keyboard,
        message_effect_id: PARTY_POPPER_EFFECT_ID // 🎉 — private chats only
    });
}

// --- Helper: send (or re-send) the welcome message. Deletes the previous welcome message this user
// received (if any) and the message that triggered this call, so repeated /start (or any random
// message — see the webhook's fallback branch) never piles up old welcome messages in the chat. ---
async function sendWelcomeMessage(chatId, triggeringMessageId, firstName) {
    // Delete the previous welcome message, if we have one on record for this chat.
    try {
        const stateDoc = await db.collection('users').doc(String(chatId)).get();
        const prevMsgId = stateDoc.exists ? stateDoc.data().lastWelcomeMsgId : null;
        if (prevMsgId) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: prevMsgId }).catch(() => {});
        }
    } catch (e) {}

    // Delete the message that triggered this (the "/start" text itself, or whatever the user sent).
    if (triggeringMessageId) {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: triggeringMessageId }).catch(() => {});
    }

    const welcomeMsg = `Hi! ${firstName || 'there'} Welcome to RedExChanger.\n\nHere you can exchange your small dollar amounts and receive payment via BKash / Nagad. You can also earn money by completing tasks.\n\nPlus, you’ll get commission by referring others. So don’t waste any time — start earning now!\n\nSupport: @RedExSupportBot`;

    // style: 'danger' (red) / 'success' (green) — real Bot API 9.4+ field (Feb 2026). Needs a Telegram
    // client updated to support it; older clients just show the buttons in their normal default color.
    const keyboard = {
        inline_keyboard: [
            [{ text: "Let's Open Now", url: "https://t.me/RedExChangerBot/app", style: "danger" }],
            [
                { text: "📢 Join Channel", url: "https://t.me/RedExChanger", style: "success" },
                { text: "👥 Join Group", url: "https://t.me/RedExChangerGroup", style: "success" }
            ]
        ]
    };

    const hasStyledButton = keyboard.inline_keyboard.some(row => row.some(b => b.style));
    let sent;
    try {
        sent = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId, text: welcomeMsg, reply_markup: keyboard, parse_mode: 'HTML',
            message_effect_id: FIRE_EFFECT_ID // 🔥 — private chats only
        });
    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        if (hasStyledButton) {
            console.error("Welcome message with styled buttons failed, retrying without style:", detail);
            sent = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: chatId, text: welcomeMsg, reply_markup: stripButtonStyle(keyboard), parse_mode: 'HTML',
                message_effect_id: FIRE_EFFECT_ID
            });
        } else {
            console.error("Welcome message failed:", detail);
            throw err;
        }
    }

    const newMsgId = sent.data && sent.data.result ? sent.data.result.message_id : null;
    if (newMsgId) {
        await db.collection('users').doc(String(chatId)).set({ lastWelcomeMsgId: newMsgId }, { merge: true }).catch(() => {});
    }
}

// =====================================================================================
// BOT ADMIN PANEL  (/admin)  —  everything the web Admin Panel can do, from inside Telegram.
// Only user IDs listed in ADMIN_IDS (comma separated env var; falls back to ADMIN_ID) can use it.
// Menus are inline keyboards; anything that needs typed input uses a small per-admin state
// document in Firestore (admin_state/<userId>) so it survives server restarts.
// =====================================================================================
const ADMIN_IDS = String(process.env.ADMIN_IDS || ADMIN_ID).split(',').map(s => s.trim()).filter(Boolean);
const isOwner = id => ADMIN_IDS.includes(String(id));   // env-configured; only owners can add/remove admins from the bot
let dynamicAdminIds = new Set();                          // admins added via web panel / bot (Firestore: bot_admins/<telegramId>)
const isAdmin = id => isOwner(id) || dynamicAdminIds.has(String(id));
async function refreshAdminCache() {
    try { const s = await db.collection('bot_admins').get(); dynamicAdminIds = new Set(s.docs.map(d => d.id)); }
    catch (e) { console.error('Admin cache refresh failed:', e.message); }
}
refreshAdminCache();
setInterval(refreshAdminCache, 30000); // picks up admins added/removed from the web panel within 30s

// Request notifications (with Approve/Reject buttons) go to the main ADMIN_ID and every added admin.
async function notifyAdmins(text, kb, imageUrl) {
    const targets = new Set([String(ADMIN_ID), ...dynamicAdminIds]);
    await Promise.all([...targets].map(t => sendMessageToTelegram(t, text, kb, imageUrl)));
}

const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tsMs = t => (t && typeof t.toMillis === 'function') ? t.toMillis() : 0;
const fmtDate = ms => ms ? new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true }) : '-';
const tgErr = e => (e && e.response && e.response.data && e.response.data.description) || (e && e.message) || 'Unknown error';
const B = (text, data, style) => style ? { text, callback_data: data, style } : { text, callback_data: data };
const KB = rows => ({ inline_keyboard: rows });
const selfApi = (path, body) => axios.post(`http://127.0.0.1:${process.env.PORT || 3000}${path}`, body).then(r => r.data);

// Telegram call with automatic retry-without-color if a styled button is rejected.
async function tg(method, payload) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    try {
        return (await axios.post(url, payload)).data;
    } catch (e) {
        const mk = payload.reply_markup;
        if (mk && mk.inline_keyboard && mk.inline_keyboard.some(r => r.some(b => b.style))) {
            return (await axios.post(url, { ...payload, reply_markup: stripButtonStyle(mk) })).data;
        }
        throw e;
    }
}

const adminSend = (chatId, text, kb) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });

// Edit the menu message in place when we can, otherwise send a fresh one.
async function adminShow(ctx, text, kb) {
    if (ctx.msgId) {
        try {
            await tg('editMessageText', { chat_id: ctx.chatId, message_id: ctx.msgId, text, parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
            return;
        } catch (e) {
            if (/not modified/i.test(tgErr(e))) return;
        }
    }
    await adminSend(ctx.chatId, text, kb);
}

// ---------- per-admin conversation state ----------
const adminStateRef = id => db.collection('admin_state').doc(String(id));
async function getAdminState(id) { const s = await adminStateRef(id).get(); return s.exists ? s.data() : null; }
const setAdminState = (id, st) => adminStateRef(id).set(st);
const clearAdminState = id => adminStateRef(id).delete().catch(() => {});

// ---------- image helper: Telegram photo -> public URL (needs IMGBB_API_KEY env) ----------
async function telegramFileToImgbbUrl(fileId) {
    const key = process.env.IMGBB_API_KEY;
    if (!key) throw new Error('IMGBB_API_KEY env variable সেট করা নেই');
    const f = await tg('getFile', { file_id: fileId });
    const bin = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`, { responseType: 'arraybuffer' });
    const body = new URLSearchParams();
    body.append('image', Buffer.from(bin.data).toString('base64'));
    const r = await axios.post(`https://api.imgbb.com/1/upload?key=${key}`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, maxBodyLength: Infinity, maxContentLength: Infinity
    });
    if (!r.data || !r.data.success) throw new Error('imgbb upload failed');
    return r.data.data.url;
}

// ---------- field definitions (mirror the web panel forms) ----------
const ADM_COLLS = {
    exm: { col: 'exchange_methods', title: 'Exchange Methods', back: 'adm:mt',
        label: d => `${d.name} | ${d.rate}৳ | fee ${d.fee || 0}%`,
        fields: [
            { k: 'name', l: 'Name' },
            { k: 'image', l: 'Image', t: 'image', opt: true },
            { k: 'wallet', l: 'Wallet Address' },
            { k: 'rate', l: 'Rate (৳ per $)', t: 'number' },
            { k: 'min', l: 'Min Amount ($)', t: 'number' },
            { k: 'fee', l: 'Exchange Fee %', t: 'number', opt: true, def: 0 }
        ] },
    dpm: { col: 'deposit_methods', title: 'Deposit Methods', back: 'adm:mt',
        label: d => `${d.name} | ${d.number}`,
        fields: [
            { k: 'name', l: 'Name' },
            { k: 'image', l: 'Image', t: 'image', opt: true },
            { k: 'number', l: 'Number' },
            { k: 'minAmount', l: 'Min Amount (৳)', t: 'number' }
        ] },
    tsk: { col: 'tasks', title: 'Tasks', back: 'adm:home', sort: 'createdAt',
        label: d => `${d.type} | ${d.caption} | ${d.completedCount || 0}/${d.targetCount}`,
        fields: [
            { k: 'caption', l: 'Title' },
            { k: 'type', l: 'Type', t: 'choice', opts: ['Link', 'Channel'] },
            { k: 'image', l: 'Image', t: 'image', opt: true },
            { k: 'link', l: 'Link (or @channel for Channel type)' },
            { k: 'reward', l: 'Reward (৳)', t: 'number' },
            { k: 'targetCount', l: 'Limit (users)', t: 'number', int: true }
        ] },
    ban: { col: 'banners', title: 'Banners', back: 'adm:ct',
        label: d => d.btnText || 'Banner',
        fields: [
            { k: 'image', l: 'Image', t: 'image' },
            { k: 'link', l: 'Link' },
            { k: 'btnText', l: 'Button Text' }
        ] },
    off: { col: 'offers', title: 'Offers', back: 'adm:ct',
        label: d => d.title,
        fields: [
            { k: 'title', l: 'Title' },
            { k: 'image', l: 'Image', t: 'image' },
            { k: 'link', l: 'Link' }
        ] },
    ads: { col: 'adScripts', title: 'Popup Ads', back: 'adm:home',
        label: d => `Script: ${String(d.script || '').substring(0, 30)}`,
        fields: [{ k: 'script', l: 'Script' }] }
};

const SETTINGS_FIELDS = [
    { k: 'botUsername', l: 'Bot Username' },
    { k: 'loadingImage', l: 'Loading Image', t: 'image' },
    { k: 'requiredChannel', l: 'Required Channel' },
    { k: 'supportLink', l: 'Support Link' },
    { k: 'withdrawStatus', l: 'Withdraw', t: 'bool' },
    { k: 'minWithdrawAmount', l: 'Min Withdraw', t: 'number' },
    { k: 'notifyChatId', l: 'Notification Chat ID' },
    { k: 'coinUpdateEnabled', l: 'Coin Price Update', t: 'bool' },
    { k: 'coinUpdateIntervalMinutes', l: 'Coin Interval (min)', t: 'number' },
    { k: 'coinSymbols', l: 'Coin Symbols' },
    { k: 'coinUpdateChatId', l: 'Coin Update Chat ID' }
];

// Parses one typed/sent value for a field. allowClear: "-" sets a text/image field to empty.
async function parseFieldInput(field, m, allowClear) {
    const t = field.t || 'text';
    const txt = (m.text || '').trim();
    if (t === 'image') {
        if (m.photo && m.photo.length) {
            try { return { value: await telegramFileToImgbbUrl(m.photo[m.photo.length - 1].file_id) }; }
            catch (e) { return { error: `Photo upload হয়নি: ${tgErr(e)}\nএকটি Image URL (https://...) পাঠান।` }; }
        }
        if (allowClear && txt === '-') return { value: '' };
        if (/^https?:\/\//i.test(txt)) return { value: txt };
        return { error: 'Image URL (https://...) অথবা একটি photo পাঠান।' };
    }
    if (!txt) return { error: 'Text পাঠান।' };
    if (t === 'number') {
        const n = parseFloat(txt);
        if (isNaN(n)) return { error: 'শুধু সংখ্যা পাঠান।' };
        return { value: field.int ? Math.trunc(n) : n };
    }
    if (allowClear && txt === '-') return { value: '' };
    return { value: txt };
}

// ---------- main menu ----------
async function showMainMenu(ctx) {
    await adminShow(ctx, '<b>Admin Panel</b>\nসব Action এখান থেকে করুন।', KB([
        [B('Stats', 'adm:stats'), B('Requests', 'adm:rq')],
        [B('Tasks', 'adm:l:tsk:0'), B('Broadcast', 'adm:bc')],
        [B('Methods', 'adm:mt'), B('Settings', 'adm:set')],
        [B('Content', 'adm:ct'), B('Popup Ads', 'adm:l:ads:0')],
        [B('Users', 'adm:us'), B('Admins', 'adm:ad')]
    ]));
}

// ---------- stats ----------
async function countQuery(q) {
    try { return (await q.count().get()).data().count; }
    catch (e) { return (await q.get()).size; }
}

async function admShowStats(ctx) {
    const pend = await db.collection('requests').where('status', '==', 'Pending').get();
    let ex = 0, dep = 0, wit = 0;
    pend.forEach(d => { const t = d.data().type; if (t === 'Withdraw') wit++; else if (t === 'Deposit') dep++; else ex++; });

    const T = admin.firestore.Timestamp;
    const total = await countQuery(db.collection('users'));
    const new7 = await countQuery(db.collection('users').where('joined', '>=', T.fromMillis(Date.now() - 7 * 86400000)));
    const banned = await countQuery(db.collection('users').where('banned', '==', true));
    const recent = await db.collection('requests').where('date', '>=', T.fromMillis(Date.now() - 30 * 86400000)).get();
    const active = new Set(); recent.forEach(d => { const u = d.data().userId; if (u) active.add(u); });

    await adminShow(ctx,
        `<b>Stats</b>\n\n` +
        `Pending Exchange: <b>${ex}</b>\nPending Deposit: <b>${dep}</b>\nPending Withdraw: <b>${wit}</b>\n\n` +
        `Total Users: <b>${total}</b>\nJoined (last 7 days): <b>${new7}</b>\nActive (30 days, requested at least once): <b>${active.size}</b>\nBanned: <b>${banned}</b>`,
        KB([[B('Refresh', 'adm:stats')], [B('Main Menu', 'adm:home')]]));
}

// ---------- requests ----------
async function admShowRequestsMenu(ctx) {
    const pend = await db.collection('requests').where('status', '==', 'Pending').get();
    let ex = 0, dep = 0, wit = 0;
    pend.forEach(d => { const t = d.data().type; if (t === 'Withdraw') wit++; else if (t === 'Deposit') dep++; else ex++; });
    await adminShow(ctx, '<b>Requests</b>\nPending request দেখতে ট্যাপ করুন।', KB([
        [B(`Exchange (${ex})`, 'adm:rl:Exchange'), B(`Deposit (${dep})`, 'adm:rl:Deposit')],
        [B(`Withdraw (${wit})`, 'adm:rl:Withdraw')],
        [B('Recent Processed', 'adm:rp')],
        [B('Main Menu', 'adm:home')]
    ]));
}

async function admFormatRequest(r) {
    const name = esc(r.userName || 'N/A');
    if (r.type === 'Withdraw') {
        return `<b>Withdraw Request</b>\n\nUser: ${name}\nUser ID: <code>${esc(r.userId)}</code>\nMethod: ${esc(r.method)}\nNumber: <code>${esc(r.userNumber)}</code>\nAmount: ${esc(r.amount)} Tk\nRefs: ${r.totalReferrals || 0} | Tasks: ${r.completedTasks || 0}`;
    }
    if (r.type === 'Deposit') {
        return `<b>Deposit Request</b>\n\nUser: ${name}\nUser ID: <code>${esc(r.userId)}</code>\nMethod: ${esc(r.method)}\nAmount: ${esc(r.amount)} Tk\nTrxID: <code>${esc(r.trxId || 'N/A')}</code>`;
    }
    const bdt = parseFloat(r.bdtAmount) || 0;
    const fee = await getExchangeFeePercent(r.sendMethod);
    const feeAmt = bdt * fee / 100;
    const ref = r.referrerId ? (bdt - feeAmt) * REFERRAL_COMMISSION_PERCENT / 100 : 0;
    return `<b>Exchange Request</b>\n\nUser: ${name}\nUser ID: <code>${esc(r.userId)}</code>\nExchange: ${esc(r.sendMethod)} -> ${esc(r.receiveMethod)}\n` +
           `Amount: $${esc(r.amount)} (${bdt.toFixed(2)} Tk)\nExchange Fee (${fee}%): -${feeAmt.toFixed(2)} Tk\nRef Commission: -${ref.toFixed(2)} Tk\n` +
           `Payable: ${(bdt - feeAmt - ref).toFixed(2)} Tk\nPayment Num: <code>${esc(r.userNumber)}</code>\nTrxID: <code>${esc(r.trxId || 'N/A')}</code>`;
}

async function admSendPending(chatId, type) {
    const snap = await db.collection('requests').where('type', '==', type).where('status', '==', 'Pending').get();
    const docs = snap.docs.sort((a, b) => tsMs(a.data().date) - tsMs(b.data().date)).slice(0, 10);
    const back = KB([[B('Requests', 'adm:rq'), B('Main Menu', 'adm:home')]]);
    if (!docs.length) { await adminSend(chatId, `Pending ${type} request নেই।`, back); return; }
    await adminSend(chatId, `<b>Pending ${type}: ${snap.size}</b>${snap.size > docs.length ? ` (পুরনো ${docs.length}টি দেখানো হচ্ছে)` : ''}`);
    for (const d of docs) {
        const r = d.data();
        const text = await admFormatRequest(r);
        const kb = KB([[B('Approve', `act_${d.id}_Approved`, 'success'), B('Reject', `act_${d.id}_Rejected`, 'danger')]]);
        try {
            if (r.imageUrl && /^https?:\/\//i.test(r.imageUrl)) {
                await tg('sendPhoto', { chat_id: chatId, photo: r.imageUrl, caption: text, parse_mode: 'HTML', reply_markup: kb });
                continue;
            }
        } catch (e) { /* bad screenshot URL — fall back to text */ }
        await adminSend(chatId, text, kb);
    }
    await adminSend(chatId, 'শেষ।', back);
}

async function admShowProcessed(ctx) {
    const snap = await db.collection('requests').orderBy('date', 'desc').limit(40).get();
    const items = snap.docs.filter(d => d.data().status !== 'Pending').slice(0, 10);
    if (!items.length) { await adminShow(ctx, 'Processed request নেই।', KB([[B('Back', 'adm:rq')]])); return; }
    let text = '<b>Recent Processed</b>\n\n';
    const rows = []; let row = [];
    items.forEach((d, i) => {
        const r = d.data();
        text += `${i + 1}. ${esc(r.type)} | ${esc(r.userName)} | ${esc(r.amount)} | <b>${esc(r.status)}</b>\n`;
        row.push(B(`Delete ${i + 1}`, `adm:dr:${d.id}`));
        if (row.length === 2) { rows.push(row); row = []; }
    });
    if (row.length) rows.push(row);
    rows.push([B('Back', 'adm:rq')]);
    await adminShow(ctx, text, KB(rows));
}

// ---------- generic list / view / add / edit / delete ----------
async function admListColl(ctx, key, page) {
    const cfg = ADM_COLLS[key];
    const snap = await db.collection(cfg.col).get();
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (cfg.sort === 'createdAt') items.sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
    const PS = 8, pages = Math.max(1, Math.ceil(items.length / PS));
    page = Math.min(Math.max(0, page), pages - 1);
    const rows = items.slice(page * PS, page * PS + PS).map(it => {
        let label; try { label = String(cfg.label(it)); } catch (e) { label = '(item)'; }
        return [B(label.substring(0, 60), `adm:v:${key}:${it.id}`)];
    });
    const nav = [];
    if (page > 0) nav.push(B('Prev', `adm:l:${key}:${page - 1}`));
    if (page < pages - 1) nav.push(B('Next', `adm:l:${key}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([B('Add New', `adm:a:${key}`, 'success')]);
    rows.push([B('Back', cfg.back)]);
    await adminShow(ctx, `<b>${cfg.title}</b> (${items.length})\nPage ${page + 1}/${pages}`, KB(rows));
}

async function admViewItem(ctx, key, id) {
    const cfg = ADM_COLLS[key];
    const snap = await db.collection(cfg.col).doc(id).get();
    if (!snap.exists) { await adminShow(ctx, 'Item পাওয়া যায়নি।', KB([[B('Back', `adm:l:${key}:0`)]])); return; }
    const d = snap.data();
    let text = `<b>${esc(cfg.title)}</b>\n\n`;
    cfg.fields.forEach(f => { text += `${esc(f.l)}: <code>${esc(String(d[f.k] === undefined ? '' : d[f.k]).substring(0, 300))}</code>\n`; });
    if (key === 'tsk') text += `Done: ${d.completedCount || 0}/${d.targetCount}\nCreator: ${esc(d.creatorName || d.creatorId || 'Admin')}\n`;
    const rows = []; let row = [];
    cfg.fields.forEach((f, i) => {
        row.push(B(`Edit ${f.l}`.substring(0, 28), `adm:e:${key}:${id}:${i}`));
        if (row.length === 2) { rows.push(row); row = []; }
    });
    if (row.length) rows.push(row);
    if (key === 'tsk' && d.creatorId) rows.push([B('Ban Creator', `adm:ub:${d.creatorId}:1`, 'danger')]);
    rows.push([B('Delete', `adm:d:${key}:${id}`, 'danger')]);
    rows.push([B('Back to list', `adm:l:${key}:0`)]);
    await adminShow(ctx, text, KB(rows));
}

async function admAskAddStep(chatId, st) {
    const cfg = ADM_COLLS[st.key], f = cfg.fields[st.step];
    const n = `${st.step + 1}/${cfg.fields.length}`;
    if (f.t === 'choice') {
        const rows = f.opts.map((o, i) => [B(o, `adm:ac:${i}`)]);
        rows.push([B('Cancel', 'adm:cancel')]);
        await adminSend(chatId, `<b>Add ${esc(cfg.title)}</b> (${n})\n<b>${esc(f.l)}</b> সিলেক্ট করুন:`, KB(rows));
        return;
    }
    let hint = f.t === 'image' ? ' (image URL বা photo)' : f.t === 'number' ? ' (সংখ্যা)' : '';
    if (f.opt) hint += '\n/skip দিয়ে এড়িয়ে যান';
    await adminSend(chatId, `<b>Add ${esc(cfg.title)}</b> (${n})\n<b>${esc(f.l)}</b> পাঠান${hint}\n\n/cancel দিয়ে বাতিল`);
}

async function admAddAdvance(chatId, uid, st, value) {
    const cfg = ADM_COLLS[st.key], f = cfg.fields[st.step];
    st.data[f.k] = value; st.step++;
    if (st.step < cfg.fields.length) { await setAdminState(uid, st); await admAskAddStep(chatId, st); return; }

    const docData = { ...st.data };
    if (st.key === 'tsk') Object.assign(docData, { completedCount: 0, completedBy: [], active: true, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    const ref = await db.collection(cfg.col).add(docData);
    await clearAdminState(uid);
    let extra = '';
    if (st.key === 'tsk') {
        selfApi('/api/broadcast-task', { caption: docData.caption, target: docData.targetCount, reward: docData.reward }).catch(() => {});
        extra = '\nTask broadcast ইউজারদের কাছে পাঠানো শুরু হয়েছে।';
    }
    await adminSend(chatId, `Added successfully.${extra}`, KB([[B('View', `adm:v:${st.key}:${ref.id}`), B('List', `adm:l:${st.key}:0`)], [B('Main Menu', 'adm:home')]]));
}

// ---------- settings ----------
async function admShowSettings(ctx) {
    const s = await getAppSettings();
    const rows = SETTINGS_FIELDS.map((f, i) => {
        let v = s[f.k];
        if (f.t === 'bool') v = v ? 'ON' : 'OFF';
        v = (v === undefined || v === '' || v === null) ? '-' : String(v);
        return [B(`${f.l}: ${v}`.substring(0, 60), `adm:sf:${i}`)];
    });
    rows.push([B('Main Menu', 'adm:home')]);
    await adminShow(ctx, '<b>Settings</b>\nযেটা বদলাতে চান সেটায় ট্যাপ করুন।', KB(rows));
}
const admSetSetting = (k, v) => db.collection('settings').doc('appConfig').set({ [k]: v }, { merge: true });

// ---------- users ----------
async function admShowUser(ctx, uid) {
    const s = await db.collection('users').doc(String(uid)).get();
    if (!s.exists) { await adminShow(ctx, `User <code>${esc(uid)}</code> পাওয়া যায়নি।`, KB([[B('Users', 'adm:us')]])); return; }
    const d = s.data();
    await adminShow(ctx,
        `<b>User Info</b>\n\nName: ${esc(d.name)}\nUsername: ${esc(d.username || '-')}\nID: <code>${esc(uid)}</code>\n` +
        `Balance: ${(parseFloat(d.mainBalance) || 0).toFixed(2)} Tk\nReferrals: ${d.referrals || 0}\nRef Earnings: ${(parseFloat(d.refEarnings) || 0).toFixed(2)} Tk\n` +
        `Referred By: ${esc(d.referredBy || '-')}\nJoined: ${fmtDate(tsMs(d.joined))}\nBanned: <b>${d.banned ? 'YES' : 'NO'}</b>`,
        KB([[d.banned ? B('Unban', `adm:ub:${uid}:0`, 'success') : B('Ban', `adm:ub:${uid}:1`, 'danger')], [B('Users', 'adm:us'), B('Main Menu', 'adm:home')]]));
}

// ---------- admins (owners only) ----------
async function admShowAdmins(ctx) {
    const snap = await db.collection('bot_admins').get();
    let text = `<b>Admins</b>\n\nOwners (server env): ${ADMIN_IDS.map(i => `<code>${esc(i)}</code>`).join(', ')}\n\nAdded admins:\n`;
    const rows = [];
    snap.docs.forEach(d => {
        const x = d.data();
        text += `<code>${esc(d.id)}</code> ${esc(x.name || '')}\n`;
        rows.push([B(`Remove ${d.id}`, `adm:adr:${d.id}`, 'danger')]);
    });
    if (snap.empty) text += '-\n';
    rows.push([B('Add Admin', 'adm:ada', 'success')]);
    rows.push([B('Main Menu', 'adm:home')]);
    await adminShow(ctx, text, KB(rows));
}

// ---------- broadcast ----------
const COLOR_MAP = { blue: 'primary', green: 'success', red: 'danger' };

function parseBroadcastButtons(txt) {
    const out = [];
    for (const line of txt.split('\n').map(l => l.trim()).filter(Boolean)) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 2 || !parts[0] || !parts[1]) return { error: `ভুল লাইন: ${line}` };
        let url = parts[1];
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        const btn = { text: parts[0], url };
        if (parts[2]) {
            const c = COLOR_MAP[parts[2].toLowerCase()];
            if (!c) return { error: `Color শুধু blue / green / red হতে পারে: ${line}` };
            btn.style = c;
        }
        out.push(btn);
    }
    return { buttons: out };
}

async function admBroadcastPreview(chatId, data) {
    const markup = (data.buttons && data.buttons.length) ? KB(data.buttons.map(b => [{ text: b.text, url: b.url, ...(b.style ? { style: b.style } : {}) }])) : undefined;
    try {
        if (data.image) await tg('sendPhoto', { chat_id: chatId, photo: data.image, caption: data.text || '', parse_mode: 'HTML', reply_markup: markup });
        else await tg('sendMessage', { chat_id: chatId, text: data.text, parse_mode: 'HTML', reply_markup: markup });
    } catch (e) {
        await adminSend(chatId, `Preview পাঠানো যায়নি: ${esc(tgErr(e))}\n\nContent ঠিক করে /admin → Broadcast থেকে আবার শুরু করুন।`, KB([[B('Main Menu', 'adm:home')]]));
        return false;
    }
    await adminSend(chatId, `উপরের মেসেজটি <b>সব ইউজারকে</b> পাঠানো হবে।\nPin All User: <b>${data.pinAll ? 'ON' : 'OFF'}</b>`,
        KB([[B('Send to All', 'adm:bs', 'success'), B('Cancel', 'adm:cancel', 'danger')]]));
    return true;
}

async function admShowHistory(ctx) {
    const snap = await db.collection('broadcast_history').orderBy('createdAt', 'desc').limit(10).get();
    if (snap.empty) { await adminShow(ctx, 'Broadcast history নেই।', KB([[B('Back', 'adm:bc')]])); return; }
    let text = '<b>Broadcast History</b>\n\n';
    const rows = [];
    snap.docs.forEach((d, i) => {
        const b = d.data();
        const what = b.type === 'forward' ? `Forward: ${b.postLink || ''}` : (b.text ? b.text.substring(0, 30) : 'Image only');
        text += `${i + 1}. [${esc(b.type || 'message')}] ${esc(b.status || 'done')} | ok ${b.successCount || 0} / fail ${b.failCount || 0}${b.total ? ' / ' + b.total : ''}\n${esc(what)}\n${fmtDate(tsMs(b.createdAt))}\n`;
        if (b.lastError) text += `Error: ${esc(String(b.lastError).substring(0, 80))}\n`;
        text += '\n';
        rows.push([B(`Resend ${i + 1}`, `adm:br:${d.id}`), B(`Delete ${i + 1}`, `adm:bd:${d.id}`, 'danger')]);
    });
    rows.push([B('Refresh', 'adm:bh'), B('Back', 'adm:bc')]);
    await adminShow(ctx, text, KB(rows));
}

// ---------- typed-input processor ----------
async function admProcessInput(m, st, txt, cmd) {
    const chatId = m.chat.id, uid = m.from.id;

    if (st.mode === 'add') {
        const f = ADM_COLLS[st.key].fields[st.step];
        if (f.t === 'choice') { await adminSend(chatId, 'উপরের বাটন থেকে সিলেক্ট করুন।'); return; }
        let value;
        if (cmd === '/skip') {
            if (!f.opt) { await adminSend(chatId, 'এই ফিল্ডটি skip করা যাবে না।'); return; }
            value = f.def !== undefined ? f.def : '';
        } else {
            const r = await parseFieldInput(f, m, false);
            if (r.error) { await adminSend(chatId, esc(r.error)); return; }
            value = r.value;
        }
        await admAddAdvance(chatId, uid, st, value);
        return;
    }

    if (st.mode === 'edit') {
        const cfg = ADM_COLLS[st.key], f = cfg.fields[st.idx];
        const r = await parseFieldInput(f, m, true);
        if (r.error) { await adminSend(chatId, esc(r.error)); return; }
        await db.collection(cfg.col).doc(st.docId).update({ [f.k]: r.value });
        await clearAdminState(uid);
        await adminSend(chatId, 'Updated.');
        await admViewItem({ chatId }, st.key, st.docId);
        return;
    }

    if (st.mode === 'setting') {
        const f = SETTINGS_FIELDS[st.idx];
        const r = await parseFieldInput(f, m, true);
        if (r.error) { await adminSend(chatId, esc(r.error)); return; }
        await admSetSetting(f.k, r.value);
        await clearAdminState(uid);
        await adminSend(chatId, 'Saved.');
        await admShowSettings({ chatId });
        return;
    }

    if (st.mode === 'addadmin') {
        if (!isOwner(uid)) { await clearAdminState(uid); await adminSend(chatId, 'শুধু Owner Admin যোগ করতে পারবে।'); return; }
        if (!/^\d+$/.test(txt)) { await adminSend(chatId, 'শুধু সংখ্যার Chat ID (User ID) পাঠান।'); return; }
        if (isOwner(txt)) { await adminSend(chatId, 'এই ID আগে থেকেই Owner।'); return; }
        let name = '';
        try { const c = await tg('getChat', { chat_id: txt }); const r = c.result || {}; name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || ''; } catch (e) { /* user hasn't started the bot yet */ }
        await db.collection('bot_admins').doc(txt).set({ name, addedBy: String(uid), addedAt: admin.firestore.FieldValue.serverTimestamp() });
        dynamicAdminIds.add(txt);
        await clearAdminState(uid);
        const noted = await adminSend(txt, 'আপনাকে Admin করা হয়েছে। Admin Panel খুলতে /admin পাঠান।').then(() => true, () => false);
        await adminSend(chatId, `Admin যোগ হয়েছে: <code>${esc(txt)}</code> ${esc(name)}${noted ? '' : '\n(সতর্কতা: ওই ইউজার এখনো বটে /start দেননি, তাই মেসেজ পাঠানো যায়নি। বট ওপেন করে /start দিলে তবেই /admin কাজ করবে।)'}`);
        await admShowAdmins({ chatId });
        return;
    }

    if (st.mode === 'user') {
        if (!/^\d+$/.test(txt)) { await adminSend(chatId, 'শুধু সংখ্যার User ID পাঠান।'); return; }
        await clearAdminState(uid);
        await admShowUser({ chatId }, txt);
        return;
    }

    if (st.mode === 'bc') {
        if (st.step === 'content') {
            let image = '', text = '';
            if (m.photo && m.photo.length) { image = m.photo[m.photo.length - 1].file_id; text = m.caption || ''; }
            else text = m.text || '';
            if (!text && !image) { await adminSend(chatId, 'Text অথবা caption সহ photo পাঠান।'); return; }
            st.data = { image, text, buttons: [], pinAll: false }; st.step = 'buttons';
            await setAdminState(uid, st);
            await adminSend(chatId, '<b>Inline Buttons</b> (ঐচ্ছিক)\nপ্রতি লাইনে একটি বাটন:\n<code>Text | URL</code>\nরঙসহ: <code>Text | URL | green</code> (blue / green / red)\n\nবাটন না লাগলে /skip');
            return;
        }
        if (st.step === 'buttons') {
            if (cmd !== '/skip') {
                const r = parseBroadcastButtons(txt);
                if (r.error) { await adminSend(chatId, esc(r.error)); return; }
                st.data.buttons = r.buttons;
            }
            st.step = 'pin'; await setAdminState(uid, st);
            await adminSend(chatId, 'সব ইউজারের চ্যাটে মেসেজটি <b>Pin</b> করবেন?', KB([[B('Pin: ON', 'adm:bp:1'), B('Pin: OFF', 'adm:bp:0')]]));
            return;
        }
        await adminSend(chatId, 'উপরের বাটন ব্যবহার করুন, অথবা /cancel।');
        return;
    }

    if (st.mode === 'fw') {
        if (st.step === 'link') {
            if (!parseTelegramPostLink(txt)) { await adminSend(chatId, 'সঠিক Post Link দিন:\n<code>https://t.me/channelname/123</code>\nঅথবা private: <code>https://t.me/c/1234567890/123</code>'); return; }
            st.data = { postLink: txt, pinAll: false }; st.step = 'pin'; await setAdminState(uid, st);
            await adminSend(chatId, 'সব ইউজারের চ্যাটে Pin করবেন?', KB([[B('Pin: ON', 'adm:fp:1'), B('Pin: OFF', 'adm:fp:0')]]));
            return;
        }
        await adminSend(chatId, 'উপরের বাটন ব্যবহার করুন, অথবা /cancel।');
        return;
    }
}

// ---------- message entry point (admins in private chat only) ----------
async function adminHandleMessage(m) {
    const chatId = m.chat.id, uid = m.from.id;
    const txt = (m.text || '').trim();
    const cmd = txt.split('@')[0].split(' ')[0];

    if (cmd === '/admin') { await clearAdminState(uid); await showMainMenu({ chatId }); return true; }

    const st = await getAdminState(uid);
    if (cmd === '/cancel') {
        if (!st) return false;
        await clearAdminState(uid);
        await adminSend(chatId, 'Cancelled.', KB([[B('Main Menu', 'adm:home')]]));
        return true;
    }
    if (!st) return false;
    if (txt.startsWith('/') && cmd !== '/skip') return false; // other commands (/start, /ping, /ref) still work

    try { await admProcessInput(m, st, txt, cmd); }
    catch (e) { console.error('Admin input error:', tgErr(e)); await adminSend(chatId, `Error: ${esc(tgErr(e))}`).catch(() => {}); }
    return true;
}

// ---------- callback entry point ----------
async function adminHandleCallback(cbq) {
    const chatId = cbq.message.chat.id, ctx = { chatId, msgId: cbq.message.message_id }, uid = cbq.from.id;
    const p = String(cbq.data).split(':');
    const a = p[1];
    let toast = '';
    const needState = async mode => { const st = await getAdminState(uid); if (!st || st.mode !== mode) { toast = 'Session শেষ — /admin দিয়ে আবার শুরু করুন'; return null; } return st; };

    try {
        switch (a) {
            case 'home': await clearAdminState(uid); await showMainMenu(ctx); break;
            case 'cancel': await clearAdminState(uid); await showMainMenu(ctx); toast = 'Cancelled'; break;
            case 'stats': await admShowStats(ctx); break;

            case 'rq': await admShowRequestsMenu(ctx); break;
            case 'rl': await admSendPending(chatId, p[2]); break;
            case 'rp': await admShowProcessed(ctx); break;
            case 'dr': await db.collection('requests').doc(p[2]).delete(); toast = 'Deleted'; await admShowProcessed(ctx); break;

            case 'mt': await adminShow(ctx, '<b>Methods</b>', KB([[B('Exchange Methods', 'adm:l:exm:0')], [B('Deposit Methods', 'adm:l:dpm:0')], [B('Main Menu', 'adm:home')]])); break;
            case 'ct': await adminShow(ctx, '<b>Content</b>', KB([[B('Banners', 'adm:l:ban:0')], [B('Offers', 'adm:l:off:0')], [B('Main Menu', 'adm:home')]])); break;

            case 'l': await admListColl(ctx, p[2], parseInt(p[3], 10) || 0); break;
            case 'v': await admViewItem(ctx, p[2], p[3]); break;

            case 'a': {
                const st = { mode: 'add', key: p[2], step: 0, data: {} };
                await setAdminState(uid, st); await admAskAddStep(chatId, st); break;
            }
            case 'ac': {
                const st = await needState('add'); if (!st) break;
                const f = ADM_COLLS[st.key].fields[st.step];
                if (f.t !== 'choice' || !f.opts[parseInt(p[2], 10)]) { toast = 'Invalid'; break; }
                await admAddAdvance(chatId, uid, st, f.opts[parseInt(p[2], 10)]); break;
            }
            case 'e': {
                const cfg = ADM_COLLS[p[2]], idx = parseInt(p[4], 10), f = cfg.fields[idx];
                if (f.t === 'choice') {
                    const rows = f.opts.map((o, i) => [B(o, `adm:ec:${p[2]}:${p[3]}:${idx}:${i}`)]);
                    rows.push([B('Cancel', `adm:v:${p[2]}:${p[3]}`)]);
                    await adminShow(ctx, `<b>${esc(f.l)}</b> সিলেক্ট করুন:`, KB(rows)); break;
                }
                const snap = await db.collection(cfg.col).doc(p[3]).get();
                const cur = snap.exists && snap.data()[f.k] !== undefined ? String(snap.data()[f.k]).substring(0, 300) : '';
                await setAdminState(uid, { mode: 'edit', key: p[2], docId: p[3], idx });
                await adminSend(chatId, `<b>${esc(f.l)}</b>-এর নতুন মান পাঠান${f.t === 'image' ? ' (URL বা photo)' : ''}\nCurrent: <code>${esc(cur)}</code>\n${f.t === 'number' ? '' : '"-" পাঠালে ফাঁকা হবে\n'}/cancel দিয়ে বাতিল`);
                break;
            }
            case 'ec': {
                const cfg = ADM_COLLS[p[2]], f = cfg.fields[parseInt(p[4], 10)], val = f.opts[parseInt(p[5], 10)];
                await db.collection(cfg.col).doc(p[3]).update({ [f.k]: val }); toast = 'Updated';
                await admViewItem(ctx, p[2], p[3]); break;
            }
            case 'd': await adminShow(ctx, 'নিশ্চিতভাবে Delete করবেন?', KB([[B('Yes, Delete', `adm:dy:${p[2]}:${p[3]}`, 'danger'), B('Cancel', `adm:v:${p[2]}:${p[3]}`)]])); break;
            case 'dy': await db.collection(ADM_COLLS[p[2]].col).doc(p[3]).delete(); toast = 'Deleted'; await admListColl(ctx, p[2], 0); break;

            case 'set': await admShowSettings(ctx); break;
            case 'sf': {
                const idx = parseInt(p[2], 10), f = SETTINGS_FIELDS[idx];
                if (f.t === 'bool') {
                    const s = await getAppSettings();
                    await admSetSetting(f.k, !s[f.k]); toast = `${f.l}: ${!s[f.k] ? 'ON' : 'OFF'}`;
                    await admShowSettings(ctx); break;
                }
                const s = await getAppSettings();
                await setAdminState(uid, { mode: 'setting', idx });
                await adminSend(chatId, `<b>${esc(f.l)}</b>-এর নতুন মান পাঠান${f.t === 'image' ? ' (URL বা photo)' : ''}\nCurrent: <code>${esc(s[f.k] === undefined ? '' : s[f.k])}</code>\n${f.t === 'number' ? '' : '"-" পাঠালে ফাঁকা হবে\n'}/cancel দিয়ে বাতিল`);
                break;
            }

            case 'ad': if (!isOwner(uid)) { toast = 'শুধু Owner'; break; } await admShowAdmins(ctx); break;
            case 'ada': if (!isOwner(uid)) { toast = 'শুধু Owner'; break; }
                await setAdminState(uid, { mode: 'addadmin' });
                await adminSend(chatId, 'নতুন Admin-এর Telegram Chat ID (User ID) পাঠান:\n(সংখ্যা, যেমন 123456789)\n\n/cancel দিয়ে বাতিল');
                break;
            case 'adr': if (!isOwner(uid)) { toast = 'শুধু Owner'; break; }
                await db.collection('bot_admins').doc(String(p[2])).delete(); dynamicAdminIds.delete(String(p[2]));
                await clearAdminState(p[2]); toast = 'Admin সরানো হয়েছে'; await admShowAdmins(ctx); break;
            case 'us': await adminShow(ctx, '<b>Users</b>', KB([[B('Find User by ID', 'adm:uf')], [B('Stats', 'adm:stats')], [B('Main Menu', 'adm:home')]])); break;
            case 'uf': await setAdminState(uid, { mode: 'user' }); await adminSend(chatId, 'User-এর Telegram ID পাঠান:\n/cancel দিয়ে বাতিল'); break;
            case 'ub': {
                try { await db.collection('users').doc(String(p[2])).update({ banned: p[3] === '1' }); toast = p[3] === '1' ? 'Banned' : 'Unbanned'; }
                catch (e) { toast = 'User পাওয়া যায়নি'; break; }
                await admShowUser(ctx, p[2]); break;
            }

            case 'bc': await adminShow(ctx, '<b>Broadcast</b>', KB([[B('Send Message', 'adm:bn')], [B('Forward Post', 'adm:fw')], [B('History', 'adm:bh')], [B('Main Menu', 'adm:home')]])); break;
            case 'bn':
                await setAdminState(uid, { mode: 'bc', step: 'content', data: {} });
                await adminSend(chatId, '<b>Broadcast Message</b>\nMessage পাঠান — text, অথবা caption সহ photo।\nHTML ট্যাগ (&lt;b&gt;, &lt;i&gt;, &lt;code&gt;) সাপোর্ট করে।\n\n/cancel দিয়ে বাতিল');
                break;
            case 'bp': {
                const st = await needState('bc'); if (!st) break;
                st.data.pinAll = p[2] === '1'; st.step = 'confirm'; await setAdminState(uid, st);
                await admBroadcastPreview(chatId, st.data); break;
            }
            case 'bs': {
                const st = await needState('bc'); if (!st) break;
                const r = await selfApi('/api/broadcast-message', st.data);
                await clearAdminState(uid);
                await adminShow(ctx, `Broadcast শুরু হয়েছে।${r && r.historyWarning ? '\nHistory save হয়নি: ' + esc(r.historyWarning) : '\nProgress: Broadcast → History'}`, KB([[B('History', 'adm:bh'), B('Main Menu', 'adm:home')]]));
                break;
            }
            case 'fw':
                await setAdminState(uid, { mode: 'fw', step: 'link', data: {} });
                await adminSend(chatId, '<b>Forward Post</b>\nChannel/Group post-এর লিংক পাঠান:\n<code>https://t.me/channelname/123</code>\nPrivate: <code>https://t.me/c/1234567890/123</code>\n(Bot-কে ওই Channel/Group-এ member/admin থাকতে হবে)\n\n/cancel দিয়ে বাতিল');
                break;
            case 'fp': {
                const st = await needState('fw'); if (!st) break;
                st.data.pinAll = p[2] === '1'; st.step = 'confirm'; await setAdminState(uid, st);
                await adminShow(ctx, `এই post সব ইউজারকে forward করা হবে:\n${esc(st.data.postLink)}\nPin All User: <b>${st.data.pinAll ? 'ON' : 'OFF'}</b>`, KB([[B('Forward to All', 'adm:fs', 'success'), B('Cancel', 'adm:cancel', 'danger')]]));
                break;
            }
            case 'fs': {
                const st = await needState('fw'); if (!st) break;
                const r = await selfApi('/api/broadcast-forward', st.data);
                if (!r || !r.success) { await adminShow(ctx, `Forward হয়নি: ${esc(r && r.message)}`, KB([[B('Main Menu', 'adm:home')]])); break; }
                await clearAdminState(uid);
                await adminShow(ctx, `Forwarding শুরু হয়েছে।${r.historyWarning ? '\nHistory save হয়নি: ' + esc(r.historyWarning) : '\nProgress: Broadcast → History'}`, KB([[B('History', 'adm:bh'), B('Main Menu', 'adm:home')]]));
                break;
            }
            case 'bh': await admShowHistory(ctx); break;
            case 'bd': await db.collection('broadcast_history').doc(p[2]).delete(); toast = 'Deleted'; await admShowHistory(ctx); break;
            case 'br': await adminShow(ctx, 'এই Broadcast আবার <b>সব ইউজারকে</b> পাঠাবেন?', KB([[B('Yes, Resend', `adm:bry:${p[2]}`, 'success'), B('Cancel', 'adm:bh')]])); break;
            case 'bry': {
                const snap = await db.collection('broadcast_history').doc(p[2]).get();
                if (!snap.exists) { toast = 'পাওয়া যায়নি'; break; }
                const b = snap.data();
                const r = b.type === 'forward'
                    ? await selfApi('/api/broadcast-forward', { postLink: b.postLink, pinAll: !!b.pinAll })
                    : await selfApi('/api/broadcast-message', { text: b.text || '', image: b.image || '', buttons: b.buttons || [], pinAll: !!b.pinAll });
                toast = r && r.success ? 'Resend শুরু হয়েছে' : `Failed: ${(r && r.message) || ''}`.substring(0, 100);
                await admShowHistory(ctx); break;
            }

            default: toast = 'Unknown action';
        }
    } catch (e) {
        console.error('Admin callback error:', a, tgErr(e));
        toast = `Error: ${tgErr(e)}`.substring(0, 150);
    }
    await tg('answerCallbackQuery', { callback_query_id: cbq.id, text: toast || undefined }).catch(() => {});
}


// Webhook Handler (/start, /ping, /ref, callback_query)
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;

        // /admin panel: admins (private chat only) get first pick of every message so typed input
        // for an in-progress admin action is never mistaken for a normal user message.
        if (update.message && update.message.chat && update.message.chat.type === 'private' && update.message.from &&
            !isAdmin(update.message.from.id) && /^\/admin(@\w+)?(\s|$)/.test(update.message.text || '')) {
            await refreshAdminCache(); // admin may have just been added from the web panel
        }
        if (update.message && update.message.chat && update.message.chat.type === 'private' && update.message.from && isAdmin(update.message.from.id)) {
            const handled = await adminHandleMessage(update.message);
            if (handled) return res.sendStatus(200);
        }

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const messageId = update.message.message_id;
            // Support "/ping@YourBotUsername" style commands used in groups
            const command = text.split('@')[0].split(' ')[0];

            if (command === '/start') {
                const firstName = update.message.from.first_name || "User";
                await sendWelcomeMessage(chatId, messageId, firstName);
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
            else if (command === '/ref') {
                await sendReferStatsCommand(chatId).catch(e => console.error("/ref error:", e.message));
            }
            else {
                // Any other message (plain text, unknown command, sticker caption, etc.) — auto-run the
                // same welcome flow as /start. Only applies to private chats: in groups this would delete
                // the welcome message every time anyone talks, which isn't useful there.
                if (update.message.chat.type === 'private') {
                    const firstName = update.message.from.first_name || "User";
                    await sendWelcomeMessage(chatId, messageId, firstName);
                }
            }
        } 
        else if (update.message && update.message.chat && update.message.chat.type === 'private' && update.message.from && !update.message.from.is_bot &&
                 (update.message.photo || update.message.video || update.message.document || update.message.sticker || update.message.voice ||
                  update.message.audio || update.message.animation || update.message.video_note || update.message.contact || update.message.location)) {
            // Non-text message from a user (photo, sticker, file, ...) — same auto /start behavior as text.
            await sendWelcomeMessage(update.message.chat.id, update.message.message_id, update.message.from.first_name || "User");
        }
        
        else if (update.callback_query) {
            const cbq = update.callback_query;
            const data = cbq.data;
            const adminUser = cbq.from;
            const message = cbq.message;
            
            if (data.startsWith('adm:')) {
                if (isAdmin(adminUser.id)) await adminHandleCallback(cbq);
                else await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cbq.id, text: 'Not allowed', show_alert: true }).catch(() => {});
            }
            else if (data.startsWith('act_')) {
                const [_, reqId, status] = data.split('_');
                const adminName = adminUser.first_name || "Admin";

                const result = await processAdminAction(reqId, status, adminName);
                
                if (result.success) {
                    const newText = esc(message.caption || message.text || '') + `\n\n<b>Status: ${esc(status)} by ${esc(adminName)}</b>`;
                    
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

    // Build & validate inline keyboard. A malformed url (missing http/https) makes Telegram
    // reject the WHOLE sendMessage/sendPhoto call, which is why buttons could silently vanish
    // (the failed call was being swallowed by an empty catch). We validate up front instead.
    let reply_markup = undefined;
    const validButtons = (Array.isArray(buttons) ? buttons : []).filter(b => b && b.text && b.url && /^https?:\/\//i.test(String(b.url).trim()));
    if (validButtons.length > 0) {
        reply_markup = { inline_keyboard: validButtons.map(b => {
            const btnObj = { text: b.text, url: b.url.trim() };
            if (b.style && ['primary', 'success', 'danger'].includes(b.style)) btnObj.style = b.style; // Bot API 9.4+ button color
            return [btnObj];
        }) };
    }

    // Create the history record up-front (server-side) so it always reflects real, live progress
    // instead of a hardcoded 0/0 written once from the client.
    let historyRef = null;
    let historyError = null;
    try {
        historyRef = await db.collection('broadcast_history').add({
            type: 'message', text: text || '', image: image || '', buttons: validButtons, pinAll: !!pinAll,
            successCount: 0, failCount: 0, total: 0, status: 'sending', createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        historyError = e.message;
        console.error("History create error:", e.message);
    }

    // If Firestore itself is unreachable/misconfigured (bad FIREBASE_KEY, wrong project, etc.), the
    // broadcast can still go out, but the admin needs to actually SEE that history couldn't be saved —
    // otherwise it silently looks like "history just doesn't work" with no clue why.
    res.json({
        success: true,
        message: "Broadcasting message started...",
        historyId: historyRef ? historyRef.id : null,
        historyWarning: historyError ? `History save failed: ${historyError}` : null
    });

    const hasStyledButton = reply_markup && reply_markup.inline_keyboard &&
        reply_markup.inline_keyboard.some(row => row.some(b => b.style));

    // Strips the `style` field (Bot API 9.4+ button color) from a keyboard, for the fallback retry below.
    function stripStyle(markup) {
        if (!markup || !markup.inline_keyboard) return markup;
        return { inline_keyboard: markup.inline_keyboard.map(row => row.map(({ style, ...rest }) => rest)) };
    }

    const sendOne = async (userId) => {
        const doSend = async (markup) => {
            let sentMsg;
            if (image) {
                sentMsg = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { chat_id: userId, photo: image, caption: text || '', parse_mode: 'HTML', reply_markup: markup });
            } else {
                sentMsg = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: text, parse_mode: 'HTML', reply_markup: markup });
            }
            return sentMsg;
        };

        let sentMsg;
        try {
            sentMsg = await doSend(reply_markup);
        } catch (err) {
            // If a colored button caused Telegram to reject the WHOLE message, retry once without
            // color so the button (and the message) still reach the user — better a plain button
            // than no message at all.
            if (hasStyledButton) {
                console.error("Send with styled button failed, retrying without style:", err.response ? JSON.stringify(err.response.data) : err.message);
                sentMsg = await doSend(stripStyle(reply_markup));
            } else {
                throw err;
            }
        }

        if (pinAll && sentMsg && sentMsg.data && sentMsg.data.result) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
                chat_id: userId, message_id: sentMsg.data.result.message_id, disable_notification: true
            }).catch(() => {}); // ignore if user blocked bot or pin not allowed — the message itself still counts as sent
        }
        return true;
    };

    try {
        await broadcastToAllUsers(sendOne, historyRef);
        if (historyRef) await historyRef.update({ status: 'done' }).catch(() => {});
    } catch (error) {
        console.error("Broadcast Msg Error:", error.message);
        if (historyRef) await historyRef.update({ status: 'error' }).catch(() => {});
    }
});

// Forward a public/private channel or group post to every user (bot must be a member/admin
// of the source chat to read it; for private chats use the https://t.me/c/<id>/<msgId> link format).
app.post('/api/broadcast-forward', async (req, res) => {
    const { postLink, pinAll } = req.body;
    const parsed = parseTelegramPostLink(postLink);
    if (!parsed) return res.json({ success: false, message: "Invalid Telegram post link. Use https://t.me/channel/123 or https://t.me/c/1234567890/123" });

    let historyRef = null;
    let historyError = null;
    try {
        historyRef = await db.collection('broadcast_history').add({
            type: 'forward', postLink, fromChatId: parsed.chatId, messageId: parsed.messageId, pinAll: !!pinAll,
            successCount: 0, failCount: 0, total: 0, status: 'sending', createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        historyError = e.message;
        console.error("History create error:", e.message);
    }

    res.json({
        success: true,
        message: "Forwarding started...",
        historyId: historyRef ? historyRef.id : null,
        historyWarning: historyError ? `History save failed: ${historyError}` : null
    });

    const sendOne = async (userId) => {
        const fwd = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
            chat_id: userId, from_chat_id: parsed.chatId, message_id: parsed.messageId
        });
        if (pinAll && fwd && fwd.data && fwd.data.result) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
                chat_id: userId, message_id: fwd.data.result.message_id, disable_notification: true
            }).catch(() => {});
        }
        return true;
    };

    try {
        await broadcastToAllUsers(sendOne, historyRef);
        if (historyRef) await historyRef.update({ status: 'done' }).catch(() => {});
    } catch (error) {
        console.error("Broadcast Forward Error:", error.message);
        if (historyRef) await historyRef.update({ status: 'error' }).catch(() => {});
    }
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
        const commissionRate = REFERRAL_COMMISSION_PERCENT / 100;
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
                const refMsg = `<b>New Deposit Commission Added 💰</b>\nUser: @${userName}\nAmount: ${commission.toFixed(2)} ৳\n<blockquote>(${REFERRAL_COMMISSION_PERCENT}% from Deposit)</blockquote>`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: refMsg, parse_mode: 'HTML', message_effect_id: PARTY_POPPER_EFFECT_ID }).catch(e => {});
            }
            const userMsg = `Your Deposit Approved! ${icon}\n\nAmount: ${amount} ৳\nFee (${REFERRAL_COMMISSION_PERCENT}% Refer): -${commission.toFixed(2)} ৳\nAdded: ${userFinalAmount.toFixed(2)} ৳\n\n@RedExChanger`;
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
            refCommission = afterFee * (REFERRAL_COMMISSION_PERCENT / 100);
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
                
                const refMsg = `<b>New Exchange Commission Added 💰</b>\nUser: @${userName}\nAmount: ${refCommission.toFixed(2)} ৳\n<blockquote>(${REFERRAL_COMMISSION_PERCENT}% from Exchange)</blockquote>`;
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: referrerId, text: refMsg, parse_mode: 'HTML', message_effect_id: PARTY_POPPER_EFFECT_ID }).catch(e => {});
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
    await notifyAdmins(adminMsg, keyboard, imageUrl);
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
    await notifyAdmins(adminMsg, keyboard);
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
            refCommission = afterFee * (REFERRAL_COMMISSION_PERCENT / 100);
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
        await notifyAdmins(adminMsg, keyboard, imageUrl);

        // ---- Public Notification Channel/Group (set from Admin Panel Settings) ----
        // UPDATE: Telegram added a real `style` field for buttons in Bot API 9.4 (Feb 2026) —
        // 'primary' (blue), 'success' (green), 'danger' (red). Using 'danger' for red, as originally asked.
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
            const groupKeyboard = { inline_keyboard: [[{ text: "Let's Exchange Now", url: "https://t.me/RedExChangerBot/app?startapp", style: "danger" }]] };
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

        const referrerDoc = await db.collection('users').doc(String(referrerId)).get();
        const refEarnings = referrerDoc.exists ? (parseFloat(referrerDoc.data().refEarnings) || 0) : 0;

        // Refer link is back to the tracking format (?startapp=<referrerId>) — same pattern the mini-app's
        // own "My Refer" tab uses — so shares of this link actually attribute the new user to this referrer.
        const settings = await getAppSettings();
        const botUsername = settings.botUsername || "RedExChangerBot";
        const referLink = `https://t.me/${botUsername}?startapp=${referrerId}`;

        // Dollar equivalent uses the AVERAGE rate across all configured Exchange Methods, since no
        // single method is marked as "the" reference rate. If you'd rather a specific method (e.g. only
        // "Binance") drive this conversion, tell me which one and I'll pin it to that instead of averaging.
        const methodsSnap = await db.collection('exchange_methods').get();
        let avgRate = 0;
        if (!methodsSnap.empty) {
            let sum = 0, n = 0;
            methodsSnap.forEach(d => { const r = parseFloat(d.data().rate); if (!isNaN(r) && r > 0) { sum += r; n++; } });
            avgRate = n > 0 ? sum / n : 0;
        }
        const dollarEquivalent = avgRate > 0 ? (refEarnings / avgRate) : 0;

        const rawName = firstName || newUserName || "User";
        const safeName = String(rawName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        const msg = `<b>🆕 New Refer Joined!</b>\n\n` +
                    `Name: ${safeName}\n` +
                    `Total Refer: <code>${referCount} User</code>\n` +
                    `Total Commission: <code>${refEarnings.toFixed(2)}৳ =${dollarEquivalent.toFixed(2)}$</code>\n` +
                    `Refer Link: <code>${referLink}</code>\n\n` +
                    `<i>You will receive a ${REFERRAL_COMMISSION_PERCENT}% commission when the person you refer makes a deposit or exchange.</i>`;

        // copy_text button: Bot API 7.11+ — tapping it copies the given text to the clipboard directly,
        // no URL open needed.
        const keyboard = { inline_keyboard: [[{ text: "📋 Copy Refer Link", copy_text: { text: referLink } }]] };

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: referrerId, text: msg, parse_mode: 'HTML', reply_markup: keyboard,
            message_effect_id: PARTY_POPPER_EFFECT_ID // 🎉 — private chats only
        });
        res.json({ success: true });
    } catch (error) { console.error("Notify Refer Join Error:", error.message); res.json({ success: false }); }
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


// Strips the `style` field (Bot API 9.4+ button color) from a keyboard, for the fallback retry below.
function stripButtonStyle(markup) {
    if (!markup || !markup.inline_keyboard) return markup;
    return { inline_keyboard: markup.inline_keyboard.map(row => row.map(({ style, ...rest }) => rest)) };
}

// Utility to send message with optional keyboard & Image Support
async function sendMessageToTelegram(chatId, text, reply_markup = {}, imageUrl = null) {
    const hasStyled = reply_markup && reply_markup.inline_keyboard && reply_markup.inline_keyboard.some(row => row.some(b => b.style));

    const doSend = async (markup) => {
        if (imageUrl && imageUrl.startsWith('http')) {
            return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                chat_id: chatId,
                photo: imageUrl,
                caption: text,
                parse_mode: 'HTML',
                reply_markup: markup
            });
        } else {
            return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                reply_markup: markup
            });
        }
    };

    try {
        await doSend(reply_markup);
    } catch (e) {
        const detail = e.response ? JSON.stringify(e.response.data) : e.message;
        // If a colored button caused Telegram to reject the WHOLE message, retry once without color
        // so the message (and button) still reach the recipient.
        if (hasStyled) {
            console.error("Admin Notify Error (styled button, retrying without style):", detail);
            try {
                await doSend(stripButtonStyle(reply_markup));
                return;
            } catch (e2) {
                console.error("Admin Notify Error (fallback also failed):", e2.response ? JSON.stringify(e2.response.data) : e2.message);
                return;
            }
        }
        console.error("Admin Notify Error:", detail);
    }
}

// --- Coin Price Update (Admin Panel: Settings → Coin Price Update) ---
// Fetches live prices from Binance's public, key-free market-data domain (data-api.binance.vision —
// this is Binance's dedicated endpoint for market data only, which avoids the geo-restrictions that
// can block the main api.binance.com from some server regions) and posts them to a Telegram chat.
async function fetchBinancePrices(coinSymbols) {
    const pairs = coinSymbols.map(c => `${c.toUpperCase()}USDT`);
    const symbolsParam = encodeURIComponent(JSON.stringify(pairs));
    const res = await axios.get(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${symbolsParam}`);
    const map = {};
    (Array.isArray(res.data) ? res.data : []).forEach(item => {
        const coin = item.symbol.replace(/USDT$/, '');
        map[coin] = parseFloat(item.price);
    });
    return map;
}

async function coinUpdateTick() {
    try {
        const settingsDoc = await db.collection('settings').doc('appConfig').get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};
        if (!settings.coinUpdateEnabled) return;

        const intervalMin = parseFloat(settings.coinUpdateIntervalMinutes) || 3;
        const lastAt = (settings.lastCoinUpdateAt && typeof settings.lastCoinUpdateAt.toMillis === 'function') ? settings.lastCoinUpdateAt.toMillis() : 0;
        if (Date.now() - lastAt < intervalMin * 60 * 1000) return; // not due yet

        const chatId = settings.coinUpdateChatId || settings.notifyChatId;
        if (!chatId) { console.error("Coin Update: no coinUpdateChatId/notifyChatId set in Settings."); return; }

        const coinList = String(settings.coinSymbols || "BTC,ETH,BNB,TRX,LTC,SOL,XRP,DOGE,ADA").split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const [prices, bdtRate] = await Promise.all([fetchBinancePrices(coinList), getAverageBdtRate()]);

        // No emoji anywhere in this message, as requested.
        let msg = `<b>Live Coin Prices</b>\n\n`;
        msg += `<b>USDT</b> - <code>${bdtRate.toFixed(2)} ৳</code>\n`;
        // Highest price first.
        const sortedCoins = coinList
            .filter(coin => prices[coin] !== undefined && !isNaN(prices[coin]))
            .sort((a, b) => prices[b] - prices[a]);
        sortedCoins.forEach(coin => {
            const price = prices[coin];
            const decimals = price >= 1 ? 2 : 4;
            msg += `<b>${coin}</b> - <code>$${price.toFixed(decimals)} (${(price * bdtRate).toFixed(2)} ৳)</code>\n`;
        });
        msg += `\n<i>Updated: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true })}</i>`;

        // Delete the previous coin-price message before posting the new one, so each update's
        // "delete time" matches the send interval exactly — only one stays visible at a time.
        if (settings.lastCoinMsgId) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: settings.lastCoinMsgId }).catch(() => {});
        }

        const sent = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: msg, parse_mode: 'HTML' });
        const newMsgId = sent.data && sent.data.result ? sent.data.result.message_id : null;

        await db.collection('settings').doc('appConfig').set({
            lastCoinUpdateAt: admin.firestore.FieldValue.serverTimestamp(),
            lastCoinMsgId: newMsgId
        }, { merge: true }).catch(() => {});
    } catch (e) {
        console.error("Coin Update Error:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

// Checked every 30s; actual posting cadence is controlled by coinUpdateIntervalMinutes in Settings
// (compared against lastCoinUpdateAt, which is stored in Firestore so the cadence survives restarts).
setInterval(coinUpdateTick, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
