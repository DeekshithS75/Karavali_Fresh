import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import mongoose, { Types } from 'mongoose';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'consumer-test-token-secret'.padEnd(64, 'x');
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

function mockConsumerStore(context: TestContext) {
  const consumers: Array<{ _id: Types.ObjectId; fullName: string; email: string; passwordHash: string; accountStatus: string }> = [];
  const sessions: Array<{ _id: Types.ObjectId; consumerId: Types.ObjectId; tokenHash: string; expiresAt: Date; revokedAt: Date | null; save: () => Promise<void> }> = [];
  context.mock.method(models.ConsumerModel, 'exists', async (query: { email: string }) => consumers.some((consumer) => consumer.email === query.email));
  context.mock.method(models.ConsumerModel, 'create', async (data: { fullName: string; email: string; passwordHash: string }) => {
    const consumer = { _id: new Types.ObjectId(), ...data, accountStatus: 'active' };
    consumers.push(consumer);
    return consumer as never;
  });
  context.mock.method(models.ConsumerModel, 'findOne', (query: { email?: string; _id?: Types.ObjectId }) => ({
    select() { return this; },
    async exec() { return consumers.find((consumer) => query.email ? consumer.email === query.email : String(consumer._id) === String(query._id)) ?? null; },
  }) as never);
  context.mock.method(models.ConsumerSessionModel, 'create', async (data: { consumerId: Types.ObjectId; tokenHash: string; expiresAt: Date; revokedAt: null }) => {
    const session = { _id: new Types.ObjectId(), ...data, save: async () => undefined };
    sessions.push(session);
    return session as never;
  });
  context.mock.method(models.ConsumerSessionModel, 'findOne', async (query: { tokenHash: string; revokedAt: null }) => {
    return sessions.find((session) => session.tokenHash === query.tokenHash && !session.revokedAt && session.expiresAt > new Date()) ?? null;
  });
  return { consumers, sessions };
}

function mockAuthenticatedConsumer(context: TestContext, token: string) {
  const consumerId = new Types.ObjectId();
  context.mock.method(models.ConsumerSessionModel, 'findOne', async (query: { tokenHash: string }) => query.tokenHash === hmac(token)
    ? { consumerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000), save: async () => undefined }
    : null);
  context.mock.method(models.ConsumerModel, 'findOne', () => ({ select() { return this; }, exec: async () => ({ _id: consumerId, fullName: 'Test Consumer', email: 'private@example.com', accountStatus: 'active' }) }) as never);
  context.mock.method(models.FarmerModel, 'find', () => ({ select() { return this; }, lean() { return this; }, exec: async () => [] }) as never);
  return consumerId;
}

test('consumer register, login, session validation, logout, and role isolation use separate server sessions', async (context) => {
  const { consumers, sessions } = mockConsumerStore(context);
  const pushedTokens: string[] = [];
  context.mock.method(models.PushTokenModel, 'updateOne', (filter: { token: string }) => ({ exec: async () => { pushedTokens.push(filter.token); return { matchedCount: 1, modifiedCount: 1 }; } }) as never);
  const post = await withServer(context);
  const registration = await post('/api/consumer/auth/register', undefined, { fullName: 'Test Consumer', email: '  TEST@example.com ', password: 'a-long-test-password' });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { accessToken: string; consumer: { fullName: string; email?: string } };
  assert.equal(registered.consumer.fullName, 'Test Consumer');
  assert.equal('email' in registered.consumer, false);
  assert.match(consumers[0]!.passwordHash, /^scrypt\$/);
  assert.notEqual(consumers[0]!.passwordHash, 'a-long-test-password');
  assert.equal(sessions.length, 1);

  const badLogin = await post('/api/consumer/auth/login', undefined, { email: 'test@example.com', password: 'incorrect-password' });
  assert.equal(badLogin.status, 401);
  const duplicate = await post('/api/consumer/auth/register', undefined, { fullName: 'Test Consumer', email: 'test@example.com', password: 'another-long-password' });
  assert.equal(duplicate.status, 409);

  const login = await post('/api/consumer/auth/login', undefined, { email: 'TEST@example.com', password: 'a-long-test-password' });
  assert.equal(login.status, 200);
  const loggedIn = await login.json() as { accessToken: string };
  const session = await post('/api/consumer/auth/session', loggedIn.accessToken);
  assert.equal(session.status, 200);
  assert.equal((await session.json() as { role: string }).role, 'consumer');
  const registeredPush = await post('/api/consumer/push-tokens', loggedIn.accessToken, { token: 'ExpoPushToken[valid-consumer-token]' });
  assert.equal(registeredPush.status, 204);
  assert.equal(pushedTokens[0], 'ExpoPushToken[valid-consumer-token]');

  context.mock.method(models.SessionModel, 'findOne', async () => null);
  const farmerOnly = await post('/api/farmer/auth/session', loggedIn.accessToken);
  assert.equal(farmerOnly.status, 401, 'a Consumer token cannot enter Farmer-only routes');
  const consumerOnlyWithFarmerToken = await post('/api/consumer/auth/session', 'farmer-test-token-not-in-consumer-store-1234567890');
  assert.equal(consumerOnlyWithFarmerToken.status, 401, 'a Farmer token cannot enter Consumer-only routes');
  const farmerTokenListings = await post('/api/consumer/produce', 'farmer-test-token-not-in-consumer-store-1234567890');
  assert.equal(farmerTokenListings.status, 401, 'a Farmer token cannot browse Consumer listings');

  const logout = await post('/api/consumer/auth/logout', loggedIn.accessToken, {}, 'POST');
  assert.equal(logout.status, 204);
  const afterLogout = await post('/api/consumer/auth/session', loggedIn.accessToken);
  assert.equal(afterLogout.status, 401);
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
