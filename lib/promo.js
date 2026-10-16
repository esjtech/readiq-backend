// Pre-made promo batches. Only SHA-256 hashes live in the repo (promo/*.json), never the codes
// themselves, so pushing this folder to GitHub does not leak them. Redemptions are recorded in
// Firestore (redeemCodes/{CODE}) the first time a code is used.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const byHash = new Map();
const dir = path.join(__dirname, "..", "promo");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const batch = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const h of batch.hashes || []) byHash.set(h, { name: batch.name || f, terms: batch.terms || {} });
    } catch (e) {
      console.error("Could not read promo batch", f, e.message);
    }
  }
}
console.log(`Promo batches loaded: ${byHash.size} codes`);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Returns { name, terms } if this code belongs to a pre-made batch, else null. */
function batchFor(code) {
  return byHash.get(sha256(String(code))) || null;
}

module.exports = { batchFor };
