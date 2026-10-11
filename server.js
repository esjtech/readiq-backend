// ReadIQ API – deployed on Render. All secrets live in Render's environment variables.
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const { admin, db, auth } = require("./lib/firebase");
const { ApiError, sendError } = require("./lib/errors");
const { PLANS, DAY_MS, subscriptionOf, nextExpiry } = require("./lib/plans");
const credits = require("./lib/credits");
const ai = require("./lib/ai");
const monnify = require("./lib/monnify");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));
app.use(rateLimit({ windowMs: 60_000, max: 90, standardHeaders: true, legacyHeaders: false }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => sendError(res, e));
const userRef = (uid) => db.collection("users").doc(uid);
const loadUser = async (uid) => { const s = await userRef(uid).get(); return s.exists ? s.data() : {}; };
const publicUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

// ───────────── Health + payment landing page (no auth) ─────────────
app.get("/", (_q, r) => r.json({ name: "ReadIQ API", ok: true }));
app.get("/health", (_q, r) => r.json({ ok: true }));
app.get("/api/payment-callback", (_q, r) =>
  r.type("html").send("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;text-align:center;padding:48px'><h3>Payment received</h3><p>Returning you to ReadIQ…</p>"));

// ───────────── Auth: every /api route below needs a Firebase ID token ─────────────
app.use("/api", async (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return sendError(res, new ApiError(401, "NO_TOKEN", "Please sign in again."));
  try {
    const d = await auth.verifyIdToken(token);
    req.uid = d.uid; req.email = d.email || "";
    next();
  } catch {
    sendError(res, new ApiError(401, "BAD_TOKEN", "Your session expired. Please sign in again."));
  }
});

/** Charges credits for a feature, and tells us what the user holds. */
async function meter(req, feature) {
  const sub = subscriptionOf(await loadUser(req.uid));
  const refund = await credits.spend(req.uid, feature, sub.active);
  return { sub, premium: sub.tier === "PREMIUM", refund };
}

// ───────────── AI: summarize ─────────────
app.post("/api/summarize", wrap(async (req, res) => {
  const text = ai.clip(req.body.text, 60_000).trim();
  if (text.length < 20) throw new ApiError(400, "TEXT_TOO_SHORT", "There isn't enough text to summarize.");
  const { premium, refund } = await meter(req, "summary");
  try {
    const summary = await ai.claude({
      system: "You summarize study material for students. Write a one-sentence overview, then 4-8 short bullet points covering the key ideas. Plain text, no headings, no preamble.",
      messages: [{ role: "user", content: text }],
      maxTokens: premium ? 1500 : 800,
    });
    res.json({ success: true, summary });
  } catch (e) { await refund(); throw e; }
}));

// ───────────── AI: quiz ─────────────
app.post("/api/generate-quiz", wrap(async (req, res) => {
  const b = req.body || {};
  const source = ai.clip(b.sourceText, 60_000).trim();
  if (source.length < 50) throw new ApiError(400, "TEXT_TOO_SHORT", "There isn't enough text to build a quiz from.");
  const { premium, refund } = await meter(req, "quiz");

  const count = Math.min(Math.max(parseInt(b.questionCount, 10) || 5, 1), premium ? 30 : 15);
  const type = ["MULTIPLE_CHOICE", "TRUE_FALSE", "SHORT_ANSWER"].includes(b.questionType) ? b.questionType : "MULTIPLE_CHOICE";
  const difficulty = ["Easy", "Medium", "Hard"].includes(b.difficulty) ? b.difficulty : "Medium";
  const title = ai.clip(b.title || "AI Quiz", 120);
  const explain = b.includeExplanations !== false;

  const shape = {
    MULTIPLE_CHOICE: 'each question has "options": exactly 4 strings and "correctAnswerIndex": 0-3',
    TRUE_FALSE: 'each question has "options": ["True","False"] and "correctAnswerIndex": 0 for True or 1 for False',
    SHORT_ANSWER: 'each question has "options": [] and a "modelAnswer" string (1-2 sentences); "correctAnswerIndex": -1',
  }[type];

  try {
    const raw = await ai.claude({
      system: `You write quizzes from study material. Reply with ONLY a JSON object, no markdown: {"title": string, "questions": [{"question": string, "options": string[], "correctAnswerIndex": number, "modelAnswer": string, "explanation": string}]}. Write exactly ${count} ${difficulty.toLowerCase()} questions; ${shape}. ${explain ? 'Each "explanation" is one short sentence.' : 'Set "explanation" to "".'} Only use facts found in the material.`,
      messages: [{ role: "user", content: `Quiz title: ${title}\n\nMaterial:\n${source}` }],
      maxTokens: Math.min(600 + count * 260, 8000),
    });

    let parsed;
    try { parsed = ai.parseJsonObject(raw); }
    catch { throw new ApiError(502, "AI_BAD_OUTPUT", "The AI returned an unreadable quiz. Please try again."); }

    const questions = (Array.isArray(parsed.questions) ? parsed.questions : []).map((q) => {
      let options = Array.isArray(q.options) ? q.options.map(String) : [];
      if (type === "TRUE_FALSE") options = ["True", "False"];
      if (type === "SHORT_ANSWER") options = [];
      let idx = Number.isInteger(q.correctAnswerIndex) ? q.correctAnswerIndex : 0;
      if (type !== "SHORT_ANSWER" && (idx < 0 || idx >= options.length)) idx = 0;
      return {
        question: String(q.question || "").trim(),
        options, correctAnswerIndex: type === "SHORT_ANSWER" ? -1 : idx,
        modelAnswer: String(q.modelAnswer || ""), explanation: String(q.explanation || ""),
      };
    }).filter((q) => q.question && (type === "SHORT_ANSWER" ? q.modelAnswer : q.options.length >= 2));

    if (!questions.length) throw new ApiError(502, "AI_NO_QUESTIONS", "The AI couldn't build questions from this text. Try different material.");
    res.json({ success: true, title: String(parsed.title || title), questions });
  } catch (e) { await refund(); throw e; }
}));

// ───────────── AI: tutor (Premium) ─────────────
app.post("/api/tutor/chat", wrap(async (req, res) => {
  const sub = subscriptionOf(await loadUser(req.uid));
  if (sub.tier !== "PREMIUM") throw new ApiError(403, "AI_PREMIUM_REQUIRED", "AI Tutor is a ReadIQ Premium feature.");

  let msgs = (Array.isArray(req.body.messages) ? req.body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .map((m) => ({ role: m.role, content: ai.clip(m.content, 6000) }))
    .slice(-20);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw new ApiError(400, "NO_MESSAGE", "Please type a question first.");

  const context = ai.clip(req.body.context, 3000).trim();
  const svgRule = req.body.illustration_mode
    ? "When a diagram would genuinely help, add ONE simple illustration as a self-contained SVG wrapped in [SVG]...[/SVG] after your explanation (use a viewBox, plain shapes and text, no scripts, no external images). Skip it when it wouldn't help."
    : "Do not include SVG.";

  const { refund } = await meter(req, "tutor");
  try {
    const reply = ai.sanitizeSvgBlocks(await ai.claude({
      system: `You are ReadIQ's friendly AI tutor. Explain clearly, step by step, at a student's level. Keep answers focused and use short paragraphs. ${svgRule}${context ? `\n\nThe student is reading this material:\n${context}` : ""}`,
      messages: msgs,
      maxTokens: 1800,
    }));
    if (!reply) throw new ApiError(502, "AI_EMPTY", "The tutor didn't reply. Please try again.");
    res.json({ success: true, reply });
  } catch (e) { await refund(); throw e; }
}));

// ───────────── Audio: text-to-speech (needs OPENAI_API_KEY) ─────────────
const VOICES = {
  default: { voice: "alloy" }, male: { voice: "onyx" }, female: { voice: "nova" },
  calm: { voice: "shimmer", speed: 0.92 }, energetic: { voice: "echo", speed: 1.1 },
};
app.post("/api/tts", wrap(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) throw new ApiError(503, "VOICE_NOT_CONFIGURED", "AI voice isn't available yet.");
  const text = ai.clip(req.body.text, 4000).trim();
  if (!text) throw new ApiError(400, "NO_TEXT", "There's no text to read.");
  const v = VOICES[req.body.voiceStyle] || VOICES.default;
  const { refund } = await meter(req, "voice");
  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "tts-1", input: text, response_format: "mp3", ...v }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!r.ok) { console.error("TTS error", r.status, (await r.text()).slice(0, 300)); throw new ApiError(502, "VOICE_FAILED", "Voice generation failed. Please try again."); }
    res.type("audio/mpeg").send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { await refund(); throw e instanceof ApiError ? e : new ApiError(504, "VOICE_TIMEOUT", "Voice generation took too long. Please try again."); }
}));

