import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import mongoose from 'mongoose';

process.env.NACALLER_KEY = '';
process.env.PHONE_HASH_SECRET = '';

const { default: app } = await import('../src/app.js');
const setConnectionReadyState = (readyState: number) => {
  (mongoose.connection as unknown as { readyState: number }).readyState = readyState;
};

test('health endpoint reports unavailable until MongoDB is connected', async (context) => {
  const server = createServer(app);
  const previousReadyState = mongoose.connection.readyState;
  setConnectionReadyState(0);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    setConnectionReadyState(previousReadyState);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const unavailable = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: 'unavailable' });

  setConnectionReadyState(1);
  const healthy = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { status: 'ok' });
});

test('missed-call endpoint reports the missing provider and cannot grant a challenge', async (context) => {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/farmer/auth/phone-verification`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+919876543210', phoneVerificationConsent: 'true' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'phone_verification_provider_not_configured' });
});
