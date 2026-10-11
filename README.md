# ReadIQ backend

Node/Express API for the ReadIQ Android app (`com.esjtech.readiq`). Deployed on Render.
Firebase Auth verifies every request; Firestore stores user + subscription data; API keys exist only in Render env vars.

| Endpoint | What it does |
|---|---|
| POST /api/summarize, /api/generate-quiz | Claude: summaries and quizzes (costs credits) |
| POST /api/tutor/chat | Claude tutor, Premium only |
| POST /api/tts, /api/transcribe-audio | OpenAI voice / speech-to-text (optional) |
| GET /api/credits, POST /api/credits/reward, GET /api/ai-usage | Daily credit balance |
| POST /api/start-trial | One-time 3-day Premium trial |
| POST /api/init-payment, /api/verify-payment | Paystack checkout + verification (+ /webhook/paystack) |
| POST /api/redeem-code | Promo/gift codes |
| POST /api/convert-doc-to-pdf | Not built yet (returns 501) |

Create a code: `FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/create-code.js READIQ2026 PREMIUM monthly 30 100`