// ───────────── Audio: transcription (needs OPENAI_API_KEY) ─────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single("audio");
const parseUpload = (req, res) => new Promise((ok, no) => upload(req, res, (e) =>
  e ? no(e.code === "LIMIT_FILE_SIZE" ? new ApiError(413, "FILE_TOO_BIG", "That recording is too large (25 MB max).") : new ApiError(400, "BAD_UPLOAD", "Couldn't read the upload.")) : ok()));

app.post("/api/transcribe-audio", wrap(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) throw new ApiError(503, "STT_NOT_CONFIGURED", "Audio transcription isn't available yet.");
  await parseUpload(req, res);
  if (!req.file?.buffer?.length) throw new ApiError(400, "NO_AUDIO", "No audio was received.");
  const { refund } = await meter(req, "transcribe");
  try {
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "audio/mp4" }), req.file.originalname || "audio.m4a");
    form.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
    form.append("response_format", "json");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form,
      signal: AbortSignal.timeout(170_000),
    });
    if (!r.ok) { console.error("STT error", r.status, (await r.text()).slice(0, 300)); throw new ApiError(502, "STT_FAILED", "Transcription failed. Please try again."); }
    let text = String((await r.json()).text || "").trim();
    let cleaned = false;
    if (text && text.length < 60_000 && process.env.ANTHROPIC_API_KEY) {
      try {
        text = await ai.claude({
          system: "You clean up speech transcripts. Fix punctuation, capitalization and paragraph breaks and remove filler words. Never add, remove or change facts. Reply with only the cleaned transcript.",
          messages: [{ role: "user", content: text }], maxTokens: 8000,
        }) || text;
        cleaned = true;
      } catch { /* keep the raw transcript */ }
    }
    res.json({ success: true, text, cleaned });
  } catch (e) { await refund(); throw e instanceof ApiError ? e : new ApiError(504, "STT_TIMEOUT", "Transcription took too long. Try a shorter recording."); }
}));

