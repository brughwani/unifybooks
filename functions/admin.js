const { initializeApp, applicationDefault } = require("firebase-admin/app");
//const { getFirestore, FieldValue } = require("firebase-admin/firestore");
//const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK only once
if (!admin.apps.length) {
  admin.initializeApp();
}

// Export Firestore and Auth instances
const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth, admin };
if (!global._firebaseApp) {
  initializeApp({ credential: applicationDefault() });
  global._firebaseApp = true;
}

//const db = getFirestore();
//const auth = getAuth();
const messaging = getMessaging();

module.exports = { db, auth, messaging };
