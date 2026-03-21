// server.js - Fully Backend Managed Version
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
    } catch (e) { console.error("❌ Firebase Key Error:", e.message); }
}
const db = admin.firestore();

// Helper: Get Bot Username and App Link
async function getBotInfo() {
    const settings = await db.collection('settings').doc('appConfig').get();
    const botUsername = settings.exists ? settings.data().botUsername : "RedExChangerBot";
    return { botUsername, appLink: `https://t.me/${botUsername}/app` };
}

// ==========================================
// CORE API FOR FRONTEND (No Firebase in HTML)
// ==========================================

// 1. Initial Data (User, Settings, Methods, Banners, Offers)
app.get('/api/init-app/:uid', async (req, res) => {
    const { uid } = req.params;
    const { referrer } = req.query;

    try {
        // Fetch Settings, Methods, Banners, Offers in parallel
        const [settingsSnap, methodsSnap, depMethodsSnap, bannersSnap, offersSnap] = await Promise.all([
            db.collection('settings').doc('appConfig').get(),
            db.collection('exchange_methods').get(),
            db.collection('deposit_methods').get(),
            db.collection('banners').get(),
            db.collection('offers').get()
        ]);

        // User Logic
        let userRef = db.collection('users').doc(uid);
        let userSnap = await userRef.get();
        
        if (!userSnap.exists) {
            const userData = {
                name: req.query.name || "User",
                username: req.query.username || "",
                mainBalance: 0, referrals: 0, refEarnings: 0,
                referredBy: (referrer && referrer !== uid) ? referrer : null,
                joined: admin.firestore.FieldValue.serverTimestamp()
            };
            await userRef.set(userData);
            if (userData.referredBy) {
                await db.collection('users').doc(userData.referredBy).update({ referrals: admin.firestore.FieldValue.increment(1) });
                // Notify Referrer
                const { appLink } = await getBotInfo();
                const refMsg = `<b>🆕 New Refer Joined!</b>\n\nName: ${userData.name}\n<i>You will receive a 1.5% commission on their transactions.</i>`;
                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userData.referredBy, text: refMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Open App", url: appLink }]] } }).catch(e=>{});
            }
            userSnap = await userRef.get();
        }

        res.json({
            success: true,
            user: userSnap.data(),
            settings: settingsSnap.exists ? settingsSnap.data() : {},
            methods: methodsSnap.docs.map(d => d.data()),
            depMethods: depMethodsSnap.docs.map(d => d.data()),
            banners: bannersSnap.docs.map(d => d.data()),
            offers: offersSnap.docs.map(d => d.data())
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 2. Submit Request (Deposit, Exchange, Withdraw)
app.post('/api/submit-request', async (req, res) => {
    const { uid, type, amount, data } = req.body;
    try {
        const reqRef = await db.collection('requests').add({
            userId: uid,
            type: type,
            amount: parseFloat(amount),
            ...data,
            status: "Pending",
            date: admin.firestore.FieldValue.serverTimestamp()
        });

        // Admin Notification
        let adminMsg = `<b>🆕 New ${type} Request</b>\n\nUser ID: <code>${uid}</code>\nAmount: <code>${amount}</code>\n`;
        for (let key in data) { adminMsg += `${key}: <code>${data[key]}</code>\n`; }

        const keyboard = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `Approved:${type}:${reqRef.id}` }, { text: "❌ Dismiss", callback_data: `Rejected:${type}:${reqRef.id}` }]] };
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_ID, text: adminMsg, parse_mode: 'HTML', reply_markup: keyboard });

        res.json({ success: true, docId: reqRef.id });
    } catch (e) { res.json({ success: false }); }
});

// 3. History & Leaderboard
app.get('/api/history/:uid', async (req, res) => {
    const s = await db.collection('requests').where('userId', '==', req.params.uid).orderBy('date', 'desc').limit(20).get();
    res.json(s.docs.map(d => d.data()));
});

app.get('/api/leaderboard', async (req, res) => {
    const s = await db.collection('users').orderBy('referrals', 'desc').limit(20).get();
    res.json(s.docs.map(d => d.data()));
});

// 4. Tasks (Get & Claim)
app.get('/api/tasks/:uid', async (req, res) => {
    const s = await db.collection('tasks').where('active', '==', true).get();
    const tasks = s.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(tasks.filter(t => !t.completedBy || !t.completedBy.includes(req.params.uid)));
});

app.post('/api/claim-task', async (req, res) => {
    const { uid, taskId } = req.body;
    try {
        const taskRef = db.collection('tasks').doc(taskId);
        const taskSnap = await taskRef.get();
        if (taskSnap.exists) {
            const task = taskSnap.data();
            if (task.completedCount < task.targetCount && (!task.completedBy || !task.completedBy.includes(uid))) {
                await db.runTransaction(async (t) => {
                    t.update(db.collection('users').doc(uid), { mainBalance: admin.firestore.FieldValue.increment(task.reward) });
                    t.update(taskRef, { completedCount: admin.firestore.FieldValue.increment(1), completedBy: admin.firestore.FieldValue.arrayUnion(uid) });
                });
                return res.json({ success: true, reward: task.reward });
            }
        }
        res.json({ success: false });
    } catch (e) { res.json({ success: false }); }
});

// ==========================================
// ADMIN ACTIONS & WEBHOOK (SAME AS BEFORE)
// ==========================================
app.post('/webhook', async (req, res) => {
    const update = req.body;
    const { appLink } = await getBotInfo();

    if (update.callback_query) {
        const cb = update.callback_query;
        if (String(cb.from.id) === String(ADMIN_ID)) {
            const [action, type, docId] = cb.data.split(':');
            const docRef = db.collection('requests').doc(docId);
            const docSnap = await docRef.get();

            if (docSnap.exists && docSnap.data().status === 'Pending') {
                const data = docSnap.data();
                const actionResponse = await axios.post(`http://localhost:${PORT}/api/admin/action`, { ...data, status: action, type: type, userId: data.userId });
                if (actionResponse.data.success) {
                    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: cb.message.text + `\n\n<b>Status: ${action}</b>`, parse_mode: 'HTML' });
                }
            }
        }
        return res.sendStatus(200);
    }
    // Start Command
    if (update.message && update.message.text === '/start') {
        const welcomeMsg = `Welcome to RedExChanger!\nExchange & Earn easily.`;
        const keyboard = { inline_keyboard: [[{ text: "🚀 Open App", url: appLink }]] };
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: update.message.chat.id, text: welcomeMsg, reply_markup: keyboard });
    }
    res.sendStatus(200);
});

app.post('/api/admin/action', async (req, res) => {
    const { userId, amount, status, type, referrerId, bdtAmount } = req.body;
    if (status === 'Approved') {
        if (type === 'Deposit') {
            const commission = amount * 0.015;
            const final = amount - commission;
            await db.collection('users').doc(userId).update({ mainBalance: admin.firestore.FieldValue.increment(final) });
            if (referrerId) await db.collection('users').doc(referrerId).update({ mainBalance: admin.firestore.FieldValue.increment(commission), refEarnings: admin.firestore.FieldValue.increment(commission) });
        } else if (type === 'Exchange' && referrerId) {
            const commission = bdtAmount * 0.015;
            await db.collection('users').doc(referrerId).update({ mainBalance: admin.firestore.FieldValue.increment(commission), refEarnings: admin.firestore.FieldValue.increment(commission) });
        }
    }
    await db.collection('requests').doc(req.body.docId || "").update({ status: status });
    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: `Your ${type} request has been ${status}.` });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
