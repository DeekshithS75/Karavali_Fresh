import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.MSG91_AUTH_KEY = '';
process.env.MSG91_REGISTRATION_TEMPLATE_ID = '';
process.env.MSG91_LOGIN_TEMPLATE_ID = '';
process.env.OTP_HMAC_SECRET = '';

const { default: app } = await import('../src/app.js');

test('OTP endpoint reports the missing delivery provider and cannot grant a challenge', async (context) => {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/farmer/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9876543210' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'otp_provider_not_configured' });
});
