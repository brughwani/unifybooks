
const { db, auth, messaging, FieldValue } = require("../admin");
const cors = require("cors")({ origin: true });

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

const invoiceRequestsHandler = async (req, res) => {
  return cors(req, res, async () => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const orgId = user.uid;

    try {
      const { action } = req.query;
      if (req.method === "POST" && action === "create") {
        const body = req.body;
        const from_account = body.from_account || body.fromOrgPan || "";
        const to_account = body.to_account || body.toOrgPan || "";
        const amount = body.amount || body.grandTotal || 0;
        const description = body.description || body.notes || "";

        // Validate inputs
        if (!from_account || !to_account || typeof amount !== "number") {
          return res.status(400).json({ error: "from_account, to_account and numeric amount required" });
        }

        // Use from_account (PAN) instead of user.uid
        const orgId = from_account;

        // Store ALL fields from the Flutter payload + CF fields for backwards compat
        const data = {
          // Cloud Function field names
          from_org: orgId,
          to_org: to_account,
          amount,
          description: description,
          status: body.status || "pending",
          created_at: new Date().toISOString(),
          // Flutter field names (so fromMap works directly)
          fromOrgPan: from_account,
          fromOrgName: body.fromOrgName || "",
          toOrgPan: to_account,
          toOrgName: body.toOrgName || "",
          items: body.items || [],
          subtotal: body.subtotal || 0,
          gst: body.gst || 0,
          grandTotal: amount,
          createdAt: new Date().toISOString(),
          invoiceNumber: body.invoiceNumber || "",
          notes: description,
          driverName: body.driverName || null,
          driverPhone: body.driverPhone || null,
          vehicleNumber: body.vehicleNumber || null,
          paymentStatus: body.paymentStatus || "",
          disputeStatus: body.disputeStatus || "",
        };
        const ref = await db.collection("orgs").doc(orgId).collection("invoice_requests").add(data);

        // Also write a copy to the counterparty's invoice_requests so they can query it
        await db.collection("orgs").doc(to_account).collection("invoice_requests").doc(ref.id).set(data);

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
        notifyCounterparty(to_account, "invoice_request_created", notifyPayload).then((r) => console.log("notify result:", r)).catch((e) => console.warn("notify error:", e));

        return res.status(201).json({ id: ref.id });
      }

      if (req.method === "GET" && action === "list") {
        // Use PAN from query param if provided, otherwise fall back to user.uid
        const pan = req.query.pan || orgId;
        const snapshot = await db.collection("orgs").doc(pan).collection("invoice_requests").get();
        return res.json(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      }

      // Counterparty can fetch invoices sent TO them
      if (req.method === "GET" && action === "incoming") {
        const snapshot = await db.collection("orgs").doc(orgId).collection("invoice_requests")
          .where("to_org", "==", orgId)
          .get();
        return res.json(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      }
      // ── Accept a pending invoice ─────────────────────────────────────
      if (req.method === "POST" && action === "accept") {
        const { id, from_pan, to_pan } = req.body;
        if (!id || !from_pan || !to_pan) {
          return res.status(400).json({ error: "id, from_pan and to_pan required" });
        }

        // Update status on both copies
        const batch = db.batch();
        batch.update(
          db.collection("orgs").doc(to_pan).collection("invoices").doc(id),
          { status: "accepted", updatedAt: new Date().toISOString() }
        );
        batch.update(
          db.collection("orgs").doc(from_pan).collection("invoices").doc(id),
          { status: "accepted", updatedAt: new Date().toISOString() }
        );
        await batch.commit();

        notifyCounterparty(from_pan, "invoice_accepted", { invoice_id: id, by: to_pan })
          .catch((e) => console.warn("notify error:", e));

        return res.status(200).json({ ok: true });
      }

      // ── Reject a pending invoice ──────────────────────────────────────
      if (req.method === "POST" && action === "reject") {
        const { id, from_pan, to_pan } = req.body;
        if (!id || !from_pan || !to_pan) {
          return res.status(400).json({ error: "id, from_pan and to_pan required" });
        }

        const batch = db.batch();
        batch.update(
          db.collection("orgs").doc(to_pan).collection("invoices").doc(id),
          { status: "rejected", updatedAt: new Date().toISOString() }
        );
        batch.update(
          db.collection("orgs").doc(from_pan).collection("invoices").doc(id),
          { status: "rejected", updatedAt: new Date().toISOString() }
        );
        await batch.commit();

        notifyCounterparty(from_pan, "invoice_rejected", { invoice_id: id, by: to_pan })
          .catch((e) => console.warn("notify error:", e));

        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: "Method not allowed or missing action" });

    } catch (err) {
      console.error("Invoice Requests error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
};

module.exports = invoiceRequestsHandler;
