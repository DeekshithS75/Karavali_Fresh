import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { v2 as cloudinary } from 'cloudinary';
import sharp from 'sharp';

export type ProducePhotoUpload = { buffer: Buffer; mimetype: string; size: number };
export type StoredProducePhoto = {
  publicId?: string;
  assetId?: string;
  resourceType?: 'image';
  format?: string;
  width?: number;
  height?: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  size: number;
  // Retained only for listings created by the former local-filesystem adapter.
  storageKey?: string;
};

type CloudinaryUploadResult = {
  public_id: string;
  asset_id?: string;
  resource_type: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
};

type CloudinaryClient = {
  config: (options: Record<string, unknown>) => unknown;
  uploader: {
    upload_stream: (options: Record<string, unknown>, callback: (error: Error | null, result?: CloudinaryUploadResult) => void) => NodeJS.WritableStream;
    destroy: (publicId: string, options: Record<string, unknown>) => Promise<{ result?: string }>;
  };
  utils: {
    private_download_url: (publicId: string, format: string, options: Record<string, unknown>) => string;
  };
};

const allowedFormats = new Map<string, StoredProducePhoto['mimeType']>([
  ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'],
]);
const legacyDirectory = resolve(process.env.PRODUCE_IMAGE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../.local-produce-images'));
const signedUrlTtlSeconds = 5 * 60;
let cloudinaryClient = cloudinary as unknown as CloudinaryClient;

export class ProduceStorageError extends Error {
  constructor(readonly code: 'not_configured' | 'invalid_image' | 'upload_failed' | 'not_found') { super(code); }
}

// Injection seam for deterministic SDK tests; application code uses the official SDK instance.
export function setProduceCloudinaryClientForTests(client: CloudinaryClient) {
  cloudinaryClient = client;
}

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) throw new ProduceStorageError('not_configured');
  cloudinaryClient.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

function uploadToCloudinary(buffer: Buffer, options: Record<string, unknown>): Promise<CloudinaryUploadResult> {
  return new Promise((resolveUpload, rejectUpload) => {
    const uploadStream = cloudinaryClient.uploader.upload_stream(options, (error, result) => {
      if (error || !result) rejectUpload(error ?? new Error('Cloudinary returned no asset metadata'));
      else resolveUpload(result);
    });
    Readable.from([buffer]).pipe(uploadStream);
  });
}

async function validateImage(upload: ProducePhotoUpload) {
  try {
    const metadata = await sharp(upload.buffer, { limitInputPixels: 25_000_000 }).metadata();
    const mimeType = metadata.format ? allowedFormats.get(metadata.format) : undefined;
    if (!mimeType || upload.mimetype !== mimeType || !metadata.width || !metadata.height) throw new Error('invalid_image');
    return { format: metadata.format!, width: metadata.width, height: metadata.height, mimeType };
  } catch {
    throw new ProduceStorageError('invalid_image');
  }
}

export async function storeProducePhotos(uploads: ProducePhotoUpload[], farmerId: string, produceId: string): Promise<StoredProducePhoto[]> {
  const prepared = await Promise.all(uploads.map(async (upload) => ({ upload, metadata: await validateImage(upload) })));
  configureCloudinary();
  const stored: StoredProducePhoto[] = [];
  const folder = `karavali-fresh/farmers/${farmerId}/produce/${produceId}`;
  try {
    for (const { upload, metadata } of prepared) {
      const asset = await uploadToCloudinary(upload.buffer, {
        resource_type: 'image',
        type: 'authenticated',
        folder,
        public_id: randomUUID(),
        overwrite: false,
        format: metadata.format,
      });
      if (asset.public_id) stored.push({
        publicId: asset.public_id,
        ...(asset.asset_id ? { assetId: asset.asset_id } : {}),
        resourceType: asset.resource_type === 'image' ? 'image' : undefined,
        format: asset.format,
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
        mimeType: metadata.mimeType,
        size: asset.bytes ?? upload.size,
      });
      if (asset.resource_type !== 'image' || !asset.public_id || asset.format !== metadata.format) throw new Error('Cloudinary returned unexpected asset metadata');
    }
    return stored;
  } catch {
    await deleteProducePhotos(stored);
    throw new ProduceStorageError('upload_failed');
  }
}

export async function deleteProducePhotos(photos: Pick<StoredProducePhoto, 'publicId' | 'resourceType'>[]) {
  const cloudPhotos = photos.filter((photo): photo is { publicId: string; resourceType?: 'image' } => Boolean(photo.publicId));
  if (!cloudPhotos.length) return;
  try { configureCloudinary(); } catch { return; }
  await Promise.all(cloudPhotos.map(async ({ publicId, resourceType }) => {
    try {
      await cloudinaryClient.uploader.destroy(publicId, { resource_type: resourceType ?? 'image', type: 'authenticated', invalidate: true });
    } catch { /* best-effort cleanup; do not expose provider errors or credentials */ }
  }));
}

export function createProducePhotoDeliveryUrl(photo: Pick<StoredProducePhoto, 'publicId' | 'resourceType' | 'format'>) {
  if (!photo.publicId || !photo.format) throw new ProduceStorageError('not_found');
  try {
    configureCloudinary();
    return cloudinaryClient.utils.private_download_url(photo.publicId, photo.format, {
      resource_type: photo.resourceType ?? 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + signedUrlTtlSeconds,
    });
  } catch (error) {
    if (error instanceof ProduceStorageError) throw error;
    throw new ProduceStorageError('upload_failed');
  }
}

export async function readLegacyProducePhoto(storageKey: string) {
  if (!/^[\da-f-]+\.(?:jpeg|png|webp)$/i.test(storageKey)) throw new ProduceStorageError('not_found');
  try { return await readFile(resolve(legacyDirectory, storageKey)); }
  catch { throw new ProduceStorageError('not_found'); }
}

export async function deleteLegacyProducePhoto(storageKey: string) {
  if (!/^[\da-f-]+\.(?:jpeg|png|webp)$/i.test(storageKey)) return false;
  try { await unlink(resolve(legacyDirectory, storageKey)); return true; }
  catch { return false; /* local cleanup is best-effort after DB migration */ }
}

