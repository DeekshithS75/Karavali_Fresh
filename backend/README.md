# Karavali Fresh Farmer API

Node.js + TypeScript + Express API for Farmer authentication and farmer-owned market-price comparison. The Expo app remains under `../mobile`.

## Start locally

1. Copy `.env.example` to `.env`. Set `MONGODB_URI` to a MongoDB Atlas replica-set URI.
2. Generate independent random secrets for `TOKEN_HMAC_SECRET`, `PHONE_HASH_SECRET`, and `AADHAAR_HASH_SECRET`. Generate a random 32-byte key and base64 encode it for `AADHAAR_ENCRYPTION_KEY_BASE64`.
3. Configure `NACALLER_KEY` from your NaCaller account. The key stays on the backend and is never sent to the mobile app.
4. Configure `DATA_GOV_IN_API_KEY` for the data.gov.in Mandi resource. The key stays on the backend and is never sent to the mobile app.
5. Run `npm install` and `npm run dev`.

For browser development, the Expo preview at `http://localhost:8081` must call the backend at `http://localhost:4000` (set `EXPO_PUBLIC_API_URL` in `mobile/.env`). `MOBILE_ORIGIN` is a comma-separated allowlist; use `http://localhost:8081,http://127.0.0.1:8081` for local browser previews. The frontend and API use different ports. If the mobile app runs on a physical phone, use the development computer's reachable LAN IP for `EXPO_PUBLIC_API_URL` instead of `localhost`.

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
| `GET /produce/:produceId/market-comparison` | Requires a valid Farmer session; compares a Farmer-owned listing against coastal Karnataka data.gov.in/AGMARKNET observations. |

The server starts verification with `POST https://api.nacaller.com/api/verify/start`, using Bearer authorization and `{ phone, reference }`. It polls `GET https://api.nacaller.com/api/verify/status/:requestId`. Provider request IDs are linked to server challenge IDs, phone hashes, purpose and the corresponding Farmer or pending registration. Provider status, challenge ownership, expiry and local throttling are checked on the backend. No SMS or OTP code is sent or entered.

The app displays NaCaller's call number and instructions. The farmer taps the dialer action; the app never places the call automatically. A busy tone or quick hang-up may be expected. The app polls Karavali Fresh every 2.5 seconds while the verification page is focused and active, and stops on completion, expiry, cancellation or leaving the screen.

Missed-call verification establishes control of the submitted phone number for that attempt only. It does not establish that the number is Aadhaar-linked or prove identity. OCR comparisons also do not prove that a document is authentic or belongs to the applicant. The backend keeps OCR comparison and phone verification separate.

## AGMARKNET market-price comparison

The backend reads `DATA_GOV_IN_API_KEY` from `backend/.env`; the key is never included in the mobile bundle or logged. The official resource is `9ef84268-d588-465a-a308-a864a43d0070` ([official dataset](https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi)). A live request was verified with `limit=1`; its `records` object contains `state`, `district`, `market`, `commodity`, `variety`, `grade`, `arrival_date`, `min_price`, `max_price`, and `modal_price`. Response metadata includes `total`, `count`, `limit`, and `offset`. A live `limit=20` Karnataka query returned `total=32`, `count=20`, and `offset=0`; offset 20 returned the remaining 12 records. Filters were verified as `filters[state]`, `filters[district]`, and `filters[commodity]`.

`GET /api/farmer/produce/:produceId/market-comparison` requires the Farmer's server-issued session and loads the listing only with both its ID and the authenticated session's Farmer ID. The backend sends only exact English commodity candidates from that listing, with `filters[state]=Karnataka`, `filters[district]=Dakshina Kannada` or `Udupi`, and `filters[commodity]=<listing commodity>`. It requests 20 rows at a time and paginates only when the filtered response `total` exceeds returned records (maximum five pages per district/commodity query). Non-Latin names are not sent as data.gov.in commodity filters. Returned rows are rechecked against all requested filters, and comparison exact-matches normalized listing names and saved translations; no fuzzy substring matching is used. Market names are read only from returned source records.

AGMARKNET reports prices in rupees per quintal (100 kg). ₹/quintal is converted to ₹/kg by dividing by 100; bunch/piece listings are unit-incompatible. The response keeps source `arrival_date` separate from `fetchedAt`, marks observations older than seven days as stale, includes the min–max range and modal price, and attributes the source. Successful responses, including empty results, are cached in-process for 30 minutes by state/district/commodity/page size and format; concurrent requests for the same query are coalesced. HTTP 401/403, 429, other provider errors, malformed responses, and empty records are handled distinctly; no price is synthesized. Matching observations are also upserted into `MarketPriceObservation` by market/commodity/variety/grade/date. “Unchanged” is shown only when the previous calendar day's report exists and all three prices are identical; a missing previous report is reported as insufficient history.

The live key check succeeded. At verification on 2026-10-18, the exact district-filtered queries returned no records for either Dakshina Kannada or Udupi, including Karnataka/Tomato. In the bounded Karnataka/Tomato query, the API returned one current record for Ramanagara APMC, Bengaluru South (not a coastal market). A state-only sample (20 rows plus the remaining 12 via offset) showed commodities including Ladies Finger, Cauliflower, Brinjal, Bottle gourd, Beetroot, Tomato, Green Chilli, Capsicum, Drumstick, Beans, Carrot, Raddish and Cabbage, all observed in non-coastal districts in that response. No coastal market or coastal vegetable is claimed available for this snapshot. Automated provider tests use mocked API responses; these live results are a separate API smoke check. AGMARKNET data changes over time, so query results can differ later.

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
