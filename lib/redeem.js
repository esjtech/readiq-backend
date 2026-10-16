const { db } = require("./firebase");
const { ApiError } = require("./errors");
const { nextExpiry } = require("./plans");
const { batchFor } = require("./promo");

/** Redeems a promo/gift code for a user. Safe against double use and races (one transaction). */
async function redeemCode(uid, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    throw new ApiError(400, "BAD_CODE", "That code doesn't look right. Check it and try again.");
  }

  const userRef = db.collection("users").doc(uid);
  const codeRef = db.collection("redeemCodes").doc(code);

  return db.runTransaction(async (t) => {
    const [c, used, u] = await Promise.all([
      t.get(codeRef),
      t.get(codeRef.collection("redemptions").doc(uid)),
      t.get(userRef),
    ]);

    let d = c.exists ? c.data() : null;
    let batch = null;
    if (!d) {                                   // not in Firestore yet: is it from a pre-made batch?
      batch = batchFor(code);
      if (batch) d = { ...batch.terms, usedCount: 0, active: true };
    }
    if (!d || d.active === false) throw new ApiError(404, "NO_SUCH_CODE", "That code isn't valid.");
    if (d.expiresAtMs && Date.now() > d.expiresAtMs) throw new ApiError(410, "CODE_EXPIRED", "That code has expired.");
    if (d.maxUses && (d.usedCount || 0) >= d.maxUses) throw new ApiError(410, "CODE_USED_UP", "That code has already been used.");
    if (used.exists) throw new ApiError(409, "ALREADY_REDEEMED", "You've already used this code.");

    const tier = d.tier === "LITE_YEARLY" ? "LITE_YEARLY" : "PREMIUM";
    const plan = d.plan || "promo";
    const expiry = nextExpiry(u.data() || {}, tier, Number(d.durationDays) || 30);

    t.set(userRef, { subscriptionTier: tier, premiumPlan: plan, premiumExpiryMs: expiry }, { merge: true });
    if (batch) {
      t.set(codeRef, { ...d, usedCount: 1, batch: batch.name, firstUsedAt: Date.now() });
    } else {
      t.update(codeRef, { usedCount: (d.usedCount || 0) + 1 });
    }
    t.set(codeRef.collection("redemptions").doc(uid), { at: Date.now() });
    return { tier, plan, expiry, days: Number(d.durationDays) || 30 };
  });
}

module.exports = { redeemCode };
