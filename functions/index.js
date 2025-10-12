const functions = require("firebase-functions");

// // Create and deploy your first functions
// // https://firebase.google.com/docs/functions/get-started
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
// const fetch = require("node-fetch"); // <-- ADD THIS LINE


// ---------------- FIREBASE INIT ----------------
if (!global._firebaseApp) {
  initializeApp({ credential: applicationDefault() });
  global._firebaseApp = true;
}
const db = getFirestore();
const auth = getAuth();
const messaging = getMessaging();

// ---------------- MOCK GST + OTP SERVICES ----------------
async function verifyGST(gst_number) {
  // Replace with real GSTN API integration
  return {
    legal_name: "Demo Org Pvt Ltd",
    email: "accounts@demo.com",
    phone: "+919876543210",
    state: "Maharashtra",
  };
}
async function sendOTP(phone) {
  // Integrate Twilio/MSG91 in production
  console.log(`Sending OTP to ${phone}`);
}
async function verifyOTP(phone, otp) {
  // Dev-mode OTP
  return otp === "1234";
}

// ---------------- NOTIFICATION HELPERS ----------------
async function notifyCounterparty(counterpartyGst, eventType, payload) {
  try {
    const orgDoc = await db.collection("orgs").doc(counterpartyGst).get();
    if (!orgDoc.exists) return { ok: false, reason: "counterparty not registered" };

    const orgData = orgDoc.data();

    const notifPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    };

    // 1) Webhook (preferred)
    if (orgData && orgData.webhook_url) {
      try {
        await fetch(orgData.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(notifPayload),
        });
        return { ok: true, via: "webhook" };
      } catch (err) {
        console.warn("Webhook notify failed:", err.message || err);
      }
    }

    // 2) FCM (fallback)
    if (orgData && orgData.fcm_token) {
      try {
        const message = {
          token: orgData.fcm_token,
          notification: {
            title: `New ${eventType}`,
            body: payload.description ? String(payload.description).slice(0, 120) : `Amount: ${payload.amount || ""}`,
          },
          data: {
            event: eventType,
            payload: JSON.stringify(payload),
          },
        };
        await messaging.send(message);
        return { ok: true, via: "fcm" };
      } catch (err) {
        console.warn("FCM notify failed:", err.message || err);
      }
    }

    return { ok: false, reason: "no webhook or fcm_token" };
  } catch (err) {
    console.error("notifyCounterparty error:", err);
    return { ok: false, reason: err.message || "unknown" };
  }
}

// ---------------- AUTH HELPER ----------------
async function requireAuth(req, res) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;
  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return null;
  }
  try {
    return await auth.verifyIdToken(token);
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
}

// ---------------- MAIN HANDLER ----------------

