/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import mongoose, { Types } from 'mongoose';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'request-workflow-test-token-secret'.padEnd(64, 'x');
process.env.LIVEKIT_URL = 'wss://request-tests.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'request-test-livekit-key';
process.env.LIVEKIT_API_SECRET = 'request-test-livekit-secret';

const [{ default: app }, models, { hmac }] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'), import('../src/crypto.js'),
]);

const buyerToken = 'buyer-request-token-123456789012345678';
const farmerToken = 'farmer-request-token-123456789012345678';
const buyerId = new Types.ObjectId();
const farmerId = new Types.ObjectId();
const listingId = new Types.ObjectId();
const farmer = { _id: farmerId, fullName: 'Farmer Name', phone: '+919876543210', address: 'Private address', accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' };

async function server(context: TestContext) {
  context.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback: () => Promise<void>) => callback(),
    endSession: async () => undefined,
  }) as never);
  context.mock.method(models.ConsumerSessionModel, 'findOne', async (query: { tokenHash: string }) => query.tokenHash === hmac(buyerToken)
    ? { consumerId: buyerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } : null);
  context.mock.method(models.ConsumerModel, 'findOne', () => ({
    select() { return this; }, lean() { return this; }, exec: async () => ({ _id: buyerId, fullName: 'Buyer', accountStatus: 'active' }),
  }) as never);
  context.mock.method(models.ConsumerModel, 'find', () => ({ select() { return this; }, lean() { return this; }, exec: async () => [{ _id: buyerId, fullName: 'Buyer' }] }) as never);
  context.mock.method(models.ConsumerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.FarmerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.CallAttemptModel, 'findOne', (filter: Record<string, any>) => query(() => {
    const matches = db.callAttempts.filter((item) => String(item.requestId) === String(filter.requestId) && (!filter.status?.$in || filter.status.$in.includes(item.status)));
    return matches.sort((a, b) => Number(b.attempt ?? 0) - Number(a.attempt ?? 0))[0] ?? null;
  }) as never);
  context.mock.method(models.CallAttemptModel, 'create', async (records: Array<Record<string, any>>) => {
    const saved = records.map((record) => ({ _id: new Types.ObjectId(), ...record }));
    db.callAttempts.push(...saved);
    return saved as never;
  });
  context.mock.method(models.CallAttemptModel, 'updateOne', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    const item = db.callAttempts.find((attempt) => String(attempt._id) === String(filter._id) && (!filter.status || attempt.status === filter.status));
    if (!item) return { modifiedCount: 0 };
    Object.assign(item, update.$set ?? {});
    for (const key of Object.keys(update.$unset ?? {})) delete item[key];
    return { modifiedCount: 1 };
  }) as never);
  context.mock.method(models.InAppCallModel, 'findOne', (filter: Record<string, any>) => query(() => db.inAppCalls.find((item) => String(item.activeRequestId) === String(filter.activeRequestId)) ?? null) as never);
  context.mock.method(models.InAppCallModel, 'create', async (records: Array<Record<string, any>>) => records.map((record) => {
    const saved = { _id: new Types.ObjectId(), ...record };
    db.inAppCalls.push(saved);
    return saved;
  }) as never);
  context.mock.method(models.InAppCallModel, 'updateOne', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    const item = db.inAppCalls.find((record) => String(record._id) === String(filter._id));
    if (!item) return { modifiedCount: 0 };
    Object.assign(item, update.$set ?? {});
    for (const key of Object.keys(update.$unset ?? {})) delete item[key];
    return { modifiedCount: 1 };
  }) as never);
  context.mock.method(models.SessionModel, 'findOne', async (query: { tokenHash: string }) => query.tokenHash === hmac(farmerToken)
    ? { farmerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } : null);
  context.mock.method(models.FarmerModel, 'findById', () => ({
    ...farmer, select() { return this; }, lean() { return this; }, exec: async () => farmer,
  }) as never);
  context.mock.method(models.FarmerModel, 'findOne', () => ({ select() { return this; }, lean() { return this; }, exec: async () => farmer }) as never);
  context.mock.method(models.PushTokenModel, 'find', () => query(() => []) as never);

  const db = {
    listing: { _id: listingId, farmerId, name: 'Tomato', unit: 'kg', quantity: 5, requestVersion: 0, status: 'published', pricePerUnit: 20, priceUnit: 'kg', photos: [] as Array<Record<string, unknown>>, deleted: false },
    requests: [] as Array<Record<string, any>>,
    notifications: [] as Array<Record<string, any>>,
    callAttempts: [] as Array<Record<string, any>>,
    inAppCalls: [] as Array<Record<string, any>>,
    extraListings: new Set<string>(),
    extraListingFarmers: new Map<string, Types.ObjectId>(),
  };

  context.mock.method(models.ProduceModel, 'findOne', (filter: Record<string, any>) => query(() => {
    if (filter.status === 'published') return !db.listing.deleted && db.listing.status === 'published' && db.listing.quantity > 0 ? db.listing : null;
    return !db.listing.deleted && String(filter._id) === String(listingId) && String(filter.farmerId) === String(farmerId) ? db.listing : null;
  }) as never);
  context.mock.method(models.ProduceModel, 'findOneAndUpdate', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    if (update.$inc?.requestVersion) {
      if (db.listing.deleted || db.listing.status !== 'published' || db.listing.quantity <= 0) return null;
      db.listing.requestVersion += update.$inc.requestVersion;
      return { ...db.listing, farmerId: db.extraListingFarmers.get(String(filter._id)) ?? db.listing.farmerId };
    }
    if (update.$set?.status) {
      db.listing.status = update.$set.status;
      return { status: db.listing.status };
    }
    if ((String(filter._id) !== String(listingId) && !db.extraListings.has(String(filter._id))) || String(filter.farmerId) !== String(farmerId) || db.listing.status !== 'published' || db.listing.quantity < filter.quantity.$gte) return null;
    db.listing.quantity += update.$inc.quantity;
    return { quantity: db.listing.quantity };
  }) as never);
  context.mock.method(models.ProduceModel, 'updateOne', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    if (String(filter._id) === String(listingId) && db.listing.quantity === 0) db.listing.status = update.$set.status;
    return { matchedCount: 1, modifiedCount: 1 };
  }) as never);
  context.mock.method(models.ProduceRequestModel, 'create', async (records: Array<Record<string, any>>) => records.map((record) => {
    const saved = { _id: new Types.ObjectId(), createdAt: new Date(), decidedAt: null, ...record };
    db.requests.push(saved);
    return { ...saved, toObject: () => saved };
  }) as never);
  context.mock.method(models.ProduceRequestModel, 'findOne', (filter: Record<string, any>) => query(() =>
    db.requests.find((item) => filter.requestKey
      ? String(item.buyerId) === String(filter.buyerId) && item.requestKey === filter.requestKey
      : String(item._id) === String(filter._id) && String(item.farmerId) === String(filter.farmerId) && (!filter.status || item.status === filter.status)) ?? null,
  ) as never);
  context.mock.method(models.ProduceRequestModel, 'find', (filter: Record<string, any>) => query(() => db.requests.filter((item) => {
    if (filter._id?.$in) return filter._id.$in.some((id: Types.ObjectId) => String(id) === String(item._id));
    if (filter.buyerId && String(item.buyerId) !== String(filter.buyerId)) return false;
    if (filter.farmerId && String(item.farmerId) !== String(filter.farmerId)) return false;
    if (filter.status?.$in && !filter.status.$in.includes(item.status)) return false;
    if (filter.status && !filter.status.$in && item.status !== filter.status) return false;
    return Boolean(filter.buyerId || filter.farmerId);
  })) as never);
  context.mock.method(models.ProduceRequestModel, 'updateOne', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    const record = db.requests.find((item) => String(item._id) === String(filter._id) && String(item.farmerId) === String(filter.farmerId) && item.status === filter.status);
    if (!record) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(record, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }) as never);
  context.mock.method(models.ProduceRequestModel, 'updateMany', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    const targets = db.requests.filter((item) => filter._id.$in.some((id: Types.ObjectId) => String(id) === String(item._id)) && String(item.farmerId) === String(filter.farmerId) && item.status === 'pending');
    for (const item of targets) Object.assign(item, update.$set);
    return { modifiedCount: targets.length };
  }) as never);
  context.mock.method(models.NotificationModel, 'create', async (records: Array<Record<string, any>>) => {
    const saved = records.map((item) => ({ _id: new Types.ObjectId(), readAt: null, createdAt: new Date(), ...item }));
    db.notifications.push(...saved);
    return saved as never;
  });
  context.mock.method(models.ProduceModel, 'deleteOne', (filter: Record<string, any>) => query(() => {
    if (String(filter._id) === String(listingId) && String(filter.farmerId) === String(farmerId)) { db.listing.deleted = true; return { deletedCount: 1 }; }
    return { deletedCount: 0 };
  }) as never);
  context.mock.method(models.NotificationModel, 'find', (filter: Record<string, any>) => query(() => db.notifications.filter((item) => item.recipientRole === filter.recipientRole && String(item.recipientId) === String(filter.recipientId))) as never);
  context.mock.method(models.NotificationModel, 'countDocuments', async (filter: Record<string, any>) => db.notifications.filter((item) => item.recipientRole === filter.recipientRole && String(item.recipientId) === String(filter.recipientId) && !item.readAt).length);
  context.mock.method(models.NotificationModel, 'updateOne', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    const item = db.notifications.find((notice) => String(notice._id) === String(filter._id) && notice.recipientRole === filter.recipientRole && String(notice.recipientId) === String(filter.recipientId));
    if (item) item.readAt = update.$set.readAt;
    return { matchedCount: item ? 1 : 0 };
  }) as never);

  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  return {
    db,
    call: (path: string, role: 'buyer' | 'farmer', body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch('http://127.0.0.1:' + address.port + path, {
      method, headers: { Authorization: 'Bearer ' + (role === 'buyer' ? buyerToken : farmerToken), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

function query<T>(read: () => T) {
  const chain = {
    select() { return this; }, session() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean() { return this; },
    exec: async () => read(),
  };
  return chain;
}

test('buyer request validates positive quantity, stores pending request and notifies its farmer without reserving stock', async (context) => {
  const { call, db } = await server(context);
  const invalid = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 0, callConsent: true });
  assert.equal(invalid.status, 400);
  const tooMuch = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 6, callConsent: true });
  assert.equal(tooMuch.status, 409);
  const requestBody = { requestedQuantity: 2.5, callConsent: true, requestKey: '291ca65b-1db8-45a3-9452-560c798946d9' };
  const response = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', requestBody);
  assert.equal(response.status, 201);
  assert.equal(db.listing.quantity, 5);
  assert.equal(db.requests[0]!.status, 'pending');
  assert.equal(db.requests[0]!.buyerId.toString(), buyerId.toString());
  assert.equal(db.notifications[0]!.recipientRole, 'farmer');
  const retry = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', requestBody);
  assert.equal(retry.status, 200);
  assert.equal(db.requests.length, 1);
  assert.equal(db.notifications.length, 1);
});

test('active farmer and vegetable requests block another listing request, but rejection permits a new request', async (context) => {
  const { call, db } = await server(context);
  const first = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true, requestKey: '391ca65b-1db8-45a3-9452-560c798946d9' });
  assert.equal(first.status, 201);
  const duplicateListingId = new Types.ObjectId();
  db.extraListings.add(String(duplicateListingId));
  const second = await call('/api/consumer/produce/' + duplicateListingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true, requestKey: '491ca65b-1db8-45a3-9452-560c798946d9' });
  assert.equal(second.status, 409);
  assert.equal((await second.json() as { error: string }).error, 'produce_request_already_active');
  const otherFarmerListingId = new Types.ObjectId();
  const otherFarmerId = new Types.ObjectId();
  db.extraListings.add(String(otherFarmerListingId));
  db.extraListingFarmers.set(String(otherFarmerListingId), otherFarmerId);
  const otherFarmer = await call('/api/consumer/produce/' + otherFarmerListingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true, requestKey: '691ca65b-1db8-45a3-9452-560c798946d9' });
  assert.equal(otherFarmer.status, 201);
  const requestId = String(db.requests[0]!._id);
  assert.equal((await call('/api/farmer/requests/' + requestId + '/decision', 'farmer', { decision: 'rejected' }, 'PATCH')).status, 200);
  const afterRejection = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true, requestKey: '591ca65b-1db8-45a3-9452-560c798946d9' });
  assert.equal(afterRejection.status, 201);
  assert.equal(db.requests.length, 3);
});

