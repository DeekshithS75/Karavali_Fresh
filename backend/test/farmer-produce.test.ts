import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { Writable } from 'node:stream';
import sharp from 'sharp';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'produce-test-token-secret-'.padEnd(64, 'x');
process.env.CLOUDINARY_CLOUD_NAME = 'synthetic-cloud';
process.env.CLOUDINARY_API_KEY = 'synthetic-api-key';
process.env.CLOUDINARY_API_SECRET = 'synthetic-api-secret-do-not-return';

const [{ default: app }, models, { hmac }, produceStorage] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'), import('../src/crypto.js'), import('../src/services/produce-storage.js'),
]);

const farmerId = 'farmer-from-server-session';
const otherFarmerId = 'different-farmer';
const token = 'fictional-produce-session-token-123456789012345678';
const farmer = { _id: farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' };
let uploadCount = 0;
let failUploadNumber: number | null = null;
const uploadedPublicIds: string[] = [];
const deletedPublicIds: string[] = [];
const uploadRequests: Array<Record<string, unknown>> = [];
const deliveryRequests: Array<{ publicId: string; format: string; options: Record<string, unknown> }> = [];
let cloudinaryConfig: Record<string, unknown> = {};

const mockCloudinary = {
  config: (options: Record<string, unknown>) => { cloudinaryConfig = options; },
  uploader: {
    upload_stream: (options: Record<string, unknown>, callback: (error: Error | null, result?: { public_id: string; asset_id: string; resource_type: string; format: string; width: number; height: number; bytes: number }) => void) => {
      uploadCount += 1;
      uploadRequests.push(options);
      const currentUpload = uploadCount;
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
        final(done) {
          if (currentUpload === failUploadNumber) {
            callback(new Error('synthetic Cloudinary failure'));
          } else {
            const public_id = `${String(options.folder)}/${String(options.public_id)}`;
            uploadedPublicIds.push(public_id);
            callback(null, { public_id, asset_id: `synthetic-asset-${currentUpload}`, resource_type: 'image', format: String(options.format), width: 320, height: 240, bytes: Buffer.concat(chunks).length });
          }
          done();
        },
      });
    },
    destroy: async (publicId: string, options: Record<string, unknown>) => {
      assert.equal(options.type, 'authenticated');
      deletedPublicIds.push(publicId);
      return { result: 'ok' };
    },
  },
  utils: {
    private_download_url: (publicId: string, format: string, options: Record<string, unknown>) => {
      deliveryRequests.push({ publicId, format, options });
      return `https://res.cloudinary.com/synthetic-cloud/image/authenticated/${encodeURIComponent(publicId)}.${format}?expires_at=${String(options.expires_at)}&signature=synthetic-signature`;
    },
  },
};
produceStorage.setProduceCloudinaryClientForTests(mockCloudinary);

function resetCloudinaryState() {
  uploadCount = 0;
  failUploadNumber = null;
  uploadedPublicIds.length = 0;
  deletedPublicIds.length = 0;
  uploadRequests.length = 0;
  deliveryRequests.length = 0;
}

function mockAuthentication(context: TestContext) {
  context.mock.method(models.SessionModel, 'findOne', async (query: unknown) => {
    assert.equal((query as { tokenHash: string }).tokenHash, hmac(token));
    return { farmerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never;
  });
  context.mock.method(models.FarmerModel, 'findById', async (id: unknown) => {
    assert.equal(String(id), farmerId);
    return farmer as never;
  });
}

async function withServer(context: TestContext) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return (path: string, body?: BodyInit, method = 'POST', extraHeaders: HeadersInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Idempotency-Key': '123e4567-e89b-42d3-a456-426614174000' } : {}), ...extraHeaders },
    ...(body ? { body } : {}),
  });
}