async function handler(req, res) {
  try {
    const { resource, action, account_id, gst_number, otp } = req.query;

    // ---------- GST LOGIN ----------
    if (resource === "gst_login") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

      const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstRegex.test(gst_number)) {
        return res.status(400).json({ error: "Invalid GST format" });
      }

      const gstData = await verifyGST(gst_number);
      if (!gstData) return res.status(404).json({ error: "GST not found" });

      if (!otp) {
        await sendOTP(gstData.phone);
        return res.status(200).json({ message: "OTP sent" });
      }

      const otpValid = await verifyOTP(gstData.phone, otp);
      if (!otpValid) return res.status(401).json({ error: "Invalid OTP" });

      // let user;
      try {
        await auth.getUser(gst_number);
      } catch {
        await auth.createUser({
          uid: gst_number,
          email: gstData.email,
          displayName: gstData.legal_name,
        });
        await db.collection("orgs").doc(gst_number).set({
          gst_number,
          ...gstData,
          created_at: new Date().toISOString()
        });
      }


      const token = await auth.createCustomToken(gst_number);
      return res.status(200).json({ token });
    }


    // ---------- ALL OTHER RESOURCES REQUIRE AUTH ----------
    const user = await requireAuth(req, res);
    if (!user) return;
    const orgId = user.uid;

    switch (resource) {
      case "items":
        if (req.method === "POST" && action === "create") {
          const data = { ...req.body, created_at: new Date().toISOString() };
          const ref = await db.collection("orgs").doc(orgId).collection("items").add(data);
          return res.status(201).json({ id: ref.id });
        }
        if (req.method === "GET" && action === "list") {
          const snapshot = await db.collection("orgs").doc(orgId).collection("items").get();
          return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }
        break;

      case "accounts":
        if (req.method === "POST" && action === "create") {
          const data = { ...req.body, created_at: new Date().toISOString() };
          const ref = await db.collection("orgs").doc(orgId).collection("accounts").add(data);
          await db.collection("orgs").doc(orgId).collection("ledgers").doc(ref.id).set({ entries: [] });
          return res.status(201).json({ id: ref.id });
        }
        if (req.method === "GET" && action === "list") {
          const snapshot = await db.collection("orgs").doc(orgId).collection("accounts").get();
          return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }
        break;

      case "invoice_requests":
        if (req.method === "POST" && action === "create") {
          const { to_account, amount, description } = req.body;
          if (!to_account || typeof amount !== "number") {
            return res.status(400).json({ error: "to_account and numeric amount required" });
          }
          const data = {
            from_org: orgId,
            to_org: to_account,
            amount,
            description: description || "",
            status: "pending",
            created_at: new Date().toISOString()
          };
          const ref = await db.collection("orgs").doc(orgId).collection("invoice_requests").add(data);

          await db.collection("orgs").doc(orgId).collection("ledgers").doc(to_account).set({
            entries: FieldValue.arrayUnion({
              id: `inv_${ref.id}`,
              type: "debit",
              amount,
              description: description || "",
              date: new Date().toISOString(),
              reference: ref.id,
              from: orgId,
              to: to_account
            })
          }, { merge: true });

          const counterpartyDoc = await db.collection("orgs").doc(to_account).get();
          if (counterpartyDoc.exists) {
            await db.collection("orgs").doc(to_account).collection("ledgers").doc(orgId).set({
              entries: FieldValue.arrayUnion({
                id: `inv_${ref.id}`,
                type: "credit",
                amount,
                description: description || "",
                date: new Date().toISOString(),
                reference: ref.id,
                from: orgId,
                to: to_account
              })
            }, { merge: true });

            const edgeId = orgId < to_account ? `${orgId}_${to_account}` : `${to_account}_${orgId}`;
            await db.collection("network_edges").doc(edgeId).set({
              a: orgId,
              b: to_account,
              last_txn: new Date().toISOString(),
              total_volume: FieldValue.increment(amount)
            }, { merge: true });
          }

          const notifyPayload = {
            invoice_id: ref.id,
            from: orgId,
            to: to_account,
            amount,
            description: description || ""
          };
          notifyCounterparty(to_account, "invoice_request_created", notifyPayload).then(r => console.log("notify result:", r)).catch(e => console.warn("notify error:", e));

          return res.status(201).json({ id: ref.id });
        }

        if (req.method === "GET" && action === "list") {
          const snapshot = await db.collection("orgs").doc(orgId).collection("invoice_requests").get();
          return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }
        break;

      case "ledger":
        if (req.method === "GET" && action === "get") {
          if (!account_id) return res.status(400).json({ error: "account_id required" });
          const docSnap = await db.collection("orgs").doc(orgId).collection("ledgers").doc(account_id).get();
          if (!docSnap.exists) return res.json({ entries: [] });
          return res.json(docSnap.data());
        }
        break;

      case "network":
        if (req.method === "GET" && action === "list_edges") {
          const q1 = await db.collection("network_edges").where("a", "==", orgId).get();
          const q2 = await db.collection("network_edges").where("b", "==", orgId).get();
          const edges = [
            ...q1.docs.map(d => ({ id: d.id, ...d.data() })),
            ...q2.docs.map(d => ({ id: d.id, ...d.data() }))
          ];
          return res.json(edges);
        }
        break;

      default:
        return res.status(404).json({ error: "Unknown resource" });
    }

    return res.status(405).json({ error: "Method not allowed or missing action" });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
exports.handler = functions.https.onRequest(handler);