test('accept/reject decisions are owner-scoped, deduct once, and zero stock unpublishes the listing', async (context) => {
  const { call, db } = await server(context);
  db.requests.push(
    { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 5, unit: 'kg', status: 'pending' },
    { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 1, unit: 'kg', status: 'pending' },
  );
  const acceptedId = String(db.requests[0]!._id);
  const accepted = await call('/api/farmer/requests/' + acceptedId + '/decision', 'farmer', { decision: 'accepted' }, 'PATCH');
  assert.equal(accepted.status, 200);
  assert.equal(db.listing.quantity, 0);
  assert.equal(db.listing.status, 'priced_unpublished');
  assert.equal(db.requests[0]!.status, 'accepted');
  const repeat = await call('/api/farmer/requests/' + acceptedId + '/decision', 'farmer', { decision: 'accepted' }, 'PATCH');
  assert.equal(repeat.status, 409);
  assert.equal(db.listing.quantity, 0);
  assert.equal(db.notifications.some((item) => item.recipientRole === 'consumer'), true);
  const rejected = await call('/api/farmer/requests/' + String(db.requests[1]!._id) + '/decision', 'farmer', { decision: 'rejected' }, 'PATCH');
  assert.equal(rejected.status, 409);
  assert.equal(db.listing.quantity, 0);
  assert.equal(db.requests[1]!.status, 'cancelled');
});