// ───────────── Word/Office → PDF (not built yet) ─────────────
app.post("/api/convert-doc-to-pdf", wrap(async () => {
  throw new ApiError(501, "NOT_IMPLEMENTED", "Document conversion isn't available yet.");
}));

// ───────────── Credits + usage ─────────────
const unmeteredFor = async (uid) => subscriptionOf(await loadUser(uid)).active;

app.get("/api/credits", wrap(async (req, res) => {
  res.json({ success: true, ...(await credits.getBalance(req.uid, await unmeteredFor(req.uid))) });
}));

// NOTE: trusts the app to say an ad finished (capped per day). Add AdMob server-side verification before launch.
app.post("/api/credits/reward", wrap(async (req, res) => {
  res.json({ success: true, balance: await credits.claimAdReward(req.uid, await unmeteredFor(req.uid)) });
}));

app.get("/api/ai-usage", wrap(async (req, res) => {
  const unmetered = await unmeteredFor(req.uid);
  res.json({ success: true, isPremium: unmetered, enforcement: { blocking: true },
    features: await credits.usageReport(req.uid, unmetered) });
}));

// ───────────── Welcome trial (3-day Premium, once per account) ─────────────
app.post("/api/start-trial", wrap(async (req, res) => {
  const ref = userRef(req.uid);
  const out = await db.runTransaction(async (t) => {
    const d = (await t.get(ref)).data() || {};
    if (d.freeTrialUsed) throw new ApiError(409, "TRIAL_USED", "Your free trial has already been used.");
    if (subscriptionOf(d).active) throw new ApiError(409, "ALREADY_SUBSCRIBED", "You already have an active plan.");
    const expiry = Date.now() + 3 * DAY_MS;
    t.set(ref, { subscriptionTier: "PREMIUM", premiumPlan: "trial", premiumExpiryMs: expiry,
      freeTrialUsed: true, freeTrialStartedAt: Date.now() }, { merge: true });
    return expiry;
  });
  res.json({ success: true, tier: "PREMIUM", plan: "trial", premiumExpiryMs: out });
}));

