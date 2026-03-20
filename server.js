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
app.get("/", (_, res) => res.send("PocketFiller Push Server running ✓"));
app.get("/ping", (_, res) => res.send("pong"));

// ── Send OneSignal push ───────────────────────────────────────────────────
async function sendPush(playerId, title, body, type) {
    await axios.post(
        "https://onesignal.com/api/v1/notifications",
        {
            app_id:             ONESIGNAL_APP_ID,
            include_player_ids: [playerId],
            headings:           { en: title },
            contents:           { en: body },
            data:               { type: type ?? "notification" },
            priority:           type === "chat" ? 10 : 5,
            android_channel_id: type === "chat" ? "pf_chat" : "pf_notifications",
        },
        {
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Basic ${ONESIGNAL_API_KEY}`,
            },
            timeout: 10000,
        }
    );
}

// ── Process a single push_queue doc ──────────────────────────────────────
async function processDoc(docRef, data) {
    const { toUid, title, body, type } = data;

    // Delete first to prevent duplicate processing
    try { await docRef.delete(); } catch (_) {}

    if (!toUid || !title || !body) return;

    try {
        const userDoc = await db.collection("users").doc(toUid).get();
        const playerId = userDoc.data()?.oneSignalId;
        if (!playerId) { console.log(`No oneSignalId for ${toUid}`); return; }

        await sendPush(playerId, title, body, type);
        console.log(`✓ Push sent to ${toUid}: "${title}"`);
    } catch (err) {
        console.error("Push error:", err?.response?.data ?? err.message);
    }
}

// ── Poll push_queue every 3 seconds (more reliable than onSnapshot on free tier) ──
async function pollQueue() {
    try {
        const snap = await db.collection("push_queue")
            .orderBy("createdAt")
            .limit(10)
            .get();

        for (const doc of snap.docs) {
            // Process each doc concurrently
            processDoc(doc.ref, doc.data()).catch(console.error);
        }
    } catch (err) {
        console.error("Poll error:", err.message);
    }
}

// Start polling immediately and every 3 seconds
pollQueue();
setInterval(pollQueue, 3000);

// ── Also keep onSnapshot as backup ───────────────────────────────────────
let unsubscribe = null;

function startListener() {
    if (unsubscribe) { try { unsubscribe(); } catch (_) {} }

    unsubscribe = db.collection("push_queue")
        .onSnapshot(
            async (snapshot) => {
                for (const change of snapshot.docChanges()) {
                    if (change.type === "added") {
                        processDoc(change.doc.ref, change.doc.data()).catch(console.error);
                    }
                }
            },
            (err) => {
                console.error("Snapshot error, restarting listener:", err.message);
                setTimeout(startListener, 5000); // restart after 5s
            }
        );
    console.log("Firestore listener active");
}

startListener();

// Restart listener every 30 minutes to prevent stale connections
setInterval(() => {
    console.log("Refreshing Firestore listener...");
    startListener();
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