test('acceptance does not call automatically; farmer starts an in-app room while request stays accepted', async (context) => {
  const { call, db } = await server(context);
  const request = { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 1, unit: 'kg', status: 'pending' };
  db.requests.push(request);
  const requestId = String(request._id);

  const accepted = await call('/api/farmer/requests/' + requestId + '/decision', 'farmer', { decision: 'accepted' }, 'PATCH');
  assert.equal(accepted.status, 200);
  assert.equal(request.status, 'accepted');
  assert.equal(db.callAttempts.length, 0);

  assert.equal((await call('/api/farmer/requests/' + requestId + '/call', 'buyer', undefined, 'POST')).status, 401);
  const started = await call('/api/farmer/requests/' + requestId + '/call', 'farmer', undefined, 'POST');
  assert.equal(started.status, 200);
  assert.equal((await started.json() as { status: string }).status, 'ringing');
  assert.equal(request.status, 'accepted');
  assert.equal(db.callAttempts.length, 0);
  assert.equal(db.inAppCalls.length, 1);

  const duplicate = await call('/api/farmer/requests/' + requestId + '/call', 'farmer', undefined, 'POST');
  assert.equal(duplicate.status, 200);
  assert.equal(db.callAttempts.length, 0);
  const retry = await call('/api/farmer/requests/' + requestId + '/call/retry', 'farmer', undefined, 'POST');
  assert.equal(retry.status, 200);
  assert.equal(request.status, 'accepted');
  assert.equal(db.callAttempts.length, 0);
  assert.equal(db.inAppCalls.length, 1);
});

