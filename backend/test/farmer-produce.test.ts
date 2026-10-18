import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'produce-test-token-secret-'.padEnd(64, 'x');
process.env.PRODUCE_IMAGE_STORAGE = 'local';
const testImageDirectory = await mkdtemp(join(tmpdir(), 'karavali-produce-test-'));
process.env.PRODUCE_IMAGE_DIR = testImageDirectory;

const [{ default: app }, models, { hmac }] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'), import('../src/crypto.js'), import('../src/services/produce-storage.js'),
]);

const farmerId = 'farmer-from-server-session';
const otherFarmerId = 'different-farmer';
const token = 'fictional-produce-session-token-123456789012345678';
const farmer = { _id: farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' };

test.after(async () => rm(testImageDirectory, { recursive: true, force: true }));

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
  return (path: string, form?: FormData, method = 'POST') => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Idempotency-Key': '123e4567-e89b-42d3-a456-426614174000' } : {}) },
    ...(form ? { body: form } : {}),
  });
}

async function fictionalImage() {
  const svg = '<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#77aa55"/><text x="20" y="120">Fictional produce photo</text></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function makeForm(image: Buffer | null, options: { name?: string; quantity?: string; unit?: string; count?: number; imageMime?: string } = {}) {
  const form = new FormData();
  form.append('name', options.name ?? 'Fictional Kale');
  form.append('quantity', options.quantity ?? '12.5');
  form.append('unit', options.unit ?? 'kg');
  form.append('farmerId', otherFarmerId);
  for (let index = 0; image && index < (options.count ?? 2); index++) {
    form.append('photos', new Blob([new Uint8Array(image)], { type: options.imageMime ?? 'image/png' }), `produce-${index}.png`);
  }
  return form;
}

test('authenticated create stores a draft owned by the session Farmer and returns safe photo metadata', async (context) => {
  mockAuthentication(context);
  const image = await fictionalImage();
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  context.mock.method(models.ProduceModel, 'create', async (documents: Array<Record<string, unknown>>) => {
    const document = documents[0]!;
    assert.equal(String(document.farmerId), farmerId);
    assert.equal(document.name, 'Fictional Kale');
    assert.equal(document.quantity, 12.5);
    assert.equal(document.status, 'awaiting_price');
    const now = new Date();
    return [{ ...document, _id: 'fictional-produce-id', createdAt: now, updatedAt: now }] as never;
  });
  const post = await withServer(context);
  const response = await post('/api/farmer/produce', makeForm(image));
  assert.equal(response.status, 201);
  const body = await response.json() as { item: { status: string; photos: Array<{ url: string }> } };
  assert.equal(body.item.status, 'awaiting_price');
  assert.equal(body.item.photos.length, 2);
  assert.match(body.item.photos[0]!.url, /\/photos\/0$/);
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

test('produce creation rejects unsupported image bytes even when the multipart MIME says PNG', async (context) => {
  mockAuthentication(context);
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  const post = await withServer(context);
  const fakePng = Buffer.from('not an image');
  const response = await post('/api/farmer/produce', makeForm(fakePng));
  assert.equal(response.status, 400, await response.clone().text());
  assert.deepEqual(await response.json(), { error: 'invalid_produce_image' });
});

test('storage or database failure does not leave partial image files', async (context) => {
  mockAuthentication(context);
  const image = await fictionalImage();
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  context.mock.method(models.ProduceModel, 'create', async () => { throw new Error('synthetic database unavailable'); });
  const post = await withServer(context);
  const existingFiles = await readdir(testImageDirectory);
  const response = await post('/api/farmer/produce', makeForm(image));
  assert.equal(response.status, 500);
  assert.deepEqual(await readdir(testImageDirectory), existingFiles);
});

test('unconfigured image storage fails clearly and does not save a produce record', async (context) => {
  mockAuthentication(context);
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  const create = context.mock.method(models.ProduceModel, 'create', async () => { throw new Error('must not be called'); });
  const post = await withServer(context);
  const image = await fictionalImage();
  process.env.PRODUCE_IMAGE_STORAGE = 'not-configured';
  try {
    const response = await post('/api/farmer/produce', makeForm(image));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'produce_image_storage_not_configured' });
    assert.equal(create.mock.calls.length, 0);
  } finally { process.env.PRODUCE_IMAGE_STORAGE = 'local'; }
});

