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

const transactionsHandler = async (req, res) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    const orgId = user.uid;

    try {
        const { action, account_id } = req.query;
        if (req.method === "GET" && action === "get") {
            if (!account_id) return res.status(400).json({ error: "account_id required" });
            const docSnap = await db.collection("orgs").doc(orgId).collection("ledgers").doc(account_id).get();
            if (!docSnap.exists) return res.json({ entries: [] });
            return res.json(docSnap.data());
        }
        return res.status(405).json({ error: "Method not allowed or missing action" });
    } catch (err) {
        console.error("Transactions error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
};

module.exports = functions.https.onRequest(transactionsHandler);