async function fictionalImage() {
  const svg = '<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#77aa55"/><text x="20" y="120">Fictional produce photo</text></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function makeForm(image: Buffer | null, options: { name?: string; sourceLanguage?: string; nameTranslations?: string; quantity?: string; unit?: string; pricePerUnit?: string; omitPrice?: boolean; count?: number; imageMime?: string } = {}) {
  const form = new FormData();
  form.append('name', options.name ?? 'Fictional Kale');
  form.append('sourceLanguage', options.sourceLanguage ?? 'en');
  if (options.nameTranslations) form.append('nameTranslations', options.nameTranslations);
  form.append('quantity', options.quantity ?? '12.5');
  form.append('unit', options.unit ?? 'kg');
  if (!options.omitPrice) form.append('pricePerUnit', options.pricePerUnit ?? '45.75');
  form.append('farmerId', otherFarmerId);
  for (let index = 0; image && index < (options.count ?? 2); index++) {
    form.append('photos', new Blob([new Uint8Array(image)], { type: options.imageMime ?? 'image/png' }), `produce-${index}.png`);
  }
  return form;
}

test('authenticated create stores a priced unpublished listing owned by the session Farmer', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const image = await fictionalImage();
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  let expectedProduceId = '';
  context.mock.method(models.ProduceModel, 'create', async (documents: Array<Record<string, unknown>>) => {
    const document = documents[0]!;
    assert.equal(String(document.farmerId), farmerId);
    assert.equal(document.name, 'Fictional Kale');
    assert.equal(document.sourceLanguage, 'kn');
    assert.deepEqual(document.nameTranslations, { en: 'Fictional Kale', kn: 'ಕಾಲ್ಪನಿಕ ಕೇಲ್', tcy: 'ಕಾಲ್ಪನಿಕ ಕೇಲ್' });
    assert.equal(document.quantity, 12.5);
    assert.equal(document.unit, 'kg');
    assert.equal(document.pricePerUnit, 45.75);
    assert.equal(document.status, 'priced_unpublished');
    const produceId = String(document._id);
    expectedProduceId = produceId;
    const photos = document.photos as Array<Record<string, unknown>>;
    assert.equal(photos.length, 2);
    assert.ok(photos.every((photo) => String(photo.publicId).startsWith(`karavali-fresh/farmers/${farmerId}/produce/${produceId}/`)));
    assert.ok(photos.every((photo) => photo.resourceType === 'image' && typeof photo.assetId === 'string' && photo.width === 320 && photo.height === 240));
    assert.ok(photos.every((photo) => !('base64' in photo) && !('storageKey' in photo)));
    const now = new Date();
    return [{ ...document, _id: 'fictional-produce-id', createdAt: now, updatedAt: now }] as never;
  });
  const post = await withServer(context);
  const response = await post('/api/farmer/produce', makeForm(image, { sourceLanguage: 'kn', nameTranslations: JSON.stringify({ en: 'Fictional Kale', kn: 'ಕಾಲ್ಪನಿಕ ಕೇಲ್', tcy: 'ಕಾಲ್ಪನಿಕ ಕೇಲ್' }) }));
  assert.equal(response.status, 201);
  const body = await response.json() as { item: { status: string; pricePerUnit: number; quantity: number; unit: string; photos: Array<{ url: string }> } };
  assert.equal(body.item.status, 'priced_unpublished');
  assert.equal(body.item.pricePerUnit, 45.75);
  assert.equal(body.item.quantity, 12.5);
  assert.equal(body.item.unit, 'kg');
  assert.equal(body.item.photos.length, 2);
  assert.match(body.item.photos[0]!.url, /\/photos\/0$/);
  assert.equal(uploadCount, 2);
  assert.ok(uploadRequests.every((options) => options.resource_type === 'image' && options.type === 'authenticated' && options.overwrite === false));
  assert.ok(uploadRequests.every((options) => options.folder === `karavali-fresh/farmers/${farmerId}/produce/${expectedProduceId}`));
  assert.equal(deletedPublicIds.length, 0);
  assert.deepEqual(cloudinaryConfig, { cloud_name: 'synthetic-cloud', api_key: 'synthetic-api-key', api_secret: 'synthetic-api-secret-do-not-return', secure: true });
});

