const functions = require("firebase-functions");
const { db, auth } = require("../admin");

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

const authHandler = async (req, res) => {
    try {
        const { gst_number, otp } = req.query;
        if (req.method !== "POST") {
            return res.status(405).json({ error: "POST only" });
        }

        const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        if (!gstRegex.test(gst_number)) {
            return res.status(400).json({ error: "Invalid GST format" });
        }

        const gstData = await verifyGST(gst_number);
        if (!gstData) {
            return res.status(404).json({ error: "GST not found" });
        }

        if (!otp) {
            await sendOTP(gstData.phone);
            return res.status(200).json({ message: "OTP sent" });
        }

        const otpValid = await verifyOTP(gstData.phone, otp);
        if (!otpValid) {
            return res.status(401).json({ error: "Invalid OTP" });
        }

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
                created_at: new Date().toISOString(),
            });
        }

        const token = await auth.createCustomToken(gst_number);
        return res.status(200).json({ token });
    } catch (err) {
        console.error("Auth error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
};

module.exports = functions.https.onRequest(authHandler);
