
const { db, auth, messaging, FieldValue } = require("../admin");
const cors = require("cors")({ origin: true });
const { track } = require("../mixpanel");

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

        track("invoice_created", orgId, {
          invoice_id: ref.id,
          to_org: to_account,
          amount,
          item_count: (body.items || []).length,
          invoice_number: body.invoiceNumber || "",
        });

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

        const now = new Date().toISOString();

        // 1. Fetch the invoice to get items for inventory
        const invoiceRef = db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id);
        const invoiceSnap = await invoiceRef.get();
        if (!invoiceSnap.exists) {
          return res.status(404).json({ error: "Invoice not found" });
        }
        const invoiceData = invoiceSnap.data();

        // 2. Update status on both copies
        const batch = db.batch();
        batch.update(
          db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id),
          { status: "accepted", updatedAt: now, acceptedAt: now, paymentStatus: "unpaid" }
        );
        batch.update(
          db.collection("orgs").doc(from_pan).collection("invoice_requests").doc(id),
          { status: "accepted", updatedAt: now, acceptedAt: now, paymentStatus: "unpaid" }
        );

        // 3. Update receiver's inventory with items from the invoice
        const items = invoiceData.items || [];
        for (const item of items) {
          const itemName = item.name || item.itemId || "unknown";
          const qty = item.quantity || 0;
          const unitPrice = item.unitPrice || 0;
          const inventoryRef = db.collection("orgs").doc(to_pan).collection("inventory").doc(itemName);
          // Merge: increment quantity, update cost price
          batch.set(inventoryRef, {
            name: itemName,
            quantity: FieldValue.increment(qty),
            costPrice: unitPrice,
            lastUpdated: now,
            lastInvoiceId: id,
            fromOrg: from_pan,
          }, { merge: true });
        }

        await batch.commit();

        notifyCounterparty(from_pan, "invoice_accepted", { invoice_id: id, by: to_pan })
          .catch((e) => console.warn("notify error:", e));

        track("invoice_accepted", to_pan, {
          invoice_id: id,
          from_org: from_pan,
          amount: invoiceData.grandTotal || invoiceData.amount || 0,
        });

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
          db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id),
          { status: "rejected", updatedAt: new Date().toISOString() }
        );
        batch.update(
          db.collection("orgs").doc(from_pan).collection("invoice_requests").doc(id),
          { status: "rejected", updatedAt: new Date().toISOString() }
        );
        await batch.commit();

        notifyCounterparty(from_pan, "invoice_rejected", { invoice_id: id, by: to_pan })
          .catch((e) => console.warn("notify error:", e));

        track("invoice_rejected", to_pan, {
          invoice_id: id,
          from_org: from_pan,
        });

        return res.status(200).json({ ok: true });
      }

      // ── Mark as Paid ────────────────────────────────────────────────
      if (req.method === "POST" && action === "markpaid") {
        const { id, from_pan, to_pan, payment_method } = req.body;
        if (!id || !from_pan || !to_pan) {
          return res.status(400).json({ error: "id, from_pan and to_pan required" });
        }

        const now = new Date().toISOString();
        const batch = db.batch();

        // 1. Fetch invoice to get metadata for dataset
        const invRef = db.collection("orgs").doc(from_pan).collection("invoice_requests").doc(id);
        const invSnap = await invRef.get();
        if (!invSnap.exists) return res.status(404).json({ error: "Invoice not found" });
        const inv = invSnap.data();

        // 2. Update status on both copies
        const paymentUpdate = { paymentStatus: "paid", paidAt: now, updatedAt: now };
        batch.update(db.collection("orgs").doc(from_pan).collection("invoice_requests").doc(id), paymentUpdate);
        batch.update(db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id), paymentUpdate);

        // 3. Write to payment_dataset for both parties
        const createdAt = new Date(inv.createdAt || inv.created_at);
        const acceptedAt = inv.acceptedAt ? new Date(inv.acceptedAt) : new Date();
        const paidAtDate = new Date(now);

        const datasetRecord = {
          invoiceId: id,
          invoiceNumber: inv.invoiceNumber || "",
          fromOrgPan: from_pan,
          fromOrgName: inv.fromOrgName || "",
          toOrgPan: to_pan,
          toOrgName: inv.toOrgName || "",
          amount: inv.grandTotal || inv.amount || 0,
          itemCount: (inv.items || []).length,
          createdAt: inv.createdAt || inv.created_at,
          acceptedAt: inv.acceptedAt || inv.createdAt || now,
          paidAt: now,
          daysToAccept: Math.max(0, Math.floor((acceptedAt - createdAt) / (1000 * 60 * 60 * 24))),
          daysToPay: Math.max(0, Math.floor((paidAtDate - createdAt) / (1000 * 60 * 60 * 24))),
          paymentMethod: payment_method || "manual",
        };

        batch.set(db.collection("orgs").doc(from_pan).collection("payment_dataset").doc(id), datasetRecord);
        batch.set(db.collection("orgs").doc(to_pan).collection("payment_dataset").doc(id), datasetRecord);

        await batch.commit();
        track("invoice_marked_paid", from_pan, { invoice_id: id, method: payment_method });

        return res.status(200).json({ ok: true });
      }

      // ── Reconcile via RazorpayX ─────────────────────────────────────
      if (req.method === "POST" && action === "reconcile") {
        const { pan, account_number } = req.body;
        if (!pan) return res.status(400).json({ error: "pan required" });

        console.log(`[Reconcile] Initiating sync for PAN: ${pan}, Account: ${account_number || "Default"}`);

        const Razorpay = require("razorpay");
        const instance = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID || "dummy_key",
          key_secret: process.env.RAZORPAY_KEY_SECRET || "dummy_secret",
        });

        // 1. Fetch accepted but unpaid invoices for this PAN (as seller)
        const snapshot = await db.collection("orgs").doc(pan).collection("invoice_requests")
          .where("fromOrgPan", "==", pan)
          .where("status", "==", "accepted")
          .get();

        const pendingInvoices = snapshot.docs
          .map((doc) => ({ id: doc.id, ...doc.data() }))
          .filter((inv) => inv.paymentStatus !== "paid");

        if (pendingInvoices.length === 0) return res.json({ matched_count: 0 });

        // 2. Fetch recent payments from Razorpay
        // We use payments.all() which covers standard captured payments
        const paymentsRes = await instance.payments.all({
          count: 50,
        });

        const recentPayments = paymentsRes.items || [];
        let matchedCount = 0;
        const now = new Date().toISOString();
        const batch = db.batch();

        for (const invoice of pendingInvoices) {
          const invoiceAmountPaise = Math.round((invoice.grandTotal || invoice.amount) * 100);

          // Match based on amount and status, or specific notes
          const match = recentPayments.find((p) =>
            p.amount === invoiceAmountPaise &&
            p.status === "captured" &&
            (p.notes.invoice_id === invoice.id || p.notes.invoice_number === invoice.invoiceNumber)
          );

          if (match) {
            const update = {
              paymentStatus: "paid",
              paidAt: now,
              updatedAt: now,
              razorpay_payment_id: match.id,
            };
            batch.update(db.collection("orgs").doc(pan).collection("invoice_requests").doc(invoice.id), update);
            batch.update(db.collection("orgs").doc(invoice.toOrgPan).collection("invoice_requests").doc(invoice.id), update);

            // Dataset record
            const datasetRecord = {
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber || "",
              fromOrgPan: pan,
              fromOrgName: invoice.fromOrgName || "",
              toOrgPan: invoice.toOrgPan,
              toOrgName: invoice.toOrgName || "",
              amount: invoice.grandTotal || invoice.amount || 0,
              itemCount: (invoice.items || []).length,
              createdAt: invoice.createdAt || invoice.created_at,
              acceptedAt: invoice.acceptedAt || invoice.createdAt || now,
              paidAt: now,
              paymentMethod: "razorpay",
              razorpay_payment_id: match.id,
            };
            batch.set(db.collection("orgs").doc(pan).collection("payment_dataset").doc(invoice.id), datasetRecord);
            batch.set(db.collection("orgs").doc(invoice.toOrgPan).collection("payment_dataset").doc(invoice.id), datasetRecord);

            matchedCount++;
          }
        }

        if (matchedCount > 0) await batch.commit();

        track("reconciliation_synced", pan, { matched_count: matchedCount });
        return res.json({ matched_count: matchedCount });
      }

      return res.status(405).json({ error: "Method not allowed or missing action" });

    } catch (err) {
      console.error("Invoice Requests error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
};

module.exports = invoiceRequestsHandler;
