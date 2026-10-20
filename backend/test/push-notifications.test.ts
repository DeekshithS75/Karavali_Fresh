import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

const [{ PushTokenModel }, { sendAccountPush }] = await Promise.all([
  import('../src/models/index.js'), import('../src/services/push-notifications.js'),
]);
const { notificationCopy } = await import('../src/services/notification-copy.js');

test('notification copy uses farmer English or Kannada preference and falls back to English for Tulu', () => {
  const english = notificationCopy('en', 'request_created', { buyerName: 'Ravi', vegetableName: 'Tomato', quantity: 5, unit: 'kg' });
  assert.match(english.body, /Ravi wants 5 kg of Tomato/);
  assert.match(english.body, /Accept or decline/);
  const kannada = notificationCopy('kn', 'request_created', { buyerName: 'ರವಿ', vegetableName: 'Tomato', quantity: 5, unit: 'kg' });
  assert.match(kannada.body, /ಟೊಮೇಟೊ/);
  assert.match(kannada.body, /5 ಕೆಜಿ/);
  assert.match(kannada.body, /ಒಪ್ಪಿಕೊಳ್ಳಿ ಅಥವಾ ನಿರಾಕರಿಸಿ/);
  const tuluFallback = notificationCopy('tcy', 'request_created', { buyerName: 'Ravi', vegetableName: 'Tomato', quantity: 5, unit: 'kg' });
  assert.match(tuluFallback.body, /Accept or decline/);
  assert.match(notificationCopy('kn', 'request_decided', { decision: 'accepted' }).body, /ಒಪ್ಪಿದ್ದಾರೆ/);
  assert.match(notificationCopy('en', 'request_decided', { decision: 'rejected' }).body, /farmer declined/);
  assert.match(notificationCopy('en', 'call_failed', { failureCode: 'provider_timeout' }).body, /still accepted/);
  assert.doesNotMatch(notificationCopy('en', 'call_failed', { failureCode: 'provider_timeout' }).body, /declined/i);
  assert.doesNotMatch(notificationCopy('en', 'request_decided', {}).body, /declined/i);
});

function tokenQuery(tokens: Array<{ _id: string; token: string }>) {
  return { select() { return this; }, lean() { return this; }, exec: async () => tokens };
}

test('push transport failures do not throw into the persisted notification workflow', async (context) => {
  context.mock.method(PushTokenModel, 'find', () => tokenQuery([{ _id: 'token-id', token: 'ExpoPushToken[valid]' }]) as never);
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('provider unavailable'); });
  await assert.doesNotReject(sendAccountPush('farmer', new mongoose.Types.ObjectId(), {
    title: 'Request', body: 'Open app to review.', url: '/farmer/notifications', notificationId: 'notice', requestId: 'request',
  }));
});

test('invalid Expo push tokens are disabled after the provider reports DeviceNotRegistered', async (context) => {
  let disabledIds: unknown[] = [];
  let pushedBody = '';
  context.mock.method(PushTokenModel, 'find', () => tokenQuery([{ _id: 'expired-token', token: 'ExpoPushToken[expired]' }]) as never);
  context.mock.method(PushTokenModel, 'updateMany', async (filter: { _id: { $in: unknown[] } }) => { disabledIds = filter._id.$in; return { modifiedCount: 1 }; });
  context.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    pushedBody = String(init?.body);
    return new Response(JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }), { status: 200 });
  });
  await sendAccountPush('consumer', new mongoose.Types.ObjectId(), {
    title: 'Request update', body: 'Open app to view it.', url: '/consumer?section=requests', notificationId: 'notice', requestId: 'request', categoryId: 'produceRequest',
  });
  assert.deepEqual(disabledIds, ['expired-token']);
  assert.match(pushedBody, /"channelId":"requests"/);
  assert.match(pushedBody, /"categoryId":"produceRequest"/);
});
