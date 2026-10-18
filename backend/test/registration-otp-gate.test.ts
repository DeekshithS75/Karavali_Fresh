import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 't'.repeat(64);
process.env.PHONE_HASH_SECRET = 'o'.repeat(64);
process.env.NACALLER_KEY = 'mock-nacaller-key';

const [{ default: app }, { PendingRegistrationModel }] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'),
]);

test('registration missed-call verification is blocked unless OCR comparison and explicit consent have passed', async (context) => {
  context.mock.method(PendingRegistrationModel, 'findById', async () => ({
    status: 'document_verified', documentComparisonStatus: 'failed', phoneVerificationConsentedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  }) as never);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/farmer/registrations/507f1f77bcf86cd799439011/phone-verification`, { method: 'POST' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'document_comparison_required' });
});
