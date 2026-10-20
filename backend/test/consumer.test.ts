import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import mongoose, { Types } from 'mongoose';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'consumer-test-token-secret'.padEnd(64, 'x');
process.env.PHONE_HASH_SECRET = 'consumer-test-phone-secret'.padEnd(64, 'x');
process.env.AADHAAR_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
process.env.NACALLER_KEY = 'consumer-test-nacaller-provider-key';
process.env.DATA_GOV_IN_API_KEY = '';

const [{ default: app }, models, { hmac }, { setProduceCloudinaryClientForTests }] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'), import('../src/crypto.js'), import('../src/services/produce-storage.js'),
]);

async function withServer(context: TestContext) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return (path: string, token?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mockAuthenticatedConsumer(context: TestContext, token: string) {
  const consumerId = new Types.ObjectId();
  context.mock.method(models.ConsumerSessionModel, 'findOne', async (query: { tokenHash: string }) => query.tokenHash === hmac(token)
    ? { consumerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000), save: async () => undefined }
    : null);
  context.mock.method(models.ConsumerModel, 'findOne', () => ({ select() { return this; }, exec: async () => ({ _id: consumerId, fullName: 'Test Consumer', email: 'private@example.com', accountStatus: 'active' }) }) as never);
  context.mock.method(models.FarmerModel, 'find', () => ({ select() { return this; }, lean() { return this; }, exec: async () => [] }) as never);
  context.mock.method(models.ProduceRequestModel, 'find', () => ({ sort() { return this; }, session() { return this; }, lean() { return this; }, exec: async () => [] }) as never);
  return consumerId;
}

test('Consumer email and password authentication is removed and phone verification requires explicit consent', async (context) => {
  const post = await withServer(context);
  const oldRegister = await post('/api/consumer/auth/register', undefined, { fullName: 'Test Consumer', email: 'buyer@example.com', password: 'long-password-123' });
  assert.equal(oldRegister.status, 404);
  const missingConsent = await post('/api/consumer/auth/phone-verification', undefined, { fullName: 'Test Consumer', phone: '+919876543210', purpose: 'registration', phoneVerificationConsent: false });
  assert.equal(missingConsent.status, 400);
  assert.deepEqual(await missingConsent.json(), { error: 'validation_failed', fields: [{ field: 'phoneVerificationConsent', message: 'Invalid literal value, expected true' }] });
});

