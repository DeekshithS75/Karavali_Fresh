# Karavali Fresh Farmer API

Node.js + TypeScript + Express API for Farmer authentication only. The Expo app remains under `../mobile`.

## Start locally

1. Copy `.env.example` to `.env`. Set `MONGODB_URI` to a MongoDB Atlas replica-set URI.
2. Generate independent random secrets for `TOKEN_HMAC_SECRET`, `PHONE_HASH_SECRET`, and `AADHAAR_HASH_SECRET`. Generate a random 32-byte key and base64 encode it for `AADHAAR_ENCRYPTION_KEY_BASE64`.
3. Configure `NACALLER_KEY` from your NaCaller account. The key stays on the backend and is never sent to the mobile app.
4. Run `npm install` and `npm run dev`.

`backend/.gitignore` excludes `.env` and `.env.*`, except `.env.example`. Never commit a real environment file or API key.

OCR uses local Tesseract.js with installed English and Kannada trained data. Images are processed in memory. A MongoDB Atlas replica set is required because registration completion uses a transaction.

## Farmer API contracts

All routes are under `/api/farmer`.

| Method and path | Purpose |
| --- | --- |
| `GET /auth/capabilities` | Reports OCR, missed-call verification, encryption and registration readiness plus localized privacy notice text. |
| `POST /auth/lookup` | Body `{ "phone": "+91XXXXXXXXXX" }`; returns `registered`, `pending` (with `verificationId`) or `new`. Server account state is authoritative. |
| `POST /registrations` | Multipart farmer fields, `consent=true`, `phoneVerificationConsent=true`, privacy notice version and one document image. OCR comparison must pass before a pending registration is created. |
| `GET /registrations/:id/verification` | Returns document comparison state and whether new missed-call consent is required for older pending registrations. |
| `POST /registrations/:id/phone-verification-consent` | Body `{ "phoneVerificationConsent": "true" }`; records explicit consent for older pending registrations. |
| `POST /registrations/:id/phone-verification` | Starts or resumes NaCaller verification only after OCR passes and consent is recorded. Returns `202 { challengeId, callNumber, instruction, expiresAt, status }`. |
| `POST /auth/phone-verification` | Body `{ "phone": "+91XXXXXXXXXX", "phoneVerificationConsent": "true" }`; starts verification for an existing eligible Farmer account only. A login cannot create an account. |
| `GET /auth/phone-verification/:challengeId/status` | Polls NaCaller server-to-server and returns local challenge state `pending`, `verified`, `expired` or `cancelled`. |
| `POST /auth/phone-verification/:challengeId/cancel` | Cancels the local challenge. NaCaller does not publish a remote cancellation API. |
| `POST /auth/phone-verification/:challengeId/complete` | Rechecks provider state and only then completes registration or creates a session for an existing account. No client-supplied verified flag is accepted. |
| `GET /auth/session` | Requires `Authorization: Bearer <accessToken>` and validates the stored session. |
| `POST /auth/logout` | Revokes the server session. |

The server starts verification with `POST https://api.nacaller.com/api/verify/start`, using Bearer authorization and `{ phone, reference }`. It polls `GET https://api.nacaller.com/api/verify/status/:requestId`. Provider request IDs are linked to server challenge IDs, phone hashes, purpose and the corresponding Farmer or pending registration. Provider status, challenge ownership, expiry and local throttling are checked on the backend. No SMS or OTP code is sent or entered.

The app displays NaCaller's call number and instructions. The farmer taps the dialer action; the app never places the call automatically. A busy tone or quick hang-up may be expected. The app polls Karavali Fresh every 2.5 seconds while the verification page is focused and active, and stops on completion, expiry, cancellation or leaving the screen.

Missed-call verification establishes control of the submitted phone number for that attempt only. It does not establish that the number is Aadhaar-linked or prove identity. OCR comparisons also do not prove that a document is authentic or belongs to the applicant. The backend keeps OCR comparison and phone verification separate.

## Provider and deployment status

Without `NACALLER_KEY`, verification routes return `503 { "error": "phone_verification_provider_not_configured" }`. NaCaller errors, credits exhaustion, invalid phone numbers, provider rate limits and unavailable verification lines map to safe API errors. No local demo verification or session fallback exists. A real missed-call test still requires a configured NaCaller account with credits and a configured verification line.

Do not send API keys, Aadhaar numbers, raw OCR text, or uploaded documents to logs. Raw Aadhaar data is held in request memory for comparison; only a keyed fingerprint is retained for duplicate prevention. Pending registration fields are encrypted until account creation. Uploaded documents are not persisted.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
```
