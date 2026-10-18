import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.NACALLER_KEY = '';
process.env.PHONE_HASH_SECRET = '';

const { default: app } = await import('../src/app.js');

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
