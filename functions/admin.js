const admin = require("firebase-admin");

// 1. Initialize only if no apps exist
if (!admin.apps.length) {
  admin.initializeApp();
}

// 2. Extract services
const db = admin.firestore();
const auth = admin.auth();
const messaging = admin.messaging();

// 3. Export everything once
module.exports = { db, auth, messaging, admin };