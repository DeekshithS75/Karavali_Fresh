# Produce image storage

The current adapter writes validated produce photos to `.local-produce-images` in the backend directory (or `PRODUCE_IMAGE_DIR` when set). This adapter is enabled only when `NODE_ENV=development` and `PRODUCE_IMAGE_STORAGE=local` (the default in development).

This local filesystem storage is for development only. It is not suitable for ephemeral production hosts, horizontally scaled deployments, or durable backups. Production uploads return `produce_image_storage_not_configured` until a durable adapter (for example, an object-storage implementation) is configured. Image files are not stored in MongoDB or embedded in Farmer records.

The API validates image bytes with Sharp, accepts JPEG, PNG, and WebP only, and stores generated file keys and metadata in the FarmerProduce collection. Authenticated image reads are scoped to the owning Farmer session.