test('produce listing query is scoped to the authenticated Farmer', async (context) => {
  mockAuthentication(context);
  const now = new Date();
  context.mock.method(models.ProduceModel, 'find', (query: unknown) => {
    assert.equal(String((query as { farmerId: unknown }).farmerId), farmerId);
    return { sort: () => ({ lean: () => ({ exec: async () => [{
      _id: 'owned-produce', name: 'Fictional Greens', quantity: 3, unit: 'bunch', status: 'awaiting_price',
      photos: [{ storageKey: 'fictional-key.png', mimeType: 'image/png', size: 120 }], createdAt: now, updatedAt: now,
    }] }) }) } as never;
  });
  const get = await withServer(context);
  const response = await get('/api/farmer/produce', undefined, 'GET');
  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ name: string }> };
  assert.deepEqual(body.items.map(({ name }) => name), ['Fictional Greens']);
  assert.equal(body.items.some(({ name }) => name === String(otherFarmerId)), false);
});

test('produce creation rejects invalid quantity, missing photos, and more than five photos', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const post = await withServer(context);
  const image = await fictionalImage();
  const invalidQuantity = await post('/api/farmer/produce', makeForm(image, { quantity: '0' }));
  assert.equal(invalidQuantity.status, 400);
  const missingPhotos = await post('/api/farmer/produce', makeForm(null));
  assert.equal(missingPhotos.status, 400);
  assert.deepEqual(await missingPhotos.json(), { error: 'produce_photo_count_invalid' });
  const tooMany = await post('/api/farmer/produce', makeForm(image, { count: 6 }));
  assert.equal(tooMany.status, 400);
});

test('produce creation allows a missing selling price and rejects invalid entered prices', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const post = await withServer(context);
  const image = await fictionalImage();
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  context.mock.method(models.ProduceModel, 'create', async (documents: Array<Record<string, unknown>>) => {
    const now = new Date();
    return [{ ...documents[0], _id: '64b000000000000000000009', createdAt: now, updatedAt: now }] as never;
  });
  const noPrice = await post('/api/farmer/produce', makeForm(image, { omitPrice: true }));
  assert.equal(noPrice.status, 201);
  const noPriceItem = (await noPrice.json() as { item: { pricePerUnit: number | null; priceUnit: string | null; status: string } }).item;
  assert.equal(noPriceItem.pricePerUnit, null);
  assert.equal(noPriceItem.priceUnit, null);
  assert.equal(noPriceItem.status, 'awaiting_price');
  for (const form of [
    makeForm(image, { pricePerUnit: '0' }),
    makeForm(image, { pricePerUnit: '-4' }),
    makeForm(image, { pricePerUnit: 'not-a-price' }),
  ]) {
    const response = await post('/api/farmer/produce', form);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, 'produce_price_invalid');
  }
});

