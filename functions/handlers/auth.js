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
      if (req.method !== "POST") {
        return res.status(405).json({ error: "POST only" });
      }

      // Get the Firebase ID token from Authorization header or request body
      let idToken = null;

      // Check Authorization header first (Bearer token)
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        idToken = authHeader.split("Bearer ")[1];
      }

      // Fallback to request body
      if (!idToken && req.body && req.body.idToken) {
        idToken = req.body.idToken;
      }

      if (!idToken) {
        return res.status(401).json({
          error: "No authentication token provided",
          message: "Please provide Firebase ID token in Authorization header (Bearer <token>) or in request body as 'idToken'"
        });
      }

      // Verify the Firebase ID token
      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
      } catch (verifyError) {
        console.error("Token verification failed:", verifyError);

        if (verifyError.code === "auth/id-token-expired") {
          return res.status(401).json({ error: "Token expired. Please re-authenticate." });
        } else if (verifyError.code === "auth/argument-error" || verifyError.code === "auth/invalid-id-token") {
          return res.status(401).json({ error: "Invalid token provided." });
        }
        return res.status(401).json({ error: "Token verification failed." });
      }

      // Extract user info from the decoded token
      const uid = decodedToken.uid;
      const phoneNumber = decodedToken.phone_number || null;
      const email = decodedToken.email || null;

      console.log("Authenticated user:", uid, "Phone:", phoneNumber);

      // Check if user/org exists, if not create a basic record
      const orgRef = db.collection("orgs").doc(uid);
      const orgSnap = await orgRef.get();

      if (!orgSnap.exists) {
        // Create a new org record for first-time users
        await orgRef.set({
          uid,
          phone: phoneNumber,
          email: email,
          created_at: new Date().toISOString(),
          is_registered: false, // Flag to indicate profile completion needed
        });
        console.log("Created new org record for user:", uid);
      }

      // Return success with user info
      return res.status(200).json({
        success: true,
        uid: uid,
        phoneNumber: phoneNumber,
        email: email,
        isNewUser: !orgSnap.exists,
        message: "Authentication successful"
      });

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
    const address = req.body.address ? req.body.address.toString().trim() : "";
    // choose uid strategy (use phone-based uid to avoid collisions)
    const uid = `phone:${phone}`;

    try {
      // ensure auth user exists

      await Promise.all([
        // 1. Create or get auth user
        auth.getUser(uid).catch(() =>
          auth.createUser({ uid, phoneNumber: phone, displayName: shopName })
        ),
        // 2. Create or update org document (use set with merge to avoid NOT_FOUND)
        db.collection("orgs").doc(uid).set(
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
        ),
      ]);
      // create org document (id = uid) if not exists
      // const orgRef = db.collection("orgs").doc(uid);
      // const orgSnap = await orgRef.get();
      // if (!orgSnap.exists) {
      //   await orgRef.set({
      //     pan,
      //     ...(gst ? { gst } : {}),
      //     phone,
      //     owner_name: ownerName,
      //     shop_name: shopName,
      //     created_at: new Date().toISOString(),
      //   });
      // }

      // issue custom token so client can sign in
      const customToken = await auth.createCustomToken(uid);
      return res.status(200).json({ customToken });
    } catch (err) {
      console.error("Register error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
});
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

exports.auth = functions.https.onRequest(authHandler);
// exports.register = functions.https.onRequest(async (req, res) => {
//   cors(req, res, async () => {
//     if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
//     const errors = validateRegisterPayload(req.body);
//     if (errors.length) return res.status(400).json({ error: "Invalid payload", details: errors });
//     // ...existing register logic...
//   });
// });