test('concurrent acceptances do not oversell and buyer request responses never expose farmer phone numbers', async (context) => {
  const { call, db } = await server(context);
  db.requests.push(
    { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', listingPricePerUnit: 20, listingPriceUnit: 'kg', requestedQuantity: 4, unit: 'kg', status: 'pending' },
    { _id: new Types.ObjectId(), buyerId: new Types.ObjectId(), listingId, farmerId, listingName: 'Tomato', listingPricePerUnit: 20, listingPriceUnit: 'kg', requestedQuantity: 4, unit: 'kg', status: 'pending' },
  );
  const [a, b] = db.requests;
  const decisions = await Promise.all([a, b].map((item) => call('/api/farmer/requests/' + String(item!._id) + '/decision', 'farmer', { decision: 'accepted' }, 'PATCH')));
  assert.equal(decisions.filter((result) => result.status === 200).length, 1);
  assert.equal(db.listing.quantity, 1);
  assert.equal(db.requests.filter((item) => item.status === 'accepted').length, 1);
  const stillPending = db.requests.find((item) => item.status === 'pending')!;
  const rejected = await call('/api/farmer/requests/' + String(stillPending._id) + '/decision', 'farmer', { decision: 'rejected' }, 'PATCH');
  assert.equal(rejected.status, 200);
  assert.equal(stillPending.status, 'rejected');
  assert.equal(db.listing.quantity, 1);
  const buyerRequests = await call('/api/consumer/requests', 'buyer');
  const buyerBody = await buyerRequests.json() as { items: Array<Record<string, unknown>> };
  assert.equal(buyerBody.items.some((item) => 'farmerContact' in item || 'phone' in item), false);
  const buyerNotices = await call('/api/consumer/notifications', 'buyer');
  assert.equal((await buyerNotices.text()).includes(farmer.phone), false);
  const farmerNotices = await call('/api/farmer/notifications', 'farmer');
  assert.equal((await farmerNotices.text()).includes('9876543210'), false);
  assert.equal(buyerBody.items.some((item) => JSON.stringify(item).includes('Private address')), false);
  assert.equal((await call('/api/consumer/requests', 'farmer')).status, 401);
  assert.equal((await call('/api/farmer/requests', 'buyer')).status, 401);
});

test('notification read state and role isolation are enforced', async (context) => {
  const { call, db } = await server(context);
  const requestId = new Types.ObjectId();
  db.requests.push({ _id: requestId, buyerId, listingId, farmerId, listingName: 'Tomato', listingPricePerUnit: 20, listingPriceUnit: 'kg', requestedQuantity: 1, unit: 'kg', status: 'pending' });
  db.notifications.push({ _id: new Types.ObjectId(), recipientRole: 'consumer', recipientId: buyerId, requestId, event: 'request_decided', readAt: null });
  db.notifications.push({ _id: new Types.ObjectId(), recipientRole: 'farmer', recipientId: farmerId, requestId, event: 'request_created', readAt: null });
  const noticeId = String(db.notifications[0]!._id);
  const notifications = await call('/api/consumer/notifications', 'buyer');
  assert.equal((await notifications.json() as { unreadCount: number }).unreadCount, 1);
  assert.equal((await call('/api/consumer/notifications/' + String(db.notifications[1]!._id) + '/read', 'buyer', {}, 'PATCH')).status, 404);
  assert.equal((await call('/api/consumer/notifications/' + noticeId + '/read', 'buyer', {}, 'PATCH')).status, 200);
  assert.ok(db.notifications[0]!.readAt);
});

test('farmers see and decide only requests belonging to their own listings', async (context) => {
  const { call, db } = await server(context);
  const owned = { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 1, unit: 'kg', status: 'pending' };
  const otherFarmerId = new Types.ObjectId();
  const other = { _id: new Types.ObjectId(), buyerId, listingId, farmerId: otherFarmerId, listingName: 'Potato', requestedQuantity: 2, unit: 'kg', status: 'pending' };
  db.requests.push(owned, other);
  const response = await call('/api/farmer/requests', 'farmer');
  const body = await response.json() as { items: Array<{ id: string; listingName: string }> };
  assert.deepEqual(body.items.map((item) => item.id), [String(owned._id)]);
  const wrongOwnerDecision = await call('/api/farmer/requests/' + String(other._id) + '/decision', 'farmer', { decision: 'accepted' }, 'PATCH');
  assert.equal(wrongOwnerDecision.status, 404);
  assert.equal(db.listing.quantity, 5);
});

test('zero-stock and unpublished listings reject new requests', async (context) => {
  const { call, db } = await server(context);
  db.listing.quantity = 0;
  assert.equal((await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true })).status, 409);
  db.listing.quantity = 2;
  db.listing.status = 'priced_unpublished';
  assert.equal((await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true })).status, 409);
});

