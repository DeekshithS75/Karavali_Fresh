import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreFarmerSession, revokeFarmerSession, routeForFarmerAccount, routeForFarmerSession } from '../src/features/farmer-auth/session-lifecycle.ts';
import { createFarmerSessionStorage, FARMER_SESSION_KEY } from '../src/features/farmer-auth/session-storage.ts';

function persistentStorage() {
  const values = new Map();
  return {
    values,
    adapter: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    },
  };
}

for (const platform of ['web browser refresh', 'native app restart']) {
  test(`successful login persists the server token across ${platform}`, async () => {
    const persistent = persistentStorage();
    await createFarmerSessionStorage(persistent.adapter).save({ accessToken: 'server-token' });
    assert.equal(persistent.values.has(FARMER_SESSION_KEY), true);
    const afterRestart = createFarmerSessionStorage(persistent.adapter);
    const validated = await restoreFarmerSession(afterRestart.read, async (token) => token === 'server-token', afterRestart.clear, () => false);
    assert.equal(validated, 'valid');
    assert.equal(routeForFarmerSession(validated), 'dashboard');
  });
}

test('web and native storage are isolated platform stores, not shared Chrome/Expo Go credentials', async () => {
  const browser = persistentStorage();
  const expoGo = persistentStorage();
  await createFarmerSessionStorage(browser.adapter).save({ accessToken: 'browser-token' });
  assert.equal(await createFarmerSessionStorage(expoGo.adapter).read(), null);
  assert.equal((await createFarmerSessionStorage(browser.adapter).read())?.accessToken, 'browser-token');
});

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

for (const status of ['expired', 'revoked']) {
  test(`an authoritatively ${status} server session clears local credentials and requests authentication`, async () => {
    let clears = 0;
    const result = await restoreFarmerSession(
      async () => ({ accessToken: `${status}-token` }),
      async () => { throw new Error('unauthorized'); },
      async () => { clears += 1; },
      (error) => error instanceof Error && error.message === 'unauthorized',
    );
    assert.equal(result, 'invalid');
    assert.equal(clears, 1);
    assert.equal(routeForFarmerSession(result), 'authentication');
  });
}

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
