const { ApiError } = require("./errors");

const BASE = (process.env.MONNIFY_BASE_URL || "https://sandbox.monnify.com").replace(/\/$/, "");
let cached = { token: null, exp: 0 };

function need() {
  const { MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE } = process.env;
  if (!MONNIFY_API_KEY || !MONNIFY_SECRET_KEY || !MONNIFY_CONTRACT_CODE) {
    throw new ApiError(503, "PAYMENTS_NOT_CONFIGURED", "Payments aren't set up yet. Please try again later.");
  }
}

async function token() {
  need();
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const basic = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString("base64");
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
  const j = await r.json().catch(() => ({}));
  if (!j.requestSuccessful) {
    console.error("Monnify login failed", r.status, j.responseMessage);
    throw new ApiError(502, "PAYMENTS_AUTH", "Couldn't reach the payment provider. Please try again.");
  }
  cached = { token: j.responseBody.accessToken, exp: Date.now() + Math.max((j.responseBody.expiresIn || 3000) - 120, 60) * 1000 };
  return cached.token;
}

async function initTransaction({ amount, customerName, customerEmail, paymentReference, paymentDescription, redirectUrl }) {
  const t = await token();
  const r = await fetch(`${BASE}/api/v1/merchant/transactions/init-transaction`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({
      amount, customerName, customerEmail, paymentReference, paymentDescription,
      currencyCode: "NGN",
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      redirectUrl,
      paymentMethods: ["CARD", "ACCOUNT_TRANSFER", "USSD"],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.requestSuccessful) {
    console.error("Monnify init failed", r.status, j.responseMessage);
    throw new ApiError(502, "PAYMENTS_INIT", "Couldn't start the payment. Please try again.");
  }
  return j.responseBody; // { transactionReference, paymentReference, checkoutUrl, ... }
}

async function verify(transactionReference) {
  const t = await token();
  const r = await fetch(`${BASE}/api/v2/transactions/${encodeURIComponent(transactionReference)}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!j.requestSuccessful) {
    console.error("Monnify verify failed", r.status, j.responseMessage);
    throw new ApiError(502, "PAYMENTS_VERIFY", "Couldn't confirm the payment yet. Please try again shortly.");
  }
  return j.responseBody; // { paymentStatus, amountPaid, ... }
}

module.exports = { initTransaction, verify };
