# Produce photo storage

New validated produce images are uploaded to Cloudinary as `authenticated` image assets. The folder uses server-derived Farmer and produce IDs. MongoDB stores Cloudinary public and asset IDs, resource type, format, dimensions, MIME type and byte size; it does not store base64 image data.

Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` in `backend/.env` or the backend's secret store. These are server-only values and must not be exposed through Expo variables, API responses or logs. Uploads fail closed when configuration is incomplete; there is no local filesystem fallback for new uploads.

Photo reads remain behind the existing authenticated Farmer endpoint and ownership lookup. After that check, the backend redirects to a five-minute Cloudinary signed download URL for the authenticated asset. The mobile app continues to request the existing app-local photo path.

Records created by the former local adapter may still reference `storageKey`. They remain readable from the original local photo directory until migrated. Use `npm run migrate:produce-photos` for a dry run and `npm run migrate:produce-photos -- --apply` to upload them and update MongoDB. The migration deletes each local file only after its Cloudinary upload and MongoDB reference update succeed. Do not remove old local files or claim they have migrated until the migration has completed and been checked.