test('insufficient stock rejects acceptance without changing stock and unavailable listings cancel pending requests', async (context) => {
  const { call, db } = await server(context);
  const tooLarge = { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 8, unit: 'kg', status: 'pending' };
  db.requests.push(tooLarge);
  const unavailable = await call('/api/farmer/requests/' + String(tooLarge._id) + '/decision', 'farmer', { decision: 'accepted' }, 'PATCH');
  assert.equal(unavailable.status, 409);
  assert.equal(db.listing.quantity, 5);
  assert.equal(tooLarge.status, 'pending');

  const pending = { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 1, unit: 'kg', status: 'pending' };
  db.requests.push(pending);
  const unpublished = await call('/api/farmer/produce/' + listingId + '/publication', 'farmer', { published: false }, 'PATCH');
  assert.equal(unpublished.status, 200);
  assert.equal(pending.status, 'cancelled');
  assert.equal(db.notifications.some((item) => item.recipientRole === 'consumer' && item.event === 'request_cancelled'), true);
  assert.equal((await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1, callConsent: true })).status, 409);

  db.listing.status = 'published';
  const awaitingDeletion = { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 1, unit: 'kg', status: 'pending' };
  db.requests.push(awaitingDeletion);
  const deleted = await call('/api/farmer/produce/' + listingId, 'farmer', undefined, 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal(awaitingDeletion.status, 'cancelled');
  assert.equal(db.listing.deleted, true);
});
