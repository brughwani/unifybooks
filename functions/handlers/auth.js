const functions = require("firebase-functions/v2");
const { db, auth } = require("../admin");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
// ---------------- MOCK GST + OTP SERVICES ----------------
// async function verifyGST(gst_number) {
//   // Replace with real GSTN API integration
//   return {
//     gst_number,
//     legal_name: "Demo Org Pvt Ltd",
//     email: "accounts@demo.com",
//     phone: "+919876543210",
//     state: "Maharashtra",
//   };
// }
// add PAN verifier (mock)
// async function verifyPAN(pan) {
//   // Replace with real PAN lookup if available
//   return {
//     pan,
//     legal_name: "Demo Org Pvt Ltd",
//     email: "accounts@demo.com",
//     phone: "+919876543210",
//     state: "Maharashtra",
//   };
// }

// /**
//  * Sends an OTP to the given phone number for GST login.
//  * Note: This is a mock implementation and should be replaced with a real Twilio/MSG91 integration in production.
//  * @param {string} phone - The phone number to send the OTP to.
//  */
// async function sendOTP(phone) {
//   // Integrate Twilio/MSG91 in production
//   console.log(`Sending OTP to ${phone}`);
// }
// async function verifyOTP(phone, otp) {
//   // Dev-mode OTP
//   return otp === "1234";
// }


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

