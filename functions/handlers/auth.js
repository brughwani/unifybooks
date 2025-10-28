const functions = require("firebase-functions");
const { db, auth } = require("../admin");
const admin = require("firebase-admin");
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
