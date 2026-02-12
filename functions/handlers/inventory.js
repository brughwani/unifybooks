
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

const inventoryHandler = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const orgId = user.uid;

  try {
    const { action } = req.query;
    if (req.method === "POST" && action === "create") {
      const data = { ...req.body, created_at: new Date().toISOString() };
      const ref = await db.collection("orgs").doc(orgId).collection("items").add(data);
      return res.status(201).json({ id: ref.id });
    }
    if (req.method === "GET" && action === "list") {
      const snapshot = await db.collection("orgs").doc(orgId).collection("items").get();
      return res.json(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
    return res.status(405).json({ error: "Method not allowed or missing action" });
  } catch (err) {
    console.error("Inventory error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = inventoryHandler;
