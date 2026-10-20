# Karavali Fresh API

Node.js + TypeScript + Express API for Farmer authentication and farmer-owned market-price comparison. The Expo app remains under `../mobile`.

## Consumer accounts and public listings

Consumers register and sign in with a NaCaller phone verification challenge. A Consumer account and session are created only after the matching challenge is confirmed verified. The app stores the opaque session token in SecureStore on native devices and validates it with the API on restart. Consumer phone numbers are retained as a keyed hash for lookup and encrypted ciphertext for server-side call bridging; neither value is returned by Consumer APIs.

Consumers browse only produce with `status: published`, positive available quantity, and a positive Farmer asking price and price unit. A complete Farmer create request that includes a valid asking price is published by the backend during that save. A missing price leaves the record in `awaiting_price`; setting the asking price on an older unpriced draft publishes it. Existing priced drafts are not bulk-published. Unpublishing returns a record to `priced_unpublished`.

`GET /api/consumer/produce` requires a Consumer session and accepts bounded `search`, `page`, `limit` (maximum 30), `sort=newest|nearby`, and `distanceKm` (1–100) parameters. Nearby sorting requires a Consumer location accurate to 1 km or better and applies the radius in MongoDB's geospatial query; it returns only coarse distance bands. Results include the Farmer's asking price and a fresh compatible AGMARKNET comparison when available, otherwise a null comparison. `GET /api/consumer/produce/:produceId` returns the same safe price/location summary, account display name, and authenticated photo paths. Farmer coordinates, account/contact details, and Cloudinary asset identifiers are never included in browse or detail responses. Consumer photo paths require a Consumer session; the API reads Cloudinary `authenticated` images and streams the bytes without returning a Cloudinary URL or asset identifier.

## Start locally

After a Farmer accepts a Consumer request, the Farmer explicitly taps **Call buyer privately** to start an Exotel bridged call. Exotel calls the Farmer first, then calls the Consumer after the Farmer answers. The API never returns either phone number in request, notification, or push payloads. Sending a request requires explicit call-bridging consent. Configure `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_CALLER_ID`, `EXOTEL_REGION`, and a public HTTPS `EXOTEL_STATUS_CALLBACK_URL`. Complete Exotel account onboarding and India KYC where required, enable outbound calls, and provision an approved ExoPhone. Definite failed attempts can be retried explicitly by the Farmer; uncertain provider timeouts stay pending and cannot be retried automatically to avoid duplicate calls.

To reset development Consumer accounts, first run `npx tsx scripts/reset-consumer-accounts.ts` for a read-only dry run. Execution requires `--confirm`, `--expected-database=<name>`, and `--expected-consumers=<count>`. The script writes a mode-600 backup outside the repository, cancels pending requests, retains request history, and verifies Farmer and listing counts are unchanged.

Buyer requests are stored in `ProduceRequest` and create persistent role-scoped `Notification` records. A Farmer decision runs in a MongoDB transaction with the conditional stock decrement; requests never reserve quantity while pending. If an acceptance consumes the final stock, the listing becomes `priced_unpublished` and other pending requests are cancelled. Deleting or unpublishing a listing also cancels pending requests and notifies their buyers. MongoDB transactions require a replica set (Atlas is supported); standalone MongoDB deployments cannot use this workflow.

`POST /api/consumer/produce/:produceId/requests`, `GET /api/consumer/requests`, and `GET /api/consumer/notifications` require Consumer sessions. The request body can include a UUID `requestKey`; the server enforces uniqueness per buyer so a retry returns the existing request and does not create a duplicate notification. Farmer request listing and decisions use `/api/farmer/requests`; role-specific notification history is paginated at `/api/consumer/notifications` and `/api/farmer/notifications`. Accepted buyer requests may include only the Farmer display name and phone number; these remain hidden for pending, rejected, and cancelled requests. Buyers and Farmers can mark only their own notifications read.

`POST` and `DELETE /api/{consumer|farmer}/push-tokens` register or remove an Expo push token for the authenticated role and account. Request/decision notifications are committed to MongoDB first; the backend then sends privacy-safe summaries through Expo Push Service. Expo transport failures do not roll back in-app notifications, and tokens reported as `DeviceNotRegistered` are disabled. The mobile app still needs an EAS project ID, a native development/release build, and platform push credentials before remote pushes can be registered or physically verified.

1. Copy `.env.example` to `.env`. Set `MONGODB_URI` to a MongoDB Atlas replica-set URI.
2. Generate independent random secrets for `TOKEN_HMAC_SECRET`, `PHONE_HASH_SECRET`, and `AADHAAR_HASH_SECRET`. Generate a random 32-byte key and base64 encode it for `AADHAAR_ENCRYPTION_KEY_BASE64`.
3. Configure `NACALLER_KEY` from your NaCaller account. The key stays on the backend and is never sent to the mobile app.
4. Configure `DATA_GOV_IN_API_KEY` for the data.gov.in Mandi resource. The key stays on the backend and is never sent to the mobile app.
5. Set up Cloudinary as described below and add its credentials to `backend/.env`.
6. Run `npm install` and `npm run dev`.

