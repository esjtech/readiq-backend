// Creates a promo/gift code.  Usage:
//   FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/create-code.js CODE TIER PLAN DAYS [MAX_USES]
//   e.g.  node scripts/create-code.js READIQ2026 PREMIUM monthly 30 100
const { db } = require("../lib/firebase");

(async () => {
  const [code, tier = "PREMIUM", plan = "promo", days = "30", maxUses] = process.argv.slice(2);
  if (!code) { console.error("Usage: node scripts/create-code.js CODE TIER PLAN DAYS [MAX_USES]"); process.exit(1); }
  if (!["PREMIUM", "LITE_YEARLY"].includes(tier)) { console.error("TIER must be PREMIUM or LITE_YEARLY"); process.exit(1); }
  await db.collection("redeemCodes").doc(code.toUpperCase()).set({
    tier, plan, durationDays: Number(days), maxUses: maxUses ? Number(maxUses) : null,
    usedCount: 0, active: true, createdAt: Date.now(),
  });
  console.log(`Created ${code.toUpperCase()} → ${tier} for ${days} days` + (maxUses ? ` (max ${maxUses} uses)` : ""));
  process.exit(0);
})();
