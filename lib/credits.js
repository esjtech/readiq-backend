const { db } = require("./firebase");
const { ApiError } = require("./errors");

// Daily base credits by plan. Premium is unmetered. Everyone else can earn more by watching rewarded ads.
const FREE_DAILY = Number(process.env.FREE_DAILY_CREDITS || 5);
const LITE_DAILY = Number(process.env.LITE_DAILY_CREDITS || 10);
const AD_BONUS = Number(process.env.AD_REWARD_CREDITS || 2);
const MAX_ADS = Number(process.env.MAX_REWARDED_ADS_PER_DAY || 5);

// What each action costs. Doc->PDF is not metered.
const COST = { summary: 1, quiz: 2, tutor: 1, voice: 2, transcribe: 3 };

/** What this person's plan means for credits: { unmetered, base }. */
function ctxFor(sub) {
  return { unmetered: sub.tier === "PREMIUM", base: sub.tier === "LITE_YEARLY" ? LITE_DAILY : FREE_DAILY };
}

// The day rolls over at midnight in Nigeria.
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

const ref = (uid) => db.collection("credits").doc(uid);
const fresh = () => ({ day: today(), used: 0, adsWatched: 0, usage: {} });
const load = (snap) => (snap.exists && snap.data().day === today() ? snap.data() : fresh());

function view(d, ctx) {
  const total = ctx.base + (d.adsWatched || 0) * AD_BONUS;
  return {
    balance: ctx.unmetered ? total : Math.max(total - (d.used || 0), 0),
    total,
    adsRemaining: Math.max(MAX_ADS - (d.adsWatched || 0), 0),
    unmetered: ctx.unmetered,
  };
}

// Credits earned from ads that haven't been spent on the tutor yet.
const tutorBonusLeft = (d) => (d.adsWatched || 0) * AD_BONUS - (d.usage?.tutor || 0) * COST.tutor;

async function getBalance(uid, ctx) {
  return view(load(await ref(uid).get()), ctx);
}

/** Takes credits for one action. Returns an async refund() to call if the AI call fails. */
async function spend(uid, feature, ctx) {
  const cost = COST[feature] ?? 1;
  await db.runTransaction(async (t) => {
    const d = load(await t.get(ref(uid)));
    const v = view(d, ctx);
    if (!ctx.unmetered && v.balance < cost) {
      throw new ApiError(429, "AI_LIMIT_REACHED",
        "You've used all your credits for today. Watch an ad for more, or upgrade to Premium for unlimited use.");
    }
    // Lite/Free reach the Premium-only tutor through rewarded ads, not through their daily base credits.
    if (feature === "tutor" && !ctx.unmetered && tutorBonusLeft(d) < cost) {
      throw new ApiError(429, "AI_TUTOR_NEEDS_AD",
        "AI Tutor messages are unlocked by watching a short ad. Watch one to continue.");
    }
    d.usage = { ...d.usage, [feature]: (d.usage?.[feature] || 0) + 1 };
    if (!ctx.unmetered) d.used = (d.used || 0) + cost;
    t.set(ref(uid), d);
  });

  return async () => {
    try {
      await db.runTransaction(async (t) => {
        const snap = await t.get(ref(uid));
        if (!snap.exists || snap.data().day !== today()) return;
        const d = snap.data();
        if (!ctx.unmetered) d.used = Math.max((d.used || 0) - cost, 0);
        d.usage = { ...d.usage, [feature]: Math.max((d.usage?.[feature] || 0) - 1, 0) };
        t.set(ref(uid), d);
      });
    } catch (e) { console.error("refund failed", e.message); }
  };
}

async function claimAdReward(uid, ctx) {
  return db.runTransaction(async (t) => {
    const d = load(await t.get(ref(uid)));
    if ((d.adsWatched || 0) >= MAX_ADS) {
      throw new ApiError(429, "AD_LIMIT_REACHED", "You've reached today's limit for rewarded ads.");
    }
    d.adsWatched = (d.adsWatched || 0) + 1;
    t.set(ref(uid), d);
    return view(d, ctx);
  });
}

async function usageReport(uid, ctx) {
  const d = load(await ref(uid).get());
  const v = view(d, ctx);
  const features = {};
  for (const f of ["summary", "quiz", "voice", "tutor"]) {
    const used = d.usage?.[f] || 0;
    let remaining = Math.floor(v.balance / COST[f]);
    if (f === "tutor") remaining = Math.min(remaining, Math.floor(Math.max(tutorBonusLeft(d), 0) / COST.tutor));
    features[f] = ctx.unmetered
      ? { used, limit: -1, remaining: -1, unlimited: true }
      : { used, limit: used + remaining, remaining, unlimited: false };
  }
  return features;
}

module.exports = { COST, ctxFor, getBalance, spend, claimAdReward, usageReport };