## Deploy the backend to Render

Create a Render **Web Service** from this repository with these settings:

| Setting | Value |
| --- | --- |
| Root Directory | `backend` |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

`npm run build` compiles `src/index.ts` to `dist/index.js`, which is the target of the existing `start` script. The server uses Render's `PORT` environment variable (with `4000` as the local fallback) and binds to `0.0.0.0`. Startup validates production secrets, connects to MongoDB, and creates indexes before listening. `/health` returns `200` only while Mongoose is connected and `503` otherwise. Render should set `NODE_ENV=production`; do not set `PORT` manually.

Set these Render environment variables for the core production service:

| Variable | Requirement |
| --- | --- |
| `NODE_ENV` | Required; set to `production`. |
| `MONGODB_URI` | Required; use a MongoDB Atlas replica-set URI and allow Render's outbound network access in Atlas. Transactions require a replica set. |
| `MOBILE_ORIGIN` | Required; comma-separated exact HTTPS origins for the hosted browser app. Production rejects `*`. Native mobile requests do not normally send a browser Origin. |
| `TOKEN_HMAC_SECRET` | Required; independent random secret, at least 32 characters. |
| `PHONE_HASH_SECRET` | Required; independent random secret, at least 32 characters. |
| `AADHAAR_HASH_SECRET` | Required; independent random secret, at least 32 characters. |
| `AADHAAR_ENCRYPTION_KEY_BASE64` | Required; base64 encoding of exactly 32 random bytes. |

Add service credentials according to the features enabled in production:

| Feature | Environment variables |
| --- | --- |
| Farmer and Consumer missed-call verification | `NACALLER_KEY` |
| Farmer-to-buyer calls | `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_CALLER_ID`, `EXOTEL_REGION`, `EXOTEL_STATUS_CALLBACK_URL` |
| Produce photo uploads | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| Mandi market-price quotes | `DATA_GOV_IN_API_KEY` |

The variables in these feature groups are optional for process startup, but their feature will be unavailable or fail closed when its credentials are absent. Set all six Exotel variables together; the callback base must be the Render HTTPS origin (for example `https://<service>.onrender.com`), without a path or trailing callback token. The backend registers the callback as `https://<service>.onrender.com/api/provider/exotel/calls/<opaque-token>` for each call attempt. Configure that public HTTPS base in `EXOTEL_STATUS_CALLBACK_URL`; do not use localhost or a Cloudflare tunnel in production. Exotel must be configured with an approved caller ID and outbound calling enabled.

The following settings are optional and default in `src/config.ts`: `MARKET_PRICE_FRESHNESS_DAYS`, `PRIVACY_NOTICE_VERSION`, `PRIVACY_NOTICE_EN`, `PRIVACY_NOTICE_KN`, `PRIVACY_NOTICE_TCY`, `PHONE_VERIFICATION_TTL_SECONDS`, `PHONE_VERIFICATION_RESEND_SECONDS`, `SESSION_TTL_SECONDS`, and `REGISTRATION_TTL_HOURS`. Render supplies `PORT`; locally it defaults to `4000`.

OCR language data and the Tesseract core are installed from npm dependencies, so startup does not need a checked-in local model file. The service creates its temporary OCR cache at runtime. Legacy produce photos referenced from a local `.local-produce-images` directory will not be durable on Render's ephemeral filesystem; migrate any such assets to Cloudinary before relying on them in production. The `cloudflared` package is not used by the production startup path.

## Produce photo storage (Cloudinary)

Create or select a Cloudinary product environment, then copy its cloud name, API key and API secret into the backend environment:

```dotenv
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

Keep all three values in `backend/.env` or the deployment platform's server-side secret store. Do not prefix them with `EXPO_PUBLIC_`, add them to `mobile/.env`, commit them, or print them in logs. If any value is missing, produce-photo uploads fail closed with a storage-configuration error.

New photos are validated on the backend and uploaded over HTTPS as Cloudinary `authenticated` assets in `karavali-fresh/farmers/<farmerId>/produce/<produceId>`. MongoDB stores Cloudinary asset references and image metadata, never the file bytes. The existing authenticated photo API checks listing ownership before issuing a five-minute signed download URL; listing responses keep their app-local photo paths and do not include Cloudinary identifiers or credentials. Authenticated delivery keeps unpublished drafts private.

Old listings that still reference local files continue to use their existing references and can be read while the source files remain in the configured local directory. Inspect and migrate them before removing that directory:

```sh
npm run migrate:produce-photos       # read-only dry run
npm run migrate:produce-photos -- --apply
```

The migration uploads the legacy files and updates each MongoDB record before deleting those local files. On upload or database-update failure it removes newly uploaded Cloudinary assets where possible and leaves the existing MongoDB references and local files untouched. Keep a database backup and the local directory until the migration summary confirms completion. The current project image directory contains no local files; this does not establish whether MongoDB has legacy references, so run the dry run before cleanup.

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
| `GET /market-quote?commodity=...&nameEn=...&nameKn=...&nameTcy=...&unit=...` | Requires a valid Farmer session; returns recent source observations before a Farmer enters an asking price. Search origin is fixed internally to Mangaluru / Dakshina Kannada. |
| `GET /produce/:produceId/market-comparison` | Requires a valid Farmer session; compares only the authenticated Farmer's listing with data.gov.in/AGMARKNET observations. |

The server starts verification with `POST https://api.nacaller.com/api/verify/start`, using Bearer authorization and `{ phone, reference }`. It polls `GET https://api.nacaller.com/api/verify/status/:requestId`. Provider request IDs are linked to server challenge IDs, phone hashes, purpose and the corresponding Farmer or pending registration. Provider status, challenge ownership, expiry and local throttling are checked on the backend. No SMS or OTP code is sent or entered.