test('owner can add a price to an existing awaiting-price draft without replacing its photos or quantity', async (context) => {
  mockAuthentication(context);
  const produceId = '64b000000000000000000001';
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const originalPhoto = { storageKey: 'existing-photo-key.png', mimeType: 'image/png', size: 1234 };
  const updated = {
    _id: produceId, name: 'Fictional Kale', nameTranslations: { kn: 'ಕಾಲ್ಪನಿಕ ಸೊಪ್ಪು' }, quantity: 12.5, unit: 'quintal', pricePerUnit: 88.25,
    status: 'priced_unpublished', photos: [originalPhoto, { ...originalPhoto, storageKey: 'photo-two.png' }],
    createdAt, updatedAt: new Date(),
  };
  context.mock.method(models.ProduceModel, 'findOneAndUpdate', (filter: unknown, update: unknown, options: unknown) => {
    const query = filter as { _id: string; farmerId: string; status: string; pricePerUnit: null };
    assert.equal(query._id, produceId);
    assert.equal(query.farmerId, farmerId);
    assert.equal(query.status, 'awaiting_price');
    assert.equal(query.pricePerUnit, null);
    assert.deepEqual(update, { $set: { pricePerUnit: 88.25, priceUnit: 'quintal', status: 'priced_unpublished' } });
    assert.deepEqual(options, { new: true, runValidators: true });
    return { lean: () => ({ exec: async () => updated }) } as never;
  });
  context.mock.method(models.ProduceModel, 'findOne', () => ({ select: () => ({ lean: () => ({ exec: async () => ({ unit: 'quintal' }) }) }) }) as never);
  const patchPrice = await withServer(context);
  const response = await patchPrice(`/api/farmer/produce/${produceId}/price`, JSON.stringify({ pricePerUnit: '88.25' }), 'PATCH', { 'Content-Type': 'application/json' });
  assert.equal(response.status, 200);
  const body = await response.json() as { item: { pricePerUnit: number; quantity: number; unit: string; status: string; nameTranslations: { kn: string }; photos: Array<{ url: string }> } };
  assert.equal(body.item.pricePerUnit, 88.25);
  assert.equal(body.item.quantity, 12.5);
  assert.equal(body.item.unit, 'quintal');
  assert.equal(body.item.status, 'priced_unpublished');
  assert.deepEqual(body.item.nameTranslations, { kn: 'ಕಾಲ್ಪನಿಕ ಸೊಪ್ಪು' });
  assert.deepEqual(body.item.photos.map(({ url }) => url), [
    `/api/farmer/produce/${produceId}/photos/0`,
    `/api/farmer/produce/${produceId}/photos/1`,
  ]);
});

test('one Farmer cannot add a price to another Farmer listing', async (context) => {
  mockAuthentication(context);
  const produceId = '64b000000000000000000002';
  context.mock.method(models.ProduceModel, 'findOneAndUpdate', (filter: unknown) => {
    assert.equal((filter as { farmerId: string }).farmerId, farmerId);
    return { lean: () => ({ exec: async () => null }) } as never;
  });
  context.mock.method(models.ProduceModel, 'findOne', (filter: unknown) => {
    assert.equal((filter as { farmerId: string }).farmerId, farmerId);
    return { select: () => ({ lean: () => ({ exec: async () => null }) }) } as never;
  });
  const patchPrice = await withServer(context);
  const response = await patchPrice(`/api/farmer/produce/${produceId}/price`, JSON.stringify({ pricePerUnit: 12 }), 'PATCH', { 'Content-Type': 'application/json' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'produce_not_found' });
});

test('produce creation rejects unsupported image bytes even when the multipart MIME says PNG', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  const post = await withServer(context);
  const fakePng = Buffer.from('not an image');
  const response = await post('/api/farmer/produce', makeForm(fakePng));
  assert.equal(response.status, 400, await response.clone().text());
  assert.deepEqual(await response.json(), { error: 'invalid_produce_image' });
  assert.equal(uploadCount, 0);
});

test('produce photos over 8 MB are rejected before any Cloudinary upload', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const post = await withServer(context);
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
  const response = await post('/api/farmer/produce', makeForm(oversized));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, 'produce_image_too_large');
  assert.equal(uploadCount, 0);
});

test('database-save failure deletes every newly uploaded Cloudinary asset', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const image = await fictionalImage();
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  context.mock.method(models.ProduceModel, 'create', async () => { throw new Error('synthetic database unavailable'); });
  const post = await withServer(context);
  const response = await post('/api/farmer/produce', makeForm(image));
  assert.equal(response.status, 500);
  assert.equal(uploadedPublicIds.length, 2);
  assert.deepEqual(deletedPublicIds, uploadedPublicIds);
});

test('a Cloudinary provider failure cleans up assets from earlier successful uploads', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  const create = context.mock.method(models.ProduceModel, 'create', async () => { throw new Error('must not be called'); });
  failUploadNumber = 2;
  const post = await withServer(context);
  const response = await post('/api/farmer/produce', makeForm(await fictionalImage()));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'produce_image_storage_failed' });
  assert.equal(uploadedPublicIds.length, 1);
  assert.deepEqual(deletedPublicIds, uploadedPublicIds);
  assert.equal(create.mock.calls.length, 0);
});

