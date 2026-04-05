const admin   = require("firebase-admin");
const axios   = require("axios");
const express = require("express");

const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Init Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(express.json());
app.get("/",    (_, res) => res.send("PocketFiller Push Server ✓"));
app.get("/ping",(_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Track processed docs to avoid duplicates ──────────────────────────────
const processed = new Set();

// ── Send OneSignal push ───────────────────────────────────────────────────
async function sendPush(playerId, title, body, type) {
    const res = await axios.post(
        "https://onesignal.com/api/v1/notifications",
        {
            app_id:             ONESIGNAL_APP_ID,
            include_player_ids: [playerId],
            headings:           { en: title },
            contents:           { en: body },
            data:               { type: type ?? "notification" },
            priority:           type === "chat" ? 10 : 5,
            android_channel_id: type === "chat" ? "pf_chat" : "pf_notifications",
            // Make sure notification shows even when app is killed
            android_background_data: true,
        },
        {
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Basic ${ONESIGNAL_API_KEY}`,
            },
            timeout: 15000,
        }
    );
    return res.data;
}

// ── Process a single push_queue document ─────────────────────────────────
async function processDoc(docRef, data, docId) {
    if (processed.has(docId)) return; // already handled
    processed.add(docId);

    const { toUid, title, body, type } = data;

    // Delete first to prevent duplicates from parallel runs
    try { await docRef.delete(); } catch (_) {}

    if (!toUid || !title || !body) {
        console.log(`[SKIP] Missing fields in doc ${docId}`);
        return;
    }

    try {
        const userDoc  = await db.collection("users").doc(toUid).get();
        const playerId = userDoc.data()?.oneSignalId;

        if (!playerId) {
            console.log(`[SKIP] No oneSignalId for uid=${toUid}`);
            return;
        }

        const result = await sendPush(playerId, title, body, type);
        console.log(`[OK] Push sent to ${toUid} — recipients: ${result.recipients}`);
    } catch (err) {
        console.error(`[ERR] Push failed for ${docId}:`, err?.response?.data ?? err.message);
    }
}

// ── PRIMARY: Poll every 2 seconds ─────────────────────────────────────────
// More reliable than onSnapshot on free Render tier
async function pollQueue() {
    try {
        const snap = await db.collection("push_queue")
            .orderBy("createdAt")
            .limit(20)
            .get();

        if (!snap.empty) {
            console.log(`[POLL] Found ${snap.size} docs`);
            await Promise.all(
                snap.docs.map(doc => processDoc(doc.ref, doc.data(), doc.id))
            );
        }
    } catch (err) {
        console.error("[POLL ERR]", err.message);
    }
}

// Start polling immediately
pollQueue();
const pollInterval = setInterval(pollQueue, 2000);

// ── SECONDARY: Firestore realtime listener ────────────────────────────────
let unsubscribe = null;

function startListener() {
    if (unsubscribe) { try { unsubscribe(); } catch (_) {} }

    unsubscribe = db.collection("push_queue")
        .onSnapshot(
            async (snap) => {
                for (const change of snap.docChanges()) {
                    if (change.type === "added") {
                        await processDoc(change.doc.ref, change.doc.data(), change.doc.id);
                    }
                }
            },
            (err) => {
                console.error("[LISTENER ERR] Restarting in 5s:", err.message);
                setTimeout(startListener, 5000);
            }
        );
    console.log("[LISTENER] Firestore listener active");
}

startListener();

// Refresh listener every 20 minutes to prevent stale connections
setInterval(() => {
    console.log("[LISTENER] Refreshing...");
    startListener();
    // Also clear processed set to prevent memory leak
    if (processed.size > 1000) processed.clear();
}, 20 * 60 * 1000);

// ── Keep-alive: ping self every 4 minutes to prevent Render sleep ─────────
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
if (SERVER_URL) {
    setInterval(async () => {
        try {
            await axios.get(`${SERVER_URL}/ping`, { timeout: 10000 });
            console.log("[KEEPALIVE] Self-ping ok");
        } catch (err) {
            console.error("[KEEPALIVE ERR]", err.message);
        }
    }, 4 * 60 * 1000); // every 4 minutes
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
