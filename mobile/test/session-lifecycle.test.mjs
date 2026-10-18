import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreFarmerSession, revokeFarmerSession, routeForFarmerAccount, routeForFarmerSession } from '../src/features/farmer-auth/session-lifecycle.ts';

test('a saved server token is restored after app restart and refresh without clearing it', async () => {
  let persisted = { accessToken: 'server-token' };
  let clears = 0;
  const read = async () => persisted;
  const validate = async (token) => token === 'server-token';
  const clear = async () => { clears += 1; persisted = null; };
  assert.equal(await restoreFarmerSession(read, validate, clear, () => false), 'valid');
  assert.equal(await restoreFarmerSession(read, validate, clear, () => false), 'valid');
  assert.equal(clears, 0);
  assert.equal(routeForFarmerSession('valid'), 'dashboard');
});

test('backend unavailability or missing API configuration preserves saved credentials and asks for retry', async () => {
  const token = { accessToken: 'server-token' };
  let clears = 0;
  for (const reason of [new Error('network'), new Error('apiUrlMissing')]) {
    const result = await restoreFarmerSession(async () => token, async () => { throw reason; }, async () => { clears += 1; }, () => false, (error) => error === reason && reason.message === 'apiUrlMissing');
    assert.equal(result, reason.message === 'apiUrlMissing' ? 'configuration-error' : 'unavailable');
    assert.equal(routeForFarmerSession(result), 'retry');
  }
  assert.equal(clears, 0);
});

test('only an authoritative invalid-session response clears a saved token', async () => {
  let clears = 0;
  const result = await restoreFarmerSession(
    async () => ({ accessToken: 'revoked-token' }),
    async () => { throw new Error('unauthorized'); },
    async () => { clears += 1; },
    (error) => error instanceof Error && error.message === 'unauthorized',
  );
  assert.equal(result, 'invalid');
  assert.equal(clears, 1);
  assert.equal(routeForFarmerSession(result), 'authentication');
});

test('explicit logout revokes remotely before clearing, and failed revocation preserves credentials', async () => {
  const order = [];
  const token = { accessToken: 'server-token' };
  await revokeFarmerSession(async () => token, async () => { order.push('revoke'); }, async () => { order.push('clear'); });
  assert.deepEqual(order, ['revoke', 'clear']);

  order.length = 0;
  await assert.rejects(revokeFarmerSession(async () => token, async () => { order.push('revoke'); throw new Error('network'); }, async () => { order.push('clear'); }));
  assert.deepEqual(order, ['revoke']);
});

test('new, returning and pending farmers take separate routes', () => {
  assert.equal(routeForFarmerAccount('registered'), 'login');
  assert.equal(routeForFarmerAccount('new'), 'register');
  assert.equal(routeForFarmerAccount('pending'), 'verification');
  assert.equal(routeForFarmerAccount('unknown'), 'error');
});
