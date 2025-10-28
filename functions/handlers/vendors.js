const functions = require("firebase-functions");
const { db, auth } = require("../admin");

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

function validateVendorPayload(payload) {
  const errors = [];

  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;
  const phoneRegex = /^\+?[0-9]{10,15}$/;

  if (!payload) {
    errors.push("Missing payload");
    return errors;
  }

  const gst = (payload.gst || "").toString().trim();
  const pan = (payload.pan || "").toString().trim();
  const phone = (payload.phone || "").toString().trim();
  const ownerName = (payload.owner_name || payload.ownerName || "").toString().trim();
  const shopName = (payload.shop_name || payload.shopName || payload.firm_name || payload.shop || "").toString().trim();

  if (!gst) errors.push("gst is required");
  else if (!gstRegex.test(gst)) errors.push("gst has invalid format");

  if (!pan) errors.push("pan is required");
  else if (!panRegex.test(pan)) errors.push("pan has invalid format");

  if (!phone) errors.push("phone is required");
  else if (!phoneRegex.test(phone)) errors.push("phone has invalid format");

  if (!ownerName) errors.push("owner_name is required");
  if (!shopName) errors.push("shop/firm name is required");

  return errors;
}


const vendorsHandler = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const orgId = user.uid;

  try {
    const { action } = req.query;
    if (req.method === "POST" && action === "create") {
      const errors = validateVendorPayload(req.body);
      if (errors.length) return res.status(400).json({ error: "Invalid payload", details: errors });
      const vendor = {
        gst: req.body.gst.toString().trim().toUpperCase(),
        pan: req.body.pan.toString().trim().toUpperCase(),
        phone: req.body.phone.toString().trim(),
        address: req.body.address.toString().trim(),
        owner_name: (req.body.owner_name || req.body.ownerName).toString().trim(),
        shop_name: (req.body.shop_name || req.body.shopName || req.body.firm_name || req.body.shop).toString().trim(),
        created_at: new Date().toISOString(),
        // copy any additional allowed fields here if needed
      };

      const data = { ...vendor };
      const ref = await db.collection("orgs").doc(orgId).collection("accounts").add(data);
      await db.collection("orgs").doc(orgId).collection("ledgers").doc(ref.id).set({ entries: [] });
      return res.status(201).json({ id: ref.id });
    }

    // Normalize fields


    if (req.method === "GET" && action === "list") {
      const snapshot = await db.collection("orgs").doc(orgId).collection("accounts").get();
      return res.json(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
    return res.status(405).json({ error: "Method not allowed or missing action" });
  } catch (err) {
    console.error("Vendors error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = functions.https.onRequest(vendorsHandler);
