import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { deleteLegacyProducePhoto, deleteProducePhotos, storeProducePhotos } from '../src/services/produce-storage.js';
import { ProduceModel } from '../src/models/index.js';

type LocalPhoto = { storageKey?: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; size: number };
type ProduceRecord = { _id: mongoose.Types.ObjectId; farmerId: mongoose.Types.ObjectId; __v?: number; photos: LocalPhoto[] };
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localDirectory = resolve(process.env.PRODUCE_IMAGE_DIR || resolve(scriptDirectory, '../.local-produce-images'));

const apply = process.argv.includes('--apply');
const migrate = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  if (apply && (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)) {
    throw new Error('Cloudinary configuration is incomplete');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  await ProduceModel.init();
  const records = await ProduceModel.find({ 'photos.storageKey': { $exists: true }, 'photos.publicId': { $exists: false } }).lean().exec() as unknown as ProduceRecord[];
  const candidatePhotos = records.reduce((count, record) => count + record.photos.filter((photo) => photo.storageKey && !('publicId' in photo)).length, 0);
  if (!apply) {
    process.stdout.write(`Dry run: found ${records.length} listing(s) with ${candidatePhotos} local photo reference(s). Rerun with --apply to migrate.\n`);
    return;
  }

  let migratedListings = 0;
  let migratedPhotos = 0;
  let retainedLocalFiles = 0;
  let failures = 0;

  for (const record of records) {
    const legacyPhotos = record.photos.filter((photo) => photo.storageKey && !('publicId' in photo));
    if (!legacyPhotos.length) continue;

    let uploaded: Awaited<ReturnType<typeof storeProducePhotos>> = [];
    try {
      const uploads = await Promise.all(legacyPhotos.map(async (photo) => {
        const buffer = await readFile(resolve(localDirectory, photo.storageKey!));
        return { buffer, mimetype: photo.mimeType, size: buffer.length };
      }));
      uploaded = await storeProducePhotos(uploads, String(record.farmerId), String(record._id));

      let uploadedIndex = 0;
      const nextPhotos = record.photos.map((photo) => photo.storageKey && !('publicId' in photo)
        ? uploaded[uploadedIndex++]!
        : photo);
      const update = await ProduceModel.updateOne(
        { _id: record._id, __v: record.__v },
        { $set: { photos: nextPhotos }, $inc: { __v: 1 } },
      ).exec();
      if (update.matchedCount !== 1) {
        await deleteProducePhotos(uploaded);
        failures += 1;
        process.stderr.write(`Skipped listing ${record._id}: it changed during migration; local photos were retained.\n`);
        continue;
      }

      migratedListings += 1;
      migratedPhotos += uploaded.length;
      for (const photo of legacyPhotos) {
        if (!await deleteLegacyProducePhoto(photo.storageKey!)) retainedLocalFiles += 1;
      }
    } catch {
      await deleteProducePhotos(uploaded);
      failures += 1;
      process.stderr.write(`Could not migrate listing ${record._id}; its existing database references and local files were retained.\n`);
    }
  }

  process.stdout.write(`Migration complete: ${migratedListings} listing(s), ${migratedPhotos} photo(s) updated; ${retainedLocalFiles} local file(s) remain after database updates; ${failures} listing(s) failed.\n`);
  if (failures) process.exitCode = 1;
};

try {
  await migrate();
} catch {
  process.stderr.write('Migration could not start. Check MongoDB and Cloudinary configuration.\n');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
