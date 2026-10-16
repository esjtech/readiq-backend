# ReadIQ backend

Node/Express API for the ReadIQ Android app (`com.esjtech.readiq`). Deployed on Render.
Firebase Auth verifies every request; Firestore stores user + subscription data; API keys exist only in Render env vars.

| Endpoint | What it does |
|---|---|
| POST /api/summarize, /api/generate-quiz | Claude: summaries and quizzes (costs credits) |
| POST /api/tutor/chat | Claude tutor, Premium only |
| POST /api/tts, /api/transcribe-audio | OpenAI voice / speech-to-text (optional) |
| GET /api/credits, POST /api/credits/reward, GET /api/ai-usage | Daily credit balance |
| POST /api/start-trial | One-time 7-day Premium trial (everything unlocked, no ads) |
| POST /api/init-payment, /api/verify-payment | Paystack checkout + verification (+ /webhook/paystack) |
| POST /api/redeem-code | Promo/gift codes |
| POST /api/convert-doc-to-pdf | Not built yet (returns 501) |

Promo codes: `promo/seven-day-premium.json` holds SHA-256 hashes of 50 single-use codes (7 days of Premium each). The codes themselves are not in the repo. Add another batch by dropping a new JSON file in `promo/`.

Create a single custom code: `FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/create-code.js READIQ2026 PREMIUM monthly 30 100`

## Plans and credits
| Plan | Price | AI use | Ads |
|---|---|---|---|
| Free | ₦0 | 5 credits/day (+2 per rewarded ad, max 5 ads/day) | yes |
| Lite | ₦2,500 / year | 10 credits/day (+2 per rewarded ad) | yes |
| Premium | ₦1,300 / month or ₦14,000 / year | unlimited | no |

Costs: summary 1, tutor message 1, quiz 2, voice 2, transcription 3.
AI Tutor: Premium is unlimited. Free and Lite watch one rewarded ad for a 1-hour pass (up to 40 messages per pass, 6 passes a day). Other premium/lite features are unlocked in the app for 1 hour per rewarded ad.
Tune with env vars: `FREE_DAILY_CREDITS`, `LITE_DAILY_CREDITS`, `AD_REWARD_CREDITS`, `MAX_REWARDED_ADS_PER_DAY`, `PRICE_*`.
Payments are one-off Paystack charges that add time to the plan (no automatic renewal).
