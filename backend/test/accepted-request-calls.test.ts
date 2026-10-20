import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 'accepted-request-calls-test-secret'.padEnd(64, 'x');
process.env.EXOTEL_ACCOUNT_SID = 'test-account';
process.env.EXOTEL_API_KEY = 'test-key';
process.env.EXOTEL_API_TOKEN = 'test-token';
process.env.EXOTEL_CALLER_ID = '+911234567890';
process.env.EXOTEL_REGION = 'mumbai';
process.env.EXOTEL_STATUS_CALLBACK_URL = 'https://calls.example.test';
process.env.AADHAAR_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

const [models, { hmac, encryptSecretValue }, { applyExotelCallStatus, retryAcceptedRequestCall, initiateAcceptedRequestCall }] = await Promise.all([
  import('../src/models/index.js'), import('../src/crypto.js'), import('../src/services/accepted-request-calls.js'),
]);

function query<T>(read: () => T) {
  const chain = {
    select() { return this; }, lean() { return this; }, sort() { return this; },
    exec: async () => read(),
  };
  return chain;
}

test('call failure callback changes only call status and duplicate callbacks notify once', async (context: TestContext) => {
  const attemptId = new Types.ObjectId();
  const requestId = new Types.ObjectId();
  const buyerId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  const callbackToken = 'mock-callback-token';
  const request = { _id: requestId, buyerId, farmerId, status: 'accepted' };
  const attempt = { _id: attemptId, requestId, status: 'queued', providerReference: undefined as string | undefined, callbackTokenHash: hmac(callbackToken) };
  const notices: Array<Record<string, unknown>> = [];

  context.mock.method(models.CallAttemptModel, 'findOne', (filter: Record<string, unknown>) => query(() => filter.callbackTokenHash === attempt.callbackTokenHash ? { ...attempt } : null) as never);
  context.mock.method(models.CallAttemptModel, 'updateOne', (filter: Record<string, unknown>, update: Record<string, unknown>) => query(() => {
    const statusFilter = filter.status as { $in: string[] };
    const acceptedStatuses = statusFilter.$in;
    if (!acceptedStatuses.includes(attempt.status)) return { modifiedCount: 0 };
    const updateSet = update.$set as Record<string, unknown>;
    if (filter.$or && attempt.providerReference && attempt.providerReference !== updateSet.providerReference) return { modifiedCount: 0 };
    Object.assign(attempt, updateSet);
    return { modifiedCount: 1 };
  }) as never);
  context.mock.method(models.ProduceRequestModel, 'findById', () => query(() => request) as never);
  context.mock.method(models.ConsumerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.FarmerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.NotificationModel, 'create', async (items: Array<Record<string, unknown>>) => {
    notices.push(...items);
    return items.map((item) => ({ ...item, _id: new Types.ObjectId() })) as never;
  });
  context.mock.method(models.PushTokenModel, 'find', () => query(() => []) as never);

  const callback = { token: callbackToken, callSid: 'mock-call-sid', status: 'no-answer', customField: String(attemptId) };
  assert.equal(await applyExotelCallStatus({ ...callback, token: 'invalid-token' }), false);
  assert.equal(await applyExotelCallStatus({ ...callback, customField: 'another-attempt' }), false);
  assert.equal(await applyExotelCallStatus(callback), true);
  assert.equal(await applyExotelCallStatus(callback), true);
  assert.equal(attempt.status, 'failed');
  assert.equal(request.status, 'accepted');
  assert.equal(notices.filter((notice) => notice.recipientRole === 'consumer' && notice.event === 'call_failed').length, 1);
  assert.equal(notices.filter((notice) => notice.recipientRole === 'farmer' && notice.event === 'call_failed').length, 1);
});

