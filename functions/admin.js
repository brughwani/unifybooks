const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");

if (!global._firebaseApp) {
    initializeApp({ credential: applicationDefault() });
    global._firebaseApp = true;
}

const db = getFirestore();
const auth = getAuth();
const messaging = getMessaging();

module.exports = { db, auth, messaging, FieldValue };
