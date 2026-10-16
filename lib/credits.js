const { db } = require("./firebase");
const { ApiError } = require("./errors");

// Daily base credits by plan. Premium is unmetered. Everyone else can earn more by watching rewarded ads.
const FREE_DAILY = Number(process.env.FREE_DAILY_CREDITS || 5);
const LITE_DAILY = Number(process.env.LITE_DAILY_CREDITS || 10);
const AD_BONUS = Number(process.env.AD_REWARD_CREDITS || 2);
const MAX_ADS = Number(process.env.MAX_REWARDED_ADS_PER_DAY || 5);

// 1-hour passes: a free/Lite user who watches a rewarded ad can use the AI Tutor for an hour.
const PASS_MS = 60 * 60 * 1000;
const MAX_PASSES = Number(process.env.MAX_PASSES_PER_DAY || 6);
const TUTOR_PASS_MAX = Number(process.env.TUTOR_PASS_MAX_MESSAGES || 40);

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

// The live tutor pass, if the person has one with messages left.
const tutorPass = (d) => {
  const p = d.passes && d.passes.tutor;
  return p && p.until > Date.now() && (p.used || 0) < TUTOR_PASS_MAX ? p : null;
};

async function getBalance(uid, ctx) {
  return view(load(await ref(uid).get()), ctx);
}

/** Takes credits for one action. Returns an async refund() to call if the AI call fails. */
async function spend(uid, feature, ctx) {
  const cost = COST[feature] ?? 1;
  let viaPass = false;

  await db.runTransaction(async (t) => {
    const d = load(await t.get(ref(uid)));
    viaPass = false;

    // AI Tutor: Premium is unlimited. Everyone else needs a live 1-hour pass (earned with a rewarded ad).
    if (feature === "tutor" && !ctx.unmetered) {
      const p = tutorPass(d);
      if (!p) {
        throw new ApiError(429, "AI_TUTOR_NEEDS_AD",
          "AI Tutor needs a 1-hour pass. Watch one short ad to unlock it, or upgrade to Premium.");
      }
      viaPass = true;
      d.passes.tutor.used = (p.used || 0) + 1;
      d.usage = { ...d.usage, tutor: (d.usage?.tutor || 0) + 1 };
      t.set(ref(uid), d);
      return;
    }

    const v = view(d, ctx);
    if (!ctx.unmetered && v.balance < cost) {
      throw new ApiError(429, "AI_LIMIT_REACHED",
        "You've used all your credits for today. Watch an ad for more, or upgrade to Premium for unlimited use.");
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
        if (viaPass) {
          if (d.passes?.tutor) d.passes.tutor.used = Math.max((d.passes.tutor.used || 0) - 1, 0);
        } else if (!ctx.unmetered) {
          d.used = Math.max((d.used || 0) - cost, 0);
        }
        d.usage = { ...d.usage, [feature]: Math.max((d.usage?.[feature] || 0) - 1, 0) };
        t.set(ref(uid), d);
      });
    } catch (e) { console.error("refund failed", e.message); }
  };
}

/** Starts a fresh 1-hour tutor pass (after the app shows a rewarded ad). Capped per day. */
async function grantTutorPass(uid) {
  return db.runTransaction(async (t) => {
    const d = load(await t.get(ref(uid)));
    if ((d.passCount || 0) >= MAX_PASSES) {
      throw new ApiError(429, "PASS_LIMIT_REACHED", "You've reached today's limit for 1-hour passes. Try again tomorrow or upgrade.");
    }
    d.passCount = (d.passCount || 0) + 1;
    d.passes = { ...(d.passes || {}), tutor: { until: Date.now() + PASS_MS, used: 0 } };
    t.set(ref(uid), d);
    return d.passes.tutor.until;
  });
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
    if (f === "tutor") { const p = tutorPass(d); remaining = p ? TUTOR_PASS_MAX - (p.used || 0) : 0; }
    features[f] = ctx.unmetered
      ? { used, limit: -1, remaining: -1, unlimited: true }
      : { used, limit: used + remaining, remaining, unlimited: false };
  }
  return features;
}

module.exports = { COST, ctxFor, getBalance, spend, claimAdReward, grantTutorPass, usageReport };