The app displays NaCaller's call number and instructions. The farmer taps the dialer action; the app never places the call automatically. A busy tone or quick hang-up may be expected. The app polls Karavali Fresh every 2.5 seconds while the verification page is focused and active, and stops on completion, expiry, cancellation or leaving the screen.

Missed-call verification establishes control of the submitted phone number for that attempt only. It does not establish that the number is Aadhaar-linked or prove identity. OCR comparisons also do not prove that a document is authentic or belongs to the applicant. The backend keeps OCR comparison and phone verification separate.

## AGMARKNET market-price comparison

The backend reads `DATA_GOV_IN_API_KEY` from `backend/.env`; it is never sent to mobile or logged. The official resource is `9ef84268-d588-465a-a308-a864a43d0070` ([official dataset](https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi)). Each request is bounded to 20 rows and uses exact filters for Karnataka and one normalized commodity. The provider first queries the selected district, then other coastal Karnataka districts, then Karnataka-wide results. It paginates only while the upstream `total` requires it, with a maximum of five pages (100 rows) per filter. If that cap truncates a result, the response identifies the candidate list as incomplete; the app must not claim it found the definitive nearest mandi.

Search origin is fixed to Mangaluru, Dakshina Kannada; the Farmer is not asked to select a district. The provider searches Dakshina Kannada first, then other coastal Karnataka districts, then Karnataka-wide records for the same exact commodity. Karnataka-wide results are ranked by straight-line distance between district reference points when available. The UI calls non-coastal results “Regional reference price.” Query cache entries are keyed by state/district/commodity/page size/format for 30 minutes, and concurrent identical requests are coalesced.

The API returns `state`, `district`, `market`, `commodity`, `variety`, `grade`, `arrival_date`, `min_price`, `max_price`, and `modal_price`, with `total`, `count`, `limit`, and `offset` pagination metadata. Market names are discovered from returned rows. Exact official commodity names and controlled aliases are used; fuzzy substring matches are not. Matching listing observations are stored by market/commodity/variety/grade/date so “unchanged” is shown only when a consecutive prior day's actual record exists.

The source reports INR per quintal (100 kg). ₹/quintal is converted to ₹/kg by dividing by 100; bunch and piece listing units remain incomparable. Data freshness is controlled by `MARKET_PRICE_FRESHNESS_DAYS` (default 7). The actual observation date remains separate from backend fetch time. Old results are marked stale; no missing or stale price is represented as today's price. Errors distinguish missing API configuration, invalid keys, rate limits, malformed responses and upstream/network failures.

Location selection is district-level. District reference points were retrieved from OpenStreetMap Nominatim; where a district boundary reference was unavailable, a district-headquarters point is used. Distances are straight-line estimates between district reference points, not road routes or exact market-to-market distances. The app labels same-district results separately and discloses this limitation. A statewide search is distance-ranked using the returned records; if pagination truncates before all candidates are inspected, the result says nearest selection is incomplete.

The Add New Produce and Add Price screens offer a protected market quote before the asking-price field. The quote remains informational: it does not set, validate against, or overwrite the Farmer's asking price. Dashboard comparison continues to scope listing lookups by both listing ID and authenticated session Farmer ID. UI results show the modal price and observation date; full market, district, source and distance provenance remains in the backend response for audit/debugging.

Live data is time-sensitive. Bounded live requests checked on 2026-10-18 found no matching observations in Dakshina Kannada, Udupi, or Uttara Kannada for Tomato, Brinjal, Green Chilli, Ladies Finger (Okra), Beans, or Ridgeguard (Ridge Gourd). Karnataka-wide requests returned exact records for those commodities in Bengaluru South (including Ramanagara APMC); the API’s substring filters also returned unrelated neighboring commodities, which the provider discards by exact match. Tomato, Brinjal, Green Chilli, Ladies Finger, Beans, Ridgeguard(Tori), Bottle gourd, Bitter gourd, Cauliflower, Cabbage, Carrot, Beetroot, Capsicum, Drumstick, Raddish, and Cucumbar(Kheera) had at least one exact statewide row in the bounded checks. These are snapshot results, not guaranteed future availability. Automated provider tests use fictional mocked responses and are distinct from live API smoke checks.

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
