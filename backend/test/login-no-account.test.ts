import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 't'.repeat(64);
process.env.PHONE_HASH_SECRET = 'p'.repeat(64);
process.env.NACALLER_KEY = 'mock-nacaller-key';

const [{ default: app }, { FarmerModel, RateLimitModel }] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'),
]);

test('missed-call login for an unknown phone never creates a Farmer account', async (context) => {
  const collection = RateLimitModel.collection as unknown as { findOneAndUpdate: (...args: unknown[]) => Promise<unknown> };
  context.mock.method(collection, 'findOneAndUpdate', async () => ({ count: 1 }));
  context.mock.method(FarmerModel, 'findOne', async () => null as never);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/farmer/auth/phone-verification`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+919876543210', phoneVerificationConsent: 'true' }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'farmer_not_found' });
});
