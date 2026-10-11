const crypto = require("crypto");
const { ApiError } = require("./errors");

const BASE = "https://api.paystack.co";

function secret() {
  const k = process.env.PAYSTACK_SECRET_KEY;
  if (!k) throw new ApiError(503, "PAYMENTS_NOT_CONFIGURED", "Payments aren't set up yet. Please try again later.");
  return k;
}

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${secret()}`, "content-type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.error("Paystack network error:", e.message);
    throw new ApiError(504, "PAYMENTS_TIMEOUT", "The payment provider took too long to respond. Please try again.");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.status !== true) {
    console.error("Paystack error", res.status, j.message);
    throw new ApiError(502, "PAYMENTS_ERROR", "Couldn't reach the payment provider. Please try again.");
  }
  return j.data;
}

/** amountNaira is converted to kobo (Paystack's smallest unit). */
async function initTransaction({ amountNaira, email, reference, callbackUrl, metadata }) {
  const d = await call("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email, reference, currency: "NGN",
      amount: Math.round(amountNaira * 100),
      callback_url: callbackUrl,
      metadata,
    }),
  });
  return { checkoutUrl: d.authorization_url, reference: d.reference };
}

/** Returns { status: 'success' | 'failed' | 'abandoned' | ..., amountKobo, currency, reference } */
async function verify(reference) {
  const d = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
  return { status: d.status, amountKobo: Number(d.amount), currency: d.currency, reference: d.reference };
}

/** Paystack signs webhooks with HMAC-SHA512 of the raw body using your secret key. */
function validSignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac("sha512", secret()).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initTransaction, verify, validSignature };
