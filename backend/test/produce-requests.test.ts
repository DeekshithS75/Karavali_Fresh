/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import mongoose, { Types } from 'mongoose';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'request-workflow-test-token-secret'.padEnd(64, 'x');

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
    select() { return this; }, exec: async () => ({ _id: buyerId, fullName: 'Buyer', accountStatus: 'active' }),
  }) as never);
  context.mock.method(models.ConsumerModel, 'find', () => ({ select() { return this; }, lean() { return this; }, exec: async () => [{ _id: buyerId, fullName: 'Buyer' }] }) as never);
  context.mock.method(models.SessionModel, 'findOne', async (query: { tokenHash: string }) => query.tokenHash === hmac(farmerToken)
    ? { farmerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } : null);
  context.mock.method(models.FarmerModel, 'findById', () => ({
    ...farmer, select() { return this; }, lean() { return this; }, exec: async () => farmer,
  }) as never);

  const db = {
    listing: { _id: listingId, farmerId, name: 'Tomato', unit: 'kg', quantity: 5, requestVersion: 0, status: 'published', pricePerUnit: 20, priceUnit: 'kg', photos: [] as Array<Record<string, unknown>>, deleted: false },
    requests: [] as Array<Record<string, any>>,
    notifications: [] as Array<Record<string, any>>,
  };

  context.mock.method(models.ProduceModel, 'findOne', (filter: Record<string, any>) => query(() => {
    if (filter.status === 'published') return !db.listing.deleted && db.listing.status === 'published' && db.listing.quantity > 0 ? db.listing : null;
    return !db.listing.deleted && String(filter._id) === String(listingId) && String(filter.farmerId) === String(farmerId) ? db.listing : null;
  }) as never);
  context.mock.method(models.ProduceModel, 'findOneAndUpdate', (filter: Record<string, any>, update: Record<string, any>) => query(() => {
    if (update.$inc?.requestVersion) {
      if (db.listing.deleted || db.listing.status !== 'published' || db.listing.quantity <= 0) return null;
      db.listing.requestVersion += update.$inc.requestVersion;
      return db.listing;
    }
    if (update.$set?.status) {
      db.listing.status = update.$set.status;
      return { status: db.listing.status };
    }
    if (String(filter._id) !== String(listingId) || String(filter.farmerId) !== String(farmerId) || db.listing.status !== 'published' || db.listing.quantity < filter.quantity.$gte) return null;
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
      : String(item._id) === String(filter._id) && String(item.farmerId) === String(filter.farmerId)) ?? null,
  ) as never);
  context.mock.method(models.ProduceRequestModel, 'find', (filter: Record<string, any>) => query(() => db.requests.filter((item) =>
    filter.buyerId ? String(item.buyerId) === String(filter.buyerId) :
      filter.farmerId ? String(item.farmerId) === String(filter.farmerId) && (!filter.status || item.status === filter.status) :
        filter._id?.$in ? filter._id.$in.some((id: Types.ObjectId) => String(id) === String(item._id)) : false,
  )) as never);
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
  const invalid = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 0 });
  assert.equal(invalid.status, 400);
  const tooMuch = await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 6 });
  assert.equal(tooMuch.status, 409);
  const requestBody = { requestedQuantity: 2.5, requestKey: '291ca65b-1db8-45a3-9452-560c798946d9' };
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

test('concurrent acceptances do not oversell and buyer receives farmer contact only after acceptance', async (context) => {
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
  const buyerBody = await buyerRequests.json() as { items: Array<{ farmerContact?: { phone: string }; status: string }> };
  assert.equal(buyerBody.items.some((item) => item.status === 'pending' && item.farmerContact), false);
  assert.equal(buyerBody.items.some((item) => item.status === 'accepted' && item.farmerContact?.phone === farmer.phone), true);
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
  assert.equal((await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1 })).status, 409);
  db.listing.quantity = 2;
  db.listing.status = 'priced_unpublished';
  assert.equal((await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1 })).status, 409);
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
  assert.equal((await call('/api/consumer/produce/' + listingId + '/requests', 'buyer', { requestedQuantity: 1 })).status, 409);

  db.listing.status = 'published';
  const awaitingDeletion = { _id: new Types.ObjectId(), buyerId, listingId, farmerId, listingName: 'Tomato', requestedQuantity: 1, unit: 'kg', status: 'pending' };
  db.requests.push(awaitingDeletion);
  const deleted = await call('/api/farmer/produce/' + listingId, 'farmer', undefined, 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal(awaitingDeletion.status, 'cancelled');
  assert.equal(db.listing.deleted, true);
});