exports.getPhoneByPan = functions.https.onCall(async (data, context) => {
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
      console.log(`[AuthHandler] Request received: ${req.method} ${req.url}`);

      // Log service account info if possible for debugging
      try {
        const app = admin.app();
        const projectId = app.options.projectId || process.env.GCLOUD_PROJECT;
        console.log(`[AuthHandler] Running in project: ${projectId}`);
      } catch (e) {
        console.log("[AuthHandler] Could not get project ID", e.message);
      }

      if (req.method !== "GET") {
        return res.status(405).json({ error: "GET only" });
      }

      const pan = req.query.pan?.toString().trim().toUpperCase();
      const authHeader = req.headers.authorization;

      // CASE 1: PAN lookup (get phone number)
      if (pan) {
        try {
          console.log(`[AuthHandler] Looking up PAN: ${pan}`);
          const orgsSnapshot = await db.collection("orgs")
            .where("pan", "==", pan)
            .limit(1)
            .get();

          if (orgsSnapshot.empty) {
            console.log(`[AuthHandler] No user found for PAN: ${pan}`);
            return res.status(404).json({ error: "No user found with this PAN" });
          }

          const orgData = orgsSnapshot.docs[0].data();
          console.log(`[AuthHandler] Found user for PAN: ${pan}, returning phone.`);
          return res.status(200).json({ phone: orgData.phone });
        } catch (err) {
          console.error("[AuthHandler] getPhoneByPan error:", err);
          return res.status(500).json({
            error: "Internal server error during PAN lookup",
            details: err.message,
            code: err.code
          });
        }
      }

      // CASE 2: Token verification (after Firebase phone auth)
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const idToken = authHeader.split("Bearer ")[1];

        try {
          console.log("[AuthHandler] Verifying ID token...");
          const decodedToken = await admin.auth().verifyIdToken(idToken);

          if (!decodedToken.phone_number) {
            console.warn("[AuthHandler] Token verified but no phone_number claim.");
            return res.status(403).json({ error: "User not authenticated with phone" });
          }

          console.log("[AuthHandler] Token verified successfully:", decodedToken.uid, "Phone:", decodedToken.phone_number);

          return res.status(200).json({
            success: true,
            uid: decodedToken.uid,
            phoneNumber: decodedToken.phone_number,
          });
        } catch (verifyError) {
          console.error("[AuthHandler] Token verification failed:", verifyError);
          console.error("[AuthHandler] Error code:", verifyError.code);
          console.error("[AuthHandler] Error message:", verifyError.message);

          return res.status(401).json({
            error: "Invalid or expired token",
            details: verifyError.message,
            code: verifyError.code
          });
        }
      }

      return res.status(400).json({ error: "PAN or Authorization token required" });
    } catch (err) {
      console.error("[AuthHandler] Top-level error:", err);
      return res.status(500).json({
        error: "Internal server error",
        message: err.message,
        code: err.code
      });
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

exports.register = async (req, res) => {
  return cors(req, res, async () => {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const errors = validateRegisterPayload(req.body);
    if (errors.length) return res.status(400).json({ error: "Invalid payload", details: errors });

    const phone = req.body.phone.toString().trim(); // e.g. +911234567890
    const pan = req.body.pan.toString().trim().toUpperCase();
    const gst = req.body.gst ? req.body.gst.toString().trim().toUpperCase() : null;
    const ownerName = (req.body.owner_name || req.body.ownerName).toString().trim();
    const shopName = (req.body.shop_name || req.body.shopName || req.body.firm_name || req.body.shop).toString().trim();
    const address = req.body.address ? req.body.address.toString().trim() : "";
    // choose uid strategy (use phone-based uid to avoid collisions)
    const uid = `phone:${phone}`;

    try {
      // Step 1: Create or get auth user (do this FIRST)
      try {
        console.log(`[Register] Checking if user ${uid} exists...`);
        await auth.getUser(uid);
        console.log(`[Register] Auth user ${uid} already exists.`);
      } catch (authErr) {
        if (authErr.code === 'auth/user-not-found') {
          console.log(`[Register] Creating new auth user: ${uid}`);
          await auth.createUser({ uid, phoneNumber: phone, displayName: shopName });
          console.log(`[Register] User created: ${uid}`);
        } else {
          console.error(`[Register] auth.getUser failed:`, authErr);
          throw authErr;
        }
      }

      // Step 2: Create/update Firestore org document (AFTER auth succeeds)
      console.log(`[Register] Writing Firestore doc: orgs/${uid}`);
      await db.collection("orgs").doc(uid).set(
        {
          pan,
          ...(gst ? { gst } : {}),
          phone,
          owner_name: ownerName,
          shop_name: shopName,
          address: address,
          created_at: new Date().toISOString(),
        },
        { merge: true }
      );

      console.log(`[Register] Firestore write successful.`);

      // Step 3: Issue custom token so client can sign in
      console.log(`[Register] Creating custom token for ${uid}...`);
      const customToken = await auth.createCustomToken(uid);
      console.log(`[Register] Custom token created successfully.`);

      return res.status(200).json({ customToken });
    } catch (err) {
      console.error("[Register] Critical error:", err);
      console.error("[Register] Error code:", err.code);
      console.error("[Register] Error message:", err.message);

      return res.status(500).json({
        error: "Internal server error during registration",
        message: err.message,
        code: err.code,
      });
    }
  });
};


// exports.register = functions.https.onRequest(async (req, res) => {
//   cors(req, res, async () => {
//     if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

//     const errors = validateRegisterPayload(req.body);
//     if (errors.length) return res.status(400).json({ error: "Invalid payload", details: errors });

//     const phone = req.body.phone.toString().trim();
//     const pan = req.body.pan.toString().trim().toUpperCase();
//     const gst = req.body.gst ? req.body.gst.toString().trim().toUpperCase() : null;
//     const ownerName = (req.body.owner_name || req.body.ownerName).toString().trim();
//     const shopName = (req.body.shop_name || req.body.shopName || req.body.firm_name || req.body.shop).toString().trim();

//     // Sanitize UID to ensure no invalid characters cause path issues
//     // Note: Firestore IDs cannot contain forward slashes '/'
//     const uid = `phone:${phone.replace(/\//g, "_")}`;

//     console.log(`[Register] Attempting to register UID: ${uid}`);

//     try {
//       // Step 1: Handle Auth User
//       try {
//         await auth.getUser(uid);
//         console.log(`[Register] User ${uid} already exists.`);
//       } catch (authErr) {
//         if (authErr.code === "auth/user-not-found") {
//           console.log(`[Register] Creating new user for ${uid}`);
//           await auth.createUser({
//             uid,
//             phoneNumber: phone,
//             displayName: shopName
//           });
//         } else {
//           throw authErr; // Throw real auth errors
//         }
//       }

//       // Step 2: Write to Firestore
//       // We do this AFTER auth to ensure we don't write orphaned records if auth fails
//       const orgData = {
//         pan,
//         phone,
//         owner_name: ownerName,
//         shop_name: shopName,
//         created_at: new Date().toISOString(),
//       };
//       if (gst) orgData.gst = gst;

//       console.log(`[Register] Writing to Firestore path: orgs/${uid}`);

//       // Using set with merge is correct here
//       await db.collection("orgs").doc(uid).set(orgData, { merge: true });

//       // Step 3: Create Token
//       const customToken = await auth.createCustomToken(uid);

//       return res.status(200).json({ customToken });

//     } catch (err) {
//       console.error("Register CRITICAL error:", err);
//       // Return the actual error message in dev mode to help you debug
//       return res.status(500).json({
//         error: "Internal server error",
//         message: err.message,
//         code: err.code
//       });
//     }
//   });
// });
// module.exports = functions.https.onRequest(authHandler);

exports.auth = authHandler;
// exports.register = functions.https.onRequest(async (req, res) => {
//   cors(req, res, async () => {
//     if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
//     const errors = validateRegisterPayload(req.body);
//     if (errors.length) return res.status(400).json({ error: "Invalid payload", details: errors });
//     // ...existing register logic...
//   });
// });

