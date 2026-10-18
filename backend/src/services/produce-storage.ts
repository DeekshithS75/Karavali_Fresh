import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export type ProducePhotoUpload = { buffer: Buffer; mimetype: string; size: number };
export type StoredProducePhoto = { storageKey: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; size: number };

const defaultDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../.local-produce-images');
const storageDirectory = resolve(process.env.PRODUCE_IMAGE_DIR || defaultDirectory);
const allowedFormats = new Map<string, StoredProducePhoto['mimeType']>([
  ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'],
]);

export class ProduceStorageError extends Error {
  constructor(readonly code: 'not_configured' | 'invalid_image' | 'write_failed' | 'not_found') { super(code); }
}

function isLocalStorageAvailable() {
  // Filesystem storage is for local development only; production must configure a durable adapter.
  return process.env.NODE_ENV === 'development' && (process.env.PRODUCE_IMAGE_STORAGE ?? 'local') === 'local';
}

export async function storeProducePhotos(uploads: ProducePhotoUpload[]): Promise<StoredProducePhoto[]> {
  if (!isLocalStorageAvailable()) throw new ProduceStorageError('not_configured');
  const prepared: Array<{ buffer: Buffer; photo: StoredProducePhoto }> = [];
  for (const upload of uploads) {
    try {
      const metadata = await sharp(upload.buffer, { limitInputPixels: 25_000_000 }).metadata();
      const mimeType = metadata.format ? allowedFormats.get(metadata.format) : undefined;
      if (!mimeType || upload.mimetype !== mimeType || !metadata.width || !metadata.height) throw new Error('invalid_image');
      prepared.push({ buffer: upload.buffer, photo: { storageKey: `${randomUUID()}.${metadata.format}`, mimeType, size: upload.buffer.length } });
    } catch { throw new ProduceStorageError('invalid_image'); }
  }
  const written: StoredProducePhoto[] = [];
  try {
    await mkdir(storageDirectory, { recursive: true });
    for (const item of prepared) {
      await writeFile(resolve(storageDirectory, item.photo.storageKey), item.buffer, { flag: 'wx', mode: 0o600 });
      written.push(item.photo);
    }
    return written;
  } catch {
    await deleteProducePhotos(written);
    throw new ProduceStorageError('write_failed');
  }
}

export async function deleteProducePhotos(photos: Pick<StoredProducePhoto, 'storageKey'>[]) {
  await Promise.all(photos.map(async ({ storageKey }) => {
    // Only generated leaf keys are accepted; never allow path traversal from database or request data.
    if (!/^[\da-f-]+\.(?:jpeg|png|webp)$/i.test(storageKey)) return;
    try { await unlink(resolve(storageDirectory, storageKey)); } catch { /* best-effort cleanup */ }
  }));
}

export async function readProducePhoto(storageKey: string) {
  if (!isLocalStorageAvailable()) throw new ProduceStorageError('not_configured');
  if (!/^[\da-f-]+\.(?:jpeg|png|webp)$/i.test(storageKey)) throw new ProduceStorageError('not_found');
  try { return await readFile(resolve(storageDirectory, storageKey)); }
  catch { throw new ProduceStorageError('not_found'); }
}

