const admin   = require("firebase-admin");
const axios   = require("axios");
const express = require("express");

// ── Paste your values here ────────────────────────────────────────────────
const ONESIGNAL_APP_ID   = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY  = process.env.ONESIGNAL_API_KEY;
// ─────────────────────────────────────────────────────────────────────────

// Initialize Firebase Admin with service account from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.get("/", (_, res) => res.send("PocketFiller Push Server running ✓"));

// ── Watch push_queue collection and send OneSignal push ───────────────────
db.collection("push_queue").onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
        if (change.type !== "added") continue;

        const data = change.doc.data();
        const { toUid, title, body, type } = data;

        if (!toUid || !title || !body) {
            await change.doc.ref.delete();
            continue;
        }

        try {
            // Get recipient's OneSignal player ID from Firestore
            const userDoc = await db.collection("users").doc(toUid).get();
            const playerId = userDoc.data()?.oneSignalId;

            if (!playerId) {
                console.log(`No OneSignal ID for user ${toUid}`);
                await change.doc.ref.delete();
                continue;
            }

            // Send push via OneSignal REST API
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
                }
            );
            console.log(`✓ Push sent to ${toUid}: "${title}"`);
        } catch (err) {
            console.error("Push error:", err?.response?.data ?? err.message);
        } finally {
            // Always delete the queue doc
            try { await change.doc.ref.delete(); } catch (_) {}
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
