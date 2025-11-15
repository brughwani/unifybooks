const functions = require("firebase-functions");
const { db, auth } = require("../admin");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
// ---------------- MOCK GST + OTP SERVICES ----------------
async function verifyGST(gst_number) {
  // Replace with real GSTN API integration
  return {
    gst_number,
    legal_name: "Demo Org Pvt Ltd",
    email: "accounts@demo.com",
    phone: "+919876543210",
    state: "Maharashtra",
  };
}
// add PAN verifier (mock)
async function verifyPAN(pan) {
  // Replace with real PAN lookup if available
  return {
    pan,
    legal_name: "Demo Org Pvt Ltd",
    email: "accounts@demo.com",
    phone: "+919876543210",
    state: "Maharashtra",
  };
}

// /**
//  * Sends an OTP to the given phone number for GST login.
//  * Note: This is a mock implementation and should be replaced with a real Twilio/MSG91 integration in production.
//  * @param {string} phone - The phone number to send the OTP to.
//  */
async function sendOTP(phone) {
  // Integrate Twilio/MSG91 in production
  console.log(`Sending OTP to ${phone}`);
}
async function verifyOTP(phone, otp) {
  // Dev-mode OTP
  return otp === "1234";
}


// Initialize Firebase Admin SDK if it hasn't been initialized yet

/**
 * HTTP Cloud Function to verify a Firebase ID token obtained after
 * client-side phone number authentication.
 *
 * This function expects an ID token in the Authorization header.
 *
 * It does NOT handle the initiation of phone number verification or
 * the submission of the OTP. These steps are handled by the Firebase
 * client SDK.
 */
if (!admin.apps.length) {
  admin.initializeApp();
}

exports.verifyPhoneAuthToken = functions.https.onCall(async (data, context) => {
  // Ensure the request is made by an authenticated user, which means
  // context.auth will contain the user's information.
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const idToken = context.rawRequest.headers.authorization?.split("Bearer ")[1];

  if (!idToken) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Firebase ID token not provided in Authorization header."
    );
  }

  try {
    // Verify the ID token using the Firebase Admin SDK.
    // This will throw an error if the token is invalid, expired, or tampered with.
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Ensure the token corresponds to a phone number authenticated user
    // The 'phone_number' field will be present in the decoded token for phone auth users.
    if (!decodedToken.phone_number) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "User is not authenticated with a phone number."
      );
    }

    // You can also check for MFA status if you've implemented it and need to enforce it
    // if (decodedToken.firebase.sign_in_provider !== 'phone') {
    //   throw new functions.https.HttpsError(
    //     'permission-denied',
    //     'User did not sign in with phone authentication provider.'
    //   );
    // }

    // If verification is successful, the user is authenticated.
    // You can now access user information from `decodedToken` and proceed
    // with your API logic.
    console.log("Successfully verified ID token for user:", decodedToken.uid);
    console.log("Phone number:", decodedToken.phone_number);

    // Return some data back to the client
    return {
      status: "success",
      message: "User authenticated successfully via phone number.",
      uid: decodedToken.uid,
      phoneNumber: decodedToken.phone_number,
      // You can return other relevant data as needed
    };

  } catch (error) {
    console.error("Error verifying ID token:", error);
    // Rethrow as HttpsError for client to handle
    if (error.code === "auth/id-token-expired") {
      throw new functions.https.HttpsError("unauthenticated", "Firebase ID token has expired. Please re-authenticate.");
    } else if (error.code === "auth/argument-error" || error.code === "auth/invalid-id-token") {
      throw new functions.https.HttpsError("unauthenticated", "Invalid Firebase ID token provided.");
    } else {
      throw new functions.https.HttpsError(
        "internal",
        "Failed to authenticate user.",
        error.message
      );
    }
  }
});