// ───────────── Payments (Monnify) ─────────────
app.post("/api/init-payment", wrap(async (req, res) => {
  const planKey = String(req.body.plan || "");
  const plan = PLANS[planKey];
  if (!plan) throw new ApiError(400, "BAD_PLAN", "That plan is no longer available.");
  const email = req.email || String(req.body.email || "").trim();
  if (!email) throw new ApiError(400, "NO_EMAIL", "We need an email address on your account to take payment.");

  const paymentReference = `RIQ${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const base = publicUrl();
  const init = await monnify.initTransaction({
    amount: plan.amount,
    customerName: ai.clip(req.body.name || "ReadIQ User", 80),
    customerEmail: email,
    paymentReference,
    paymentDescription: plan.label,
    redirectUrl: `${base}/api/payment-callback`,
  });

  await db.collection("payments").doc(paymentReference).set({
    uid: req.uid, plan: planKey, amount: plan.amount, status: "PENDING",
    transactionReference: init.transactionReference, createdAt: Date.now(),
  });
  res.json({ success: true, checkoutUrl: init.checkoutUrl, transactionReference: init.transactionReference });
}));

async function findPayment(reference) {
  const q = await db.collection("payments").where("transactionReference", "==", reference).limit(1).get();
  if (!q.empty) return q.docs[0];
  const d = await db.collection("payments").doc(reference).get();
  return d.exists ? d : null;
}

app.post("/api/verify-payment", wrap(async (req, res) => {
  const reference = String(req.body.reference || "").trim();
  if (!reference) throw new ApiError(400, "NO_REFERENCE", "Missing payment reference.");
  const doc = await findPayment(reference);
  // Plan + owner come from OUR record, never from the app's request.
  if (!doc || doc.data().uid !== req.uid) throw new ApiError(404, "UNKNOWN_PAYMENT", "We couldn't find that payment.");

  const pay = doc.data();
  if (pay.status !== "PAID") {
    const v = await monnify.verify(pay.transactionReference);
    if (v.paymentStatus !== "PAID") {
      throw new ApiError(402, "NOT_PAID", "Your payment hasn't been confirmed yet. If you were charged, wait a minute and try again.");
    }
    if (Number(v.amountPaid) < pay.amount) throw new ApiError(402, "UNDERPAID", "The amount paid doesn't match the plan price. Please contact support.");

    const plan = PLANS[pay.plan];
    await db.runTransaction(async (t) => {
      const p = await t.get(doc.ref);
      if (p.data().status === "PAID") return; // already granted (double tap / retry)
      const u = (await t.get(userRef(req.uid))).data() || {};
      t.set(userRef(req.uid), {
        subscriptionTier: plan.tier, premiumPlan: pay.plan,
        premiumExpiryMs: nextExpiry(u, plan.tier, plan.days), lastPaymentAt: Date.now(),
      }, { merge: true });
      t.update(doc.ref, { status: "PAID", paidAt: Date.now(), amountPaid: Number(v.amountPaid) });
    });
  }

  const s = subscriptionOf(await loadUser(req.uid));
  res.json({ success: true, tier: s.tier, plan: s.plan, premiumExpiryMs: s.expiry });
}));

// ───────────── Promo / gift codes ─────────────
app.post("/api/redeem-code", wrap(async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new ApiError(400, "BAD_CODE", "That code doesn't look right. Check it and try again.");

  const codeRef = db.collection("redeemCodes").doc(code);
  const result = await db.runTransaction(async (t) => {
    const [c, used, u] = await Promise.all([t.get(codeRef), t.get(codeRef.collection("redemptions").doc(req.uid)), t.get(userRef(req.uid))]);
    const d = c.data();
    if (!c.exists || d.active === false) throw new ApiError(404, "NO_SUCH_CODE", "That code isn't valid.");
    if (d.expiresAtMs && Date.now() > d.expiresAtMs) throw new ApiError(410, "CODE_EXPIRED", "That code has expired.");
    if (d.maxUses && (d.usedCount || 0) >= d.maxUses) throw new ApiError(410, "CODE_USED_UP", "That code has already been fully used.");
    if (used.exists) throw new ApiError(409, "ALREADY_REDEEMED", "You've already used this code.");

    const tier = d.tier === "LITE_YEARLY" ? "LITE_YEARLY" : "PREMIUM";
    const plan = d.plan || "promo";
    const expiry = nextExpiry(u.data() || {}, tier, Number(d.durationDays) || 30);
    t.set(userRef(req.uid), { subscriptionTier: tier, premiumPlan: plan, premiumExpiryMs: expiry }, { merge: true });
    t.update(codeRef, { usedCount: (d.usedCount || 0) + 1 });
    t.set(codeRef.collection("redemptions").doc(req.uid), { at: Date.now() });
    return { tier, plan, expiry };
  });

  const when = new Date(result.expiry).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  res.json({ success: true, tier: result.tier, plan: result.plan, premiumExpiryMs: result.expiry,
    message: `Code accepted! Your plan is active until ${when}.` });
}));

app.use("/api", (_q, r) => sendError(r, new ApiError(404, "NOT_FOUND", "Unknown endpoint.")));
app.use((err, _q, r, _n) => sendError(r, err));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`ReadIQ API listening on :${port}`));
