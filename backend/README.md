# Karavali Fresh Farmer API

Node.js + TypeScript + Express API for Farmer authentication only. The mobile app remains under `../mobile`.

## Start locally

1. Copy `.env.example` to `.env` and set a MongoDB Atlas connection URI. Generate independent random secrets for `TOKEN_HMAC_SECRET`, `OTP_HMAC_SECRET`, and `AADHAAR_HASH_SECRET`. Generate a random 32-byte key and base64 encode it for `AADHAAR_ENCRYPTION_KEY_BASE64`.
2. Configure `OTP_DELIVERY_URL` and `OTP_DELIVERY_API_KEY` for a real SMS/OTP delivery integration. The provider must accept `POST { phone, code, purpose }` with a bearer API key and return a 2xx only after accepting delivery.
3. Run `npm install`, `npm run dev`.

OCR is local Tesseract.js using the installed English and Kannada trained-data packages. It does not upload documents to a separate OCR service. Startup initializes a worker and its capability is disabled if initialization fails. Images are processed in memory; only the comparison status and encrypted registration/profile data are stored. PDF upload is rejected because this integration accepts image documents only.

`MONGODB_URI` must point to an Atlas replica-set deployment because farmer creation and registration completion use a transaction. The API refuses to start without MongoDB. Do not expose this backend directly to the public internet without TLS termination, deployment-level abuse controls, secrets management, monitoring, retention policy, and provider integration review.

## API contracts

All API routes are under `/api/farmer`.

| Method and path | Purpose |
| --- | --- |
| `GET /auth/capabilities` | Reports whether local OCR, OTP delivery, encryption and registration prerequisites are available. |
| `POST /auth/lookup` | Body `{ "phone": "10 digits" }`; returns `{ "accountStatus": "registered" | "pending" | "new" }`. HMAC-keyed Mongo rate limit, 5 checks/hour. The mobile marker is never used as account proof. |
| `POST /registrations` | Multipart farmer profile, explicit consent, privacy notice version, and one JPEG/PNG/WebP `document`. Runs quality checks, English/Kannada OCR, and field comparison. Returns `201 { status: "pending", documentComparison: "passed", verificationId }`. Mismatch and unreadable documents return `422` with field or quality reason codes; no document or extracted raw value is included in response. |
| `GET /registrations/:id/verification` | Returns only current document comparison state. An ObjectId is an unguessable, short-lived reference, not an authenticated session. |
| `POST /registrations/:id/otp` | Starts registration OTP only after document comparison is stored as `passed`. Returns `202 { challengeId }`. |
| `POST /auth/otp/request` | Body `{ "phone": "10 digits" }`; sends OTP only for an existing verified Farmer account. Returns `202 { challengeId }`. |
| `POST /auth/otp/verify` | Body `{ "challengeId": "...", "otp": "6 digits" }`. OTP state, purpose, expiry, and attempt count are server-side. Registration creates the account only after document match and OTP pass. Returns `{ accessToken, expiresAt }`. |
| `GET /auth/session` | Requires `Authorization: Bearer <accessToken>`; validates server-side session and expiry. |
| `POST /auth/logout` | Requires the same bearer token and revokes the server session. |

OTP values are generated with a cryptographic RNG, HMACed in MongoDB, expire after `OTP_TTL_SECONDS`, and are limited by `OTP_MAX_ATTEMPTS`. Per-phone OTP resend and lookup/registration limits are stored in MongoDB. The OCR route compares extracted name, date/year of birth, gender, Aadhaar number, and address. It never treats OCR as proof of identity and does not inspect the printed phone number. OTP separately verifies control of the submitted phone number; it does not establish Aadhaar phone linkage.

The Tesseract parser locates values using bilingual labels (Kannada/English), extracted line order, and neighboring text such as date-of-birth and Aadhaar labels. It does not assume one card template or fixed pixel regions. OCR and image-quality thresholds need real-device evaluation before deployment; OCR matches and OTP possession still do not replace authorized identity verification or legal review.

## Provider and service status

`OTP_DELIVERY_URL` and `OTP_DELIVERY_API_KEY` are intentionally unset in the example. Until a real SMS provider is configured, OTP endpoints return `503 { "error": "otp_provider_not_configured" }`; no OTP, Farmer account, or session is created. The OCR engine is local and should report ready only after both language models initialize. If OCR initialization fails, registration is disabled and the route returns `503 { "error": "ocr_engine_not_configured" }`.

Do not send OCR text, Aadhaar number, OTP, provider credentials, or submitted document to logs. The raw Aadhaar value is held in request memory only for OCR/comparison; after a successful comparison, only its HMAC fingerprint is stored for duplicate prevention. Pending farmer fields needed to finish registration are encrypted with AES-256-GCM. The profile does not retain the raw Aadhaar number. Temporary uploaded images are not persisted.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
```