test('missing Cloudinary configuration fails closed and does not save a produce record', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  const create = context.mock.method(models.ProduceModel, 'create', async () => { throw new Error('must not be called'); });
  const post = await withServer(context);
  const image = await fictionalImage();
  process.env.CLOUDINARY_API_SECRET = '';
  try {
    const response = await post('/api/farmer/produce', makeForm(image));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'produce_image_storage_not_configured' });
    assert.equal(create.mock.calls.length, 0);
    assert.equal(uploadCount, 0);
  } finally { process.env.CLOUDINARY_API_SECRET = 'synthetic-api-secret-do-not-return'; }
});

test('authorized photo delivery uses an expiring signed authenticated Cloudinary URL', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const produceId = '64b000000000000000000003';
  context.mock.method(models.ProduceModel, 'findOne', (query: unknown) => {
    assert.equal(String((query as { _id: unknown })._id), produceId);
    assert.equal(String((query as { farmerId: unknown }).farmerId), farmerId);
    return { lean: () => ({ exec: async () => ({ photos: [{ publicId: `karavali-fresh/farmers/${farmerId}/produce/${produceId}/synthetic-photo`, assetId: 'synthetic-asset', resourceType: 'image', format: 'png', mimeType: 'image/png' }] }) }) } as never;
  });
  const get = await withServer(context);
  const response = await get(`/api/farmer/produce/${produceId}/photos/0`, undefined, 'GET');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const signedUrl = response.headers.get('location')!;
  assert.match(signedUrl, /^https:\/\/res\.cloudinary\.com\/synthetic-cloud\/image\/authenticated\//);
  assert.equal(signedUrl.includes(process.env.CLOUDINARY_API_SECRET!), false);
  assert.equal(deliveryRequests.length, 1);
  assert.equal(deliveryRequests[0]!.options.type, 'authenticated');
  assert.equal(deliveryRequests[0]!.options.resource_type, 'image');
  const expiry = Number(deliveryRequests[0]!.options.expires_at);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(expiry > now && expiry <= now + 5 * 60);
  const mockedCloudinaryAcceptsSignedUrl = (at: number) => Number(new URL(signedUrl).searchParams.get('expires_at')) >= at;
  assert.equal(mockedCloudinaryAcceptsSignedUrl(now), true);
  assert.equal(mockedCloudinaryAcceptsSignedUrl(expiry + 1), false, 'expired signed URLs must stop authorizing delivery');
});

test('a different Farmer cannot obtain a signed URL for a saved photo', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  context.mock.method(models.ProduceModel, 'findOne', (query: unknown) => {
    assert.equal(String((query as { farmerId: unknown }).farmerId), farmerId);
    return { lean: () => ({ exec: async () => null }) } as never;
  });
  const get = await withServer(context);
  const response = await get('/api/farmer/produce/64b000000000000000000005/photos/0', undefined, 'GET');
  assert.equal(response.status, 404);
  assert.equal(deliveryRequests.length, 0);
});

test('a repeated idempotency key returns the saved listing without another Cloudinary upload', async (context) => {
  resetCloudinaryState();
  mockAuthentication(context);
  const produceId = '64b000000000000000000004';
  const saved = { _id: produceId, name: 'Already saved', sourceLanguage: 'en', quantity: 2, unit: 'kg', pricePerUnit: 10, priceUnit: 'kg', status: 'priced_unpublished', photos: [{ publicId: 'saved/asset', assetId: 'saved-asset', resourceType: 'image', format: 'png', mimeType: 'image/png', size: 120 }], createdAt: new Date(), updatedAt: new Date() };
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => saved }) }) as never);
  const post = await withServer(context);
  const response = await post('/api/farmer/produce', makeForm(await fictionalImage()));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { item: { id: string } }).item.id, produceId);
  assert.equal(uploadCount, 0);
  assert.equal(deletedPublicIds.length, 0);
});

