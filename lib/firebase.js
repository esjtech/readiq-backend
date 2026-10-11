const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set (paste the full service-account JSON).");

let creds;
try { creds = JSON.parse(raw); }
catch { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded file contents."); }

admin.initializeApp({ credential: admin.credential.cert(creds) });

module.exports = { admin, db: admin.firestore(), auth: admin.auth() };