test('a Consumer registration creates no account while pending and creates a session only after matching NaCaller verification', async (context) => {
  const post = await withServer(context);
  let challenge: Record<string, unknown> | null = null;
  let providerStatus = 'pending';
  let createdConsumers = 0;
  let registeredPhoneExists = false;
  context.mock.method(models.RateLimitModel.collection, 'findOneAndUpdate', async () => ({ count: 1 }) as never);
  const query = (read: () => unknown) => ({ sort() { return this; }, select() { return this; }, lean() { return this; }, exec: async () => read() });
  context.mock.method(models.ConsumerModel, 'findOne', () => query(() => registeredPhoneExists ? { _id: new Types.ObjectId() } : null) as never);
  context.mock.method(models.ConsumerModel, 'exists', async () => null as never);
  context.mock.method(models.ConsumerModel, 'create', async (record: Record<string, unknown>) => { createdConsumers += 1; return { _id: new Types.ObjectId(), preferredLanguage: 'en', ...record }; });
  context.mock.method(models.ConsumerSessionModel, 'create', async () => ({} as never));
  context.mock.method(models.OtpChallengeModel, 'findOne', () => query(() => challenge) as never);
  context.mock.method(models.OtpChallengeModel, 'findById', () => Object.assign({ select() { return this; }, then(resolve: (value: unknown) => unknown) { return Promise.resolve(challenge).then(resolve); } }, challenge) as never);
  context.mock.method(models.OtpChallengeModel, 'create', async (record: Record<string, unknown>) => { challenge = { _id: new Types.ObjectId(), ...record }; return challenge as never; });
  context.mock.method(models.OtpChallengeModel, 'findOneAndUpdate', (_filter: unknown, update: { $set?: Record<string, unknown> }) => { Object.assign(challenge!, update.$set); return Object.assign({ select() { return this; }, then(resolve: (value: unknown) => unknown) { return Promise.resolve(challenge).then(resolve); } }, challenge) as never; });
  context.mock.method(models.OtpChallengeModel, 'updateOne', async (_filter: unknown, update: { $set: Record<string, unknown> }) => { Object.assign(challenge!, update.$set); return {} as never; });
  const realFetch = globalThis.fetch.bind(globalThis);
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://api.nacaller.com/')) return realFetch(input, init);
    return String(input).endsWith('/status/provider-consumer-42')
      ? new Response(JSON.stringify({ requestId: 'provider-consumer-42', phone: '9876543210', reference: String(challenge?._id), status: providerStatus, verified: providerStatus === 'verified', expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 })
      : new Response(JSON.stringify({ requestId: 'provider-consumer-42', phone: '9876543210', callNumber: '+18005550123', instruction: 'Call this number to verify', status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
  });

  const start = await post('/api/consumer/auth/phone-verification', undefined, { fullName: 'Test Buyer', phone: '98765 43210', purpose: 'registration', phoneVerificationConsent: true });
  if (start.status !== 202) assert.fail(`verification start returned ${start.status}: ${JSON.stringify(await start.json())}`);
  const started = await start.json() as { challengeId: string; callNumber: string; instruction: string };
  assert.equal(started.callNumber, '+18005550123');
  assert.equal(started.instruction, 'Call this number to verify');
  assert.equal(createdConsumers, 0);

  const pending = await post(`/api/consumer/auth/phone-verification/${started.challengeId}/complete`, undefined, { fullName: 'Test Buyer' });
  assert.equal(pending.status, 409);
  assert.equal(createdConsumers, 0);
  providerStatus = 'verified';
  const complete = await post(`/api/consumer/auth/phone-verification/${started.challengeId}/complete`, undefined, { fullName: 'Test Buyer' });
  if (complete.status !== 201) assert.fail(`verification completion returned ${complete.status}: ${JSON.stringify(await complete.json())}`);
  assert.equal(createdConsumers, 1);
  const session = await complete.json() as { accessToken: string; consumer: { fullName: string } };
  assert.equal(session.consumer.fullName, 'Test Buyer');
  assert.equal('phone' in session.consumer, false);
  assert.ok(session.accessToken);
  registeredPhoneExists = true;
  const duplicate = await post('/api/consumer/auth/phone-verification', undefined, { fullName: 'Another Buyer', phone: '+919876543210', purpose: 'registration', phoneVerificationConsent: true });
  assert.equal(duplicate.status, 409);
  assert.equal(createdConsumers, 1);
});

test('consumer listings are published-only, searchable, paginated, and omit private data', async (context) => {
  const token = 'consumer-list-token-12345678901234567890';
  mockAuthenticatedConsumer(context, token);
  const records = [
    { _id: 'published-tomato', name: 'Tomato', sourceLanguage: 'en', nameTranslations: { kn: 'ಟೊಮೇಟೊ' }, quantity: 2, unit: 'kg', pricePerUnit: 18, priceUnit: 'kg', status: 'published', photos: [], farmerId: 'private-farmer', location: { status: 'captured', latitude: 12.9, longitude: 74.8, accuracyMeters: 20 }, aadhaarHash: 'private-hash', createdAt: new Date('2026-01-02') },
    { _id: 'published-beans', name: 'Beans', sourceLanguage: 'en', nameTranslations: {}, quantity: 3, unit: 'bunch', pricePerUnit: 30, priceUnit: 'bunch', status: 'published', photos: [{ mimeType: 'image/jpeg', publicId: 'private-public-id', assetId: 'private-asset-id' }], farmerId: 'private-farmer', phone: '+919999999999', createdAt: new Date('2026-01-01') },
    { _id: 'unpublished-draft', name: 'Draft Pumpkin', quantity: 4, unit: 'kg', pricePerUnit: 8, priceUnit: 'kg', status: 'priced_unpublished', photos: [], createdAt: new Date('2026-01-03') },
    { _id: 'unpriced-draft', name: 'Unpriced Pumpkin', quantity: 4, unit: 'kg', pricePerUnit: null, priceUnit: null, status: 'awaiting_price', photos: [], createdAt: new Date('2026-01-04') },
  ];
  context.mock.method(models.ProduceModel, 'find', (filter: Record<string, unknown>) => {
    assert.equal(filter.status, 'published');
    assert.deepEqual(filter.quantity, { $gt: 0 });
    assert.deepEqual(filter.pricePerUnit, { $gt: 0 });
    let results = records.filter((record) => record.status === 'published' && record.quantity > 0 && Number(record.pricePerUnit) > 0 && record.priceUnit);
    if (filter.$or) {
      const expressions = filter.$or as Array<Record<string, RegExp>>;
      results = results.filter((record) => expressions.some((clause) => Object.values(clause).some((regex) => regex.test(record.name) || regex.test(record.nameTranslations?.kn ?? ''))));
    }
    let skip = 0;
    let limit = results.length;
    return {
      sort(sortBy: Record<string, number>) { if (sortBy.pricePerUnit) results.sort((a, b) => a.pricePerUnit! - b.pricePerUnit!); else results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); return this; },
      skip(value: number) { skip = value; return this; },
      limit(value: number) { limit = value; return this; },
      lean() { return this; },
      exec: async () => results.slice(skip, skip + limit),
    } as never;
  });
  const get = await withServer(context);
  const first = await get('/api/consumer/produce?search=tomato&sort=newest&limit=1', token);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { items: Array<Record<string, unknown>>; hasMore: boolean };
  assert.equal(firstBody.items.length, 1);
  assert.equal(firstBody.hasMore, false);
  assert.equal(firstBody.items[0]!.id, 'published-tomato');
  assert.equal(firstBody.items[0]!.pricePerUnit, 18);
  assert.equal(firstBody.items[0]!.priceUnit, 'kg');
  assert.equal(firstBody.items[0]!.quantity, 2);
  assert.equal(firstBody.items[0]!.unit, 'kg');
  assert.equal(firstBody.items[0]!.photoUrl, null, 'no-photo listings remain visible without a photo URL');
  for (const privateField of ['farmerId', 'location', 'phone', 'aadhaarHash', 'publicId', 'assetId', 'storageKey']) assert.equal(privateField in firstBody.items[0]!, false);

  const pageOne = await get('/api/consumer/produce?sort=newest&limit=1&page=1', token);
  const pageOneBody = await pageOne.json() as { items: Array<{ id: string }>; hasMore: boolean };
  assert.equal(pageOneBody.items[0]!.id, 'published-tomato');
  assert.equal(pageOneBody.hasMore, true);
  const pageTwo = await get('/api/consumer/produce?sort=newest&limit=1&page=2', token);
  const pageTwoBody = await pageTwo.json() as { items: Array<{ id: string; photoUrl: string | null }>; hasMore: boolean };
  assert.equal(pageTwoBody.items[0]!.id, 'published-beans');
  assert.equal(pageTwoBody.items[0]!.photoUrl, '/api/consumer/produce/published-beans/photos/0');
  assert.equal(pageTwoBody.hasMore, false);
});

test('nearby search requires accurate origin and reports only coarse distance bands; consumer photo delivery is auth protected', async (context) => {
  const token = 'consumer-nearby-token-123456789012345678';
  mockAuthenticatedConsumer(context, token);
  context.mock.method(models.ProduceModel, 'find', (filter: Record<string, unknown>) => {
    assert.equal(filter['location.status'], 'captured');
    assert.deepEqual(filter['location.accuracyMeters'], { $lte: 1_000 });
    assert.equal(((filter.locationPoint as { $near: { $maxDistance: number } }).$near).$maxDistance, 5_000);
    const record = { _id: 'nearby-vegetable', name: 'Chili', sourceLanguage: 'en', nameTranslations: {}, quantity: 1, unit: 'kg', pricePerUnit: 60, priceUnit: 'kg', status: 'published', photos: [], location: { status: 'captured', latitude: 12.9, longitude: 74.8, accuracyMeters: 20 }, locationPoint: { type: 'Point', coordinates: [74.8, 12.9] } };
    return { skip() { return this; }, limit() { return this; }, lean() { return this; }, exec: async () => [record] } as never;
  });
  const get = await withServer(context);
  const missingLocation = await get('/api/consumer/produce?sort=nearby', token);
  assert.equal(missingLocation.status, 400);
  const nearby = await get('/api/consumer/produce?sort=nearby&latitude=12.9&longitude=74.8&accuracyMeters=15&distanceKm=5', token);
  const nearbyBody = await nearby.json() as { items: Array<{ distanceBand: string }> };
  assert.equal(nearby.status, 200);
  assert.equal(nearbyBody.items[0]!.distanceBand, 'within_2_km');

  const photoId = new Types.ObjectId();
  const missingPhotoId = new Types.ObjectId();
  context.mock.method(models.ProduceModel, 'findOne', (query: { _id: Types.ObjectId; status: string }) => {
    assert.equal(query.status, 'published');
    return { select() { return this; }, lean() { return this; }, exec: async () => String(query._id) === String(missingPhotoId) ? { photos: [] } : { photos: [{ publicId: 'private-asset-path', assetId: 'private-asset-id', resourceType: 'image', format: 'jpeg', mimeType: 'image/jpeg' }] } } as never;
  });
  const unauthorizedPhoto = await get(`/api/consumer/produce/${photoId}/photos/0`);
  assert.equal(unauthorizedPhoto.status, 401);
  const missingPhoto = await get(`/api/consumer/produce/${missingPhotoId}/photos/0`, token);
  assert.equal(missingPhoto.status, 404);
  assert.deepEqual(await missingPhoto.json(), { error: 'produce_image_not_found' });

  setProduceCloudinaryClientForTests({
    config: () => undefined,
    uploader: { upload_stream: (() => { throw new Error('unused'); }) as never, destroy: async () => ({ result: 'ok' }) },
    utils: { private_download_url: (publicId: string, format: string, options: Record<string, unknown>) => {
      assert.equal(publicId, 'private-asset-path');
      assert.equal(options.type, 'authenticated');
      assert.equal(format, 'jpeg');
      return 'data:image/jpeg;base64,dGVzdA==';
    } },
  });
  const authorizedPhoto = await get(`/api/consumer/produce/${photoId}/photos/0`, token);
  assert.equal(authorizedPhoto.status, 200);
  assert.equal(authorizedPhoto.headers.get('content-type'), 'image/jpeg');
  assert.equal(await authorizedPhoto.text(), 'test');
  assert.equal(authorizedPhoto.headers.get('location'), null, 'the private Cloudinary identifier stays server-side');
});

test('consumer product detail serializes selling price and photos without exposing farmer contact, GPS, or asset identifiers', async (context) => {
  const token = 'consumer-detail-token-123456789012345678';
  mockAuthenticatedConsumer(context, token);
  const produceId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  context.mock.method(models.ProduceModel, 'findOne', (filter: Record<string, unknown>) => ({
    select() { return this; }, lean() { return this; }, exec: async () => {
      assert.equal(filter.status, 'published');
      return { _id: produceId, farmerId, name: 'Tomato', sourceLanguage: 'en', nameTranslations: { kn: 'ಟೊಮೇಟೊ' }, quantity: 4, unit: 'kg', pricePerUnit: 27.5, priceUnit: 'kg', photos: [{ mimeType: 'image/jpeg', publicId: 'private-id', assetId: 'private-asset' }], location: { latitude: 12.9, longitude: 74.8 } };
    },
  }) as never);
  context.mock.method(models.FarmerModel, 'findById', () => ({ select() { return this; }, lean() { return this; }, exec: async () => ({ fullName: 'Farmer Display Name', phone: '+919999999999', address: 'Private address', aadhaarHash: 'private-hash' }) }) as never);
  context.mock.method(models.ProduceRequestModel, 'findOne', () => ({ sort() { return this; }, lean() { return this; }, exec: async () => null }) as never);
  const get = await withServer(context);
  const response = await get(`/api/consumer/produce/${produceId}`, token);
  assert.equal(response.status, 200);
  const body = await response.json() as { item: Record<string, unknown> };
  assert.equal(body.item.pricePerUnit, 27.5);
  assert.equal(body.item.priceUnit, 'kg');
  assert.equal(body.item.quantity, 4);
  assert.equal(body.item.farmerName, 'Farmer Display Name');
  assert.deepEqual(body.item.photoUrls, [`/api/consumer/produce/${produceId}/photos/0`]);
  for (const privateField of ['phone', 'address', 'aadhaarHash', 'farmerId', 'location', 'publicId', 'assetId', 'storageKey']) assert.equal(privateField in body.item, false);
});

test('Farmer publication is explicit, owner-scoped, and requires a priced listing', async (context) => {
  context.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async (callback: () => Promise<void>) => callback(), endSession: async () => undefined }) as never);
  const token = 'farmer-publication-token-123456789012345';
  const farmerId = new Types.ObjectId();
  const produceId = new Types.ObjectId();
  context.mock.method(models.SessionModel, 'findOne', async (query: { tokenHash: string }) => query.tokenHash === hmac(token)
    ? { farmerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) }
    : null);
  context.mock.method(models.FarmerModel, 'findById', async () => ({ _id: farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' }) as never);
  let currentStatus = 'priced_unpublished';
  context.mock.method(models.ProduceModel, 'findOne', (query: { _id: Types.ObjectId; farmerId: Types.ObjectId }) => {
    assert.equal(String(query._id), String(produceId));
    assert.equal(String(query.farmerId), String(farmerId));
    return { select() { return this; }, session() { return this; }, lean() { return this; }, exec: async () => ({ status: currentStatus, quantity: 3, pricePerUnit: 20, priceUnit: 'kg' }) } as never;
  });
  context.mock.method(models.ProduceModel, 'findOneAndUpdate', (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    assert.equal(String(filter.farmerId), String(farmerId));
    assert.equal(filter.status, currentStatus);
    currentStatus = String((update.$set as { status: string }).status);
    return { select() { return this; }, lean() { return this; }, exec: async () => ({ status: currentStatus }) } as never;
  });
  context.mock.method(models.ProduceRequestModel, 'find', () => ({ select() { return this; }, session() { return this; }, lean() { return this; }, exec: async () => [] }) as never);
  const request = await withServer(context);
  const publish = await request(`/api/farmer/produce/${produceId}/publication`, token, { published: true }, 'PATCH');
  assert.equal(publish.status, 200);
  assert.deepEqual(await publish.json(), { status: 'published' });
  const unpublish = await request(`/api/farmer/produce/${produceId}/publication`, token, { published: false }, 'PATCH');
  assert.equal(unpublish.status, 200);
  assert.deepEqual(await unpublish.json(), { status: 'priced_unpublished' });
  currentStatus = 'awaiting_price';
  const publishUnpriced = await request(`/api/farmer/produce/${produceId}/publication`, token, { published: true }, 'PATCH');
  assert.equal(publishUnpriced.status, 409);
  assert.deepEqual(await publishUnpriced.json(), { error: 'produce_not_ready_to_publish' });
});
