import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

const [{ PushTokenModel }, { sendAccountPush }] = await Promise.all([
  import('../src/models/index.js'), import('../src/services/push-notifications.js'),
]);

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
    title: 'Request update', body: 'Open app to view it.', url: '/consumer?section=requests', notificationId: 'notice', requestId: 'request',
  });
  assert.deepEqual(disabledIds, ['expired-token']);
  assert.match(pushedBody, /"channelId":"requests"/);
});