test('answered then completed callbacks advance only the call attempt and are idempotent', async (context: TestContext) => {
  const attemptId = new Types.ObjectId();
  const requestId = new Types.ObjectId();
  const buyerId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  const callbackToken = 'mock-answered-token';
  const request = { _id: requestId, buyerId, farmerId, status: 'accepted' };
  const attempt = { _id: attemptId, requestId, status: 'queued', providerReference: undefined as string | undefined, callbackTokenHash: hmac(callbackToken) };
  const notices: Array<Record<string, unknown>> = [];

  context.mock.method(models.CallAttemptModel, 'findOne', (filter: Record<string, unknown>) => query(() => filter.callbackTokenHash === attempt.callbackTokenHash ? { ...attempt } : null) as never);
  context.mock.method(models.CallAttemptModel, 'updateOne', (filter: Record<string, unknown>, update: Record<string, unknown>) => query(() => {
    const statusFilter = filter.status as { $in: string[] };
    if (!statusFilter.$in.includes(attempt.status)) return { modifiedCount: 0 };
    Object.assign(attempt, update.$set as Record<string, unknown>);
    return { modifiedCount: 1 };
  }) as never);
  context.mock.method(models.ProduceRequestModel, 'findById', () => query(() => request) as never);
  context.mock.method(models.ConsumerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.FarmerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.NotificationModel, 'create', async (items: Array<Record<string, unknown>>) => {
    notices.push(...items);
    return items.map((item) => ({ ...item, _id: new Types.ObjectId() })) as never;
  });
  context.mock.method(models.PushTokenModel, 'find', () => query(() => []) as never);

  const callback = { token: callbackToken, callSid: 'mock-call-sid', customField: String(attemptId) };
  assert.equal(await applyExotelCallStatus({ ...callback, status: 'in-progress', eventType: 'answered' }), true);
  assert.equal(await applyExotelCallStatus({ ...callback, status: 'in-progress', eventType: 'answered' }), true);
  assert.equal(attempt.status, 'initiated');
  assert.equal(await applyExotelCallStatus({ ...callback, status: 'completed' }), true);
  assert.equal(await applyExotelCallStatus({ ...callback, status: 'completed' }), true);
  assert.equal(attempt.status, 'completed');
  assert.equal(request.status, 'accepted');
  assert.equal(notices.filter((notice) => notice.event === 'call_initiated').length, 2);
  assert.equal(notices.filter((notice) => notice.event === 'call_completed').length, 2);
});

test('retry does not create another attempt while the latest call is still active', async (context: TestContext) => {
  const requestId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  context.mock.method(models.ProduceRequestModel, 'findOne', () => query(() => ({ _id: requestId })) as never);
  context.mock.method(models.CallAttemptModel, 'findOne', () => query(() => ({ status: 'initiated', providerReference: 'mock-call-sid' })) as never);
  const result = await retryAcceptedRequestCall(requestId, farmerId);
  assert.deepEqual(result, { conflict: true, status: 'initiated', confirmed: true, failureCode: null });
});

test('provider rejection fails only the call attempt and leaves the accepted request available for retry', async (context: TestContext) => {
  const requestId = new Types.ObjectId();
  const buyerId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  const attemptId = new Types.ObjectId();
  const request = { _id: requestId, buyerId, farmerId, status: 'accepted' };
  const attempt = { _id: attemptId, status: 'queued', requestId } as Record<string, unknown>;
  const notices: Array<Record<string, unknown>> = [];
  let findOneCall = 0;

  context.mock.method(models.ProduceRequestModel, 'findOne', () => query(() => request) as never);
  context.mock.method(models.CallAttemptModel, 'findOne', () => query(() => findOneCall++ === 0 ? null : null) as never);
  context.mock.method(models.CallAttemptModel, 'create', async () => [attempt] as never);
  context.mock.method(models.CallAttemptModel, 'updateOne', (_filter: Record<string, unknown>, update: Record<string, unknown>) => query(() => {
    Object.assign(attempt, update.$set as Record<string, unknown>);
    return { modifiedCount: 1 };
  }) as never);
  context.mock.method(models.ConsumerModel, 'findOne', () => query(() => ({ _id: buyerId, accountStatus: 'active', phoneCiphertext: encryptSecretValue('9901416675') })) as never);
  context.mock.method(models.FarmerModel, 'findOne', () => query(() => ({ _id: farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified', phone: '8031828000' })) as never);
  context.mock.method(models.ConsumerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.FarmerModel, 'findById', () => query(() => ({ preferredLanguage: 'en' })) as never);
  context.mock.method(models.NotificationModel, 'create', async (items: Array<Record<string, unknown>>) => {
    notices.push(...items);
    return items.map((item) => ({ ...item, _id: new Types.ObjectId() })) as never;
  });
  context.mock.method(models.PushTokenModel, 'find', () => query(() => []) as never);
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ RestException: { Code: 'BAD_CALLER_ID', Message: 'Invalid caller id' } }), { status: 400, headers: { 'content-type': 'application/json' } }));

  const result = await initiateAcceptedRequestCall(requestId, farmerId);
  assert.equal(result?.status, 'failed');
  assert.equal(result?.failureCode, 'provider_request_invalid');
  assert.equal(attempt.status, 'failed');
  assert.equal(request.status, 'accepted');
  assert.equal(notices.length, 2);
});
