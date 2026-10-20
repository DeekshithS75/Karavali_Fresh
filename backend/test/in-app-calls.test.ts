import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 'in-app-calls-test-secret'.padEnd(64, 'x');
process.env.LIVEKIT_URL = 'wss://karavali-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'test-livekit-key';
process.env.LIVEKIT_API_SECRET = 'test-livekit-secret-that-is-never-returned-to-clients';

const [models, { startAcceptedInAppCall, joinInAppCall }] = await Promise.all([
  import('../src/models/index.js'), import('../src/services/in-app-calls.js'),
]);

function query<T>(read: () => T) {
  const chain = { select() { return this; }, lean() { return this; }, sort() { return this; }, exec: async () => read() };
  return chain;
}

test('accepted request starts one private room and repeat taps reuse its active session', async (context: TestContext) => {
  const requestId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  const buyerId = new Types.ObjectId();
  const sessionId = new Types.ObjectId();
  const request = { _id: requestId, farmerId, buyerId, status: 'accepted' };
  const session = { _id: sessionId, requestId, roomName: 'kf-private-room', callerFarmerId: farmerId, buyerId, status: 'ringing', expiresAt: new Date(Date.now() + 60_000) };
  let creates = 0;
  let lookups = 0;
  context.mock.method(models.ProduceRequestModel, 'findOne', () => query(() => request) as never);
  context.mock.method(models.InAppCallModel, 'findOne', () => query(() => lookups++ === 0 ? null : ({ _id: sessionId, status: 'ringing', expiresAt: session.expiresAt })) as never);
  context.mock.method(models.InAppCallModel, 'create', async () => { creates++; return [session] as never; });
  context.mock.method(models.PushTokenModel, 'find', () => query(() => []) as never);

  const first = await startAcceptedInAppCall(requestId, farmerId);
  const repeated = await startAcceptedInAppCall(requestId, farmerId);
  assert.deepEqual(first, { sessionId: String(sessionId), status: 'ringing' });
  assert.deepEqual(repeated, first);
  assert.equal(creates, 1);
});

test('only the accepted request participants can receive a short-lived token scoped to its call room', async (context: TestContext) => {
  const requestId = new Types.ObjectId();
  const farmerId = new Types.ObjectId();
  const buyerId = new Types.ObjectId();
  const sessionId = new Types.ObjectId();
  const session = { _id: sessionId, requestId, roomName: 'kf-private-room', callerFarmerId: farmerId, buyerId, status: 'ringing', expiresAt: new Date(Date.now() + 60_000), farmerJoinedAt: new Date() };
  context.mock.method(models.InAppCallModel, 'findOne', (filter: Record<string, unknown>) => query(() => {
    const allowed = filter.callerFarmerId === farmerId || filter.buyerId === buyerId;
    return allowed ? session : null;
  }) as never);
  context.mock.method(models.InAppCallModel, 'updateOne', () => query(() => ({ modifiedCount: 1 })) as never);
  context.mock.method(models.InAppCallModel, 'findById', () => query(() => session) as never);
  context.mock.method(models.ProduceRequestModel, 'findOne', () => query(() => ({ _id: requestId })) as never);

  const joined = await joinInAppCall(sessionId, 'consumer', buyerId);
  assert.equal(joined.serverUrl, 'wss://karavali-test.livekit.cloud');
  const claims = JSON.parse(Buffer.from(joined.participantToken.split('.')[1]!, 'base64url').toString()) as { sub: string; video: { room: string; roomJoin: boolean; canPublish: boolean; canSubscribe: boolean } };
  assert.equal(claims.sub, `consumer-${String(buyerId)}`);
  assert.deepEqual(claims.video, { room: 'kf-private-room', roomJoin: true, canPublish: true, canSubscribe: true });
});

test('unrelated accounts cannot join a private call room', async (context: TestContext) => {
  context.mock.method(models.InAppCallModel, 'findOne', () => query(() => null) as never);
  await assert.rejects(joinInAppCall(new Types.ObjectId(), 'consumer', new Types.ObjectId()), /in_app_call_not_found/);
});
