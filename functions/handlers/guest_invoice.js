const { db, FieldValue } = require("../admin");
const cors = require("cors")({ origin: true });
const { track } = require("../mixpanel");

// Notification helper (re-used from invoiceRequests or simplified)
async function notifyCounterparty(counterpartyGst, eventType, payload) {
    try {
        const orgDoc = await db.collection("orgs").doc(counterpartyGst).get();
        if (!orgDoc.exists) return { ok: false, reason: "counterparty not registered" };

        // Simplified notification logic for guest actions
        // In a real app, this would use FCM or Webhooks
        console.log(`[GuestInvoice] Notifying ${counterpartyGst} of ${eventType}:`, payload);
        return { ok: true };
    } catch (err) {
        console.error("notifyCounterparty error:", err);
        return { ok: false };
    }
}

const guestInvoiceHandler = async (req, res) => {
    return cors(req, res, async () => {
        try {
            const { action } = req.query;

            // ── GET /guest_invoice?action=get&id=...&to_pan=... ──
            // Fetches invoice details securely for unauthenticated guests
            if (req.method === "GET" && action === "get") {
                const { id, to_pan } = req.query;
                if (!id || !to_pan) {
                    return res.status(400).json({ error: "id and to_pan required" });
                }

                // Fetch from the receiver's collection to verify they are the intended recipient
                const invoiceRef = db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id);
                const invoiceSnap = await invoiceRef.get();

                if (!invoiceSnap.exists) {
                    return res.status(404).json({ error: "Invoice not found" });
                }

                const invoiceData = invoiceSnap.data();

                // Only allow viewing if pending (or maybe allow viewing if accepted/rejected too, but indicate status)
                // Return safe fields
                const safeData = {
                    id: id,
                    fromOrgName: invoiceData.fromOrgName || invoiceData.from_org,
                    fromOrgPan: invoiceData.fromOrgPan,
                    toOrgName: invoiceData.toOrgName || invoiceData.to_org,
                    toOrgPan: invoiceData.toOrgPan,
                    items: invoiceData.items || [],
                    subtotal: invoiceData.subtotal || 0,
                    gst: invoiceData.gst || 0,
                    grandTotal: invoiceData.grandTotal || invoiceData.amount,
                    status: invoiceData.status,
                    createdAt: invoiceData.createdAt || invoiceData.created_at,
                    invoiceNumber: invoiceData.invoiceNumber,
                    notes: invoiceData.notes || invoiceData.description,
                };

                track("guest_invoice_viewed", to_pan, {
                    invoice_id: id,
                    from_org: invoiceData.fromOrgPan || "",
                    status: invoiceData.status,
                });

                return res.status(200).json(safeData);
            }

            // ── POST /guest_invoice?action=respond ──
            // Accepts or rejects the invoice as a guest
            if (req.method === "POST" && action === "respond") {
                const { id, from_pan, to_pan, response_action } = req.body; // response_action: 'accept' | 'reject'

                if (!id || !from_pan || !to_pan || !response_action) {
                    return res.status(400).json({ error: "id, from_pan, to_pan, and response_action required" });
                }

                if (response_action !== "accept" && response_action !== "reject") {
                    return res.status(400).json({ error: "response_action must be 'accept' or 'reject'" });
                }

                const now = new Date().toISOString();
                const invoiceRef = db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id);
                const invoiceSnap = await invoiceRef.get();

                if (!invoiceSnap.exists) {
                    return res.status(404).json({ error: "Invoice not found" });
                }

                const invoiceData = invoiceSnap.data();

                if (invoiceData.status !== "pending") {
                    return res.status(400).json({ error: `Invoice is already ${invoiceData.status}` });
                }

                const batch = db.batch();

                if (response_action === "accept") {
                    // 1. Update status on both copies
                    batch.update(db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id), {
                        status: "accepted", updatedAt: now, acceptedAt: now, paymentStatus: "unpaid"
                    });
                    batch.update(db.collection("orgs").doc(from_pan).collection("invoice_requests").doc(id), {
                        status: "accepted", updatedAt: now, acceptedAt: now, paymentStatus: "unpaid"
                    });

                    // 2. Update receiver's inventory
                    const items = invoiceData.items || [];
                    for (const item of items) {
                        const itemName = item.name || item.itemId || "unknown";
                        const qty = item.quantity || 0;
                        const unitPrice = item.unitPrice || 0;
                        const inventoryRef = db.collection("orgs").doc(to_pan).collection("inventory").doc(itemName);
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
                    notifyCounterparty(from_pan, "invoice_accepted", { invoice_id: id, by: to_pan }).catch(e => console.warn(e));

                    track("guest_invoice_accepted", to_pan, {
                        invoice_id: id,
                        from_org: from_pan,
                        amount: invoiceData.grandTotal || invoiceData.amount || 0,
                    });

                    return res.status(200).json({ ok: true, message: "Invoice accepted successfully" });

                } else if (response_action === "reject") {
                    batch.update(db.collection("orgs").doc(to_pan).collection("invoice_requests").doc(id), {
                        status: "rejected", updatedAt: now
                    });
                    batch.update(db.collection("orgs").doc(from_pan).collection("invoice_requests").doc(id), {
                        status: "rejected", updatedAt: now
                    });

                    await batch.commit();
                    notifyCounterparty(from_pan, "invoice_rejected", { invoice_id: id, by: to_pan }).catch(e => console.warn(e));

                    track("guest_invoice_rejected", to_pan, {
                        invoice_id: id,
                        from_org: from_pan,
                    });

                    return res.status(200).json({ ok: true, message: "Invoice rejected successfully" });
                }
            }

            return res.status(405).json({ error: "Method not allowed or missing valid action" });

        } catch (err) {
            console.error("Guest Invoice error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }
    });
};

module.exports = guestInvoiceHandler;
