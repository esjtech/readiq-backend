// Prices are in Naira. Override with env vars on Render if they change.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const PLANS = {
  lite_yearly: { tier: "LITE_YEARLY", amount: num(process.env.PRICE_LITE_YEARLY, 2500),     days: 365, label: "ReadIQ Lite (1 year)" },
  monthly:     { tier: "PREMIUM",     amount: num(process.env.PRICE_PREMIUM_MONTHLY, 1300), days: 30,  label: "ReadIQ Premium (1 month)" },
  annual:      { tier: "PREMIUM",     amount: num(process.env.PRICE_PREMIUM_ANNUAL, 14000), days: 365, label: "ReadIQ Premium (1 year)" },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reads a users/{uid} document and says what the person currently holds. */
function subscriptionOf(userData) {
  const d = userData || {};
  const tier = d.subscriptionTier || "FREE";
  const expiry = Number(d.premiumExpiryMs || 0);
  const active = (tier === "PREMIUM" || tier === "LITE_YEARLY") && expiry > Date.now();
  return { tier: active ? tier : "FREE", plan: d.premiumPlan || null, expiry, active, rawTier: tier };
}

/** New expiry: stack onto an active paid plan of the same tier, else start now. */
function nextExpiry(userData, newTier, days) {
  const s = subscriptionOf(userData);
  const base = s.active && s.tier === newTier && s.plan !== "trial" ? s.expiry : Date.now();
  return base + days * DAY_MS;
}

module.exports = { PLANS, DAY_MS, subscriptionOf, nextExpiry };