const authHandler = async (req, res) => {
  return cors(req, res, async () => {
    try {


      const { gst_number, pan, otp } = req.query;
      if (req.method !== "POST") {
        return res.status(405).json({ error: "POST only" });
      }

      const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;
      // normalize inputs: treat missing/empty as not provided
      const gstRaw = (req.query.gst_number ?? "").toString().trim();
      const panRaw = (req.query.pan ?? "").toString().trim();
      //const otp = (req.query.otp ?? '').toString().trim();
      console.log("Auth request for GST:", gstRaw, "PAN:", panRaw);

      if (!panRaw) {
        return res.status(400).json({ error: "pan is required" });
      }

      // validate only when provided
      if (gstRaw && !gstRegex.test(gstRaw)) {
        return res.status(400).json({ error: "Invalid GST format" });
      }
      if (panRaw && !panRegex.test(panRaw)) {
        return res.status(400).json({ error: "Invalid PAN format" });
      }
      // Determine identity source: prefer GST, fall back to PAN
      let identityData = null;
      let uid = null;


      if (gst_number !== undefined && gst_number !== null) {
        if (!gstRegex.test(gst_number)) {
          return res.status(400).json({ error: "Invalid GST format" });
        }
        identityData = await verifyGST(gst_number);
        uid = gst_number;
      } else if (pan) {
        if (!panRegex.test(pan)) {
          return res.status(400).json({ error: "Invalid PAN format" });
        }
        identityData = await verifyPAN(pan);
        // use a namespaced uid to avoid collisions with GST uids
        uid = `pan:${pan.toString().trim().toUpperCase()}`;
        console.log("Using PAN-based UID:", uid);
      } else {
        return res.status(400).json({ error: "gst_number or pan is required" });
      }

      if (!identityData) {
        return res.status(404).json({ error: "Identity not found" });
      }
      if (!otp) {
        await sendOTP(identityData.phone);
        return res.status(200).json({ message: "OTP sent" });
      }

      const otpValid = await verifyOTP(identityData.phone, otp);
      if (!otpValid) {
        return res.status(401).json({ error: "Invalid OTP" });
      }

      try {
        await auth.getUser(gst_number);
      } catch {
        await auth.createUser({
          uid: uid,
          email: identityData.email,
          displayName: identityData.legal_name,
        });
        await db.collection("orgs").doc(uid).set({
          uid,
          ...identityData,
          created_at: new Date().toISOString(),
        });
      }

      const token = await auth.createCustomToken(uid);
      return res.status(200).json({ token });
    } catch (err) {
      console.error("Auth error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
};

function validateRegisterPayload(body) {
  const errors = [];
  if (!body.phone) errors.push("phone is required");
  if (!body.pan) errors.push("pan is required");
  if (!body.owner_name && !body.ownerName) errors.push("owner_name is required");
  if (!body.shop_name && !body.shopName && !body.firm_name) errors.push("shop_name is required");
  return errors;
}

exports.register = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const errors = validateRegisterPayload(req.body);
    if (errors.length) return res.status(400).json({ error: "Invalid payload", details: errors });

    const phone = req.body.phone.toString().trim(); // e.g. +911234567890
    const pan = req.body.pan.toString().trim().toUpperCase();
    const gst = req.body.gst ? req.body.gst.toString().trim().toUpperCase() : null;
    const ownerName = (req.body.owner_name || req.body.ownerName).toString().trim();
    const shopName = (req.body.shop_name || req.body.shopName || req.body.firm_name || req.body.shop).toString().trim();

    // choose uid strategy (use phone-based uid to avoid collisions)
    const uid = `phone:${phone}`;

    try {
      // ensure auth user exists
      try {
        await auth.getUser(uid);
      } catch (e) {
        await auth.createUser({ uid, phoneNumber: phone, displayName: shopName });
      }

      // create org document (id = uid) if not exists
      const orgRef = db.collection("orgs").doc(uid);
      const orgSnap = await orgRef.get();
      if (!orgSnap.exists) {
        await orgRef.set({
          pan,
          ...(gst ? { gst } : {}),
          phone,
          owner_name: ownerName,
          shop_name: shopName,
          created_at: new Date().toISOString(),
        });
      }

      // issue custom token so client can sign in
      const customToken = await auth.createCustomToken(uid);
      return res.status(200).json({ customToken });
    } catch (err) {
      console.error("Register error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
});
module.exports = functions.https.onRequest(authHandler);
