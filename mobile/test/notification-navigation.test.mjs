import assert from 'node:assert/strict';
import test from 'node:test';
import { routeForNotificationData } from '../src/features/notification-navigation.ts';

test('farmer request push opens its highlighted Notifications record', () => {
  assert.equal(routeForNotificationData({ url: '/farmer/notifications?notificationId=notice-1&requestId=request-1' }), '/farmer/notifications?notificationId=notice-1&requestId=request-1');
});

test('buyer status push opens the relevant request in the Requests area', () => {
  assert.equal(routeForNotificationData({ url: '/consumer?section=requests&requestId=request-2' }), '/consumer?section=requests&requestId=request-2');
});

test('unknown, malformed and external notification targets are ignored', () => {
  for (const data of [null, {}, { url: 'https://example.com' }, { url: '/auth/farmer/login' }, { url: 22 }]) {
    assert.equal(routeForNotificationData(data), null);
  }
});
