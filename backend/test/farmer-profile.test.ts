import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 'profile-test-token-secret-'.padEnd(64, 'x');

const [{ default: app }, { FarmerModel, SessionModel }] = await Promise.all([
  import('../src/app.js'), import('../src/models/index.js'),
]);
const { hmac } = await import('../src/crypto.js');

const ownFarmerId = 'farmer-owned-by-session';
const otherFarmerId = 'another-farmer-id';
const token = 'fictional-server-session-token-12345678901234567890';

async function withServer(context: TestContext, handler: typeof fetch = fetch) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return (path: string, authorization = `Bearer ${token}`) => handler(`http://127.0.0.1:${address.port}${path}`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

function mockProfileLookup(context: TestContext, profile: Record<string, unknown> | null) {
  context.mock.method(SessionModel, 'findOne', async (query: unknown) => {
    assert.equal((query as { tokenHash: string }).tokenHash, hmac(token));
    return { farmerId: ownFarmerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never;
  });
  context.mock.method(FarmerModel, 'findById', (id: unknown) => {
    assert.equal(String(id), ownFarmerId, 'profile lookup must use the Farmer ID from the server session');
    return {
      select(fields: string) {
        assert.equal(fields, 'fullName accountStatus phoneVerificationStatus documentComparisonStatus');
        return { lean: () => ({ exec: async () => profile }) };
      },
    } as never;
  });
}

test('a valid session retrieves only its own Farmer profile fields', async (context) => {
  mockProfileLookup(context, {
    fullName: 'Fictional Farmer', accountStatus: 'active', phoneVerificationStatus: 'verified',
    documentComparisonStatus: 'passed', phone: '+919000000001', aadhaarHash: 'must-not-leak',
  });
  const get = await withServer(context);
  const response = await get('/api/farmer/profile');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: { fullName: 'Fictional Farmer' } });
});

test('an unauthenticated profile request is rejected', async (context) => {
  const get = await withServer(context);
  const response = await get('/api/farmer/profile', '');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'authentication_required' });
});

test('a client supplied Farmer ID cannot change which profile the session retrieves', async (context) => {
  mockProfileLookup(context, {
    fullName: 'Fictional Farmer', accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed',
  });
  const get = await withServer(context);
  const response = await get(`/api/farmer/profile?farmerId=${otherFarmerId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: { fullName: 'Fictional Farmer' } });
});

test('a valid session whose Farmer record is missing receives a not found response', async (context) => {
  mockProfileLookup(context, null);
  const get = await withServer(context);
  const response = await get('/api/farmer/profile');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'farmer_not_found' });
});

test('profile response never contains Aadhaar numbers, fingerprints, or internal session fields', async (context) => {
  mockProfileLookup(context, {
    fullName: 'Fictional Farmer', accountStatus: 'active', phoneVerificationStatus: 'verified',
    documentComparisonStatus: 'passed', aadhaar: '000000000000', aadhaarHash: 'fictional-fingerprint',
    rawOcrText: 'fictional raw OCR content', tokenHash: 'fictional-session-hash',
  });
  const get = await withServer(context);
  const response = await get('/api/farmer/profile');
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(body), { profile: { fullName: 'Fictional Farmer' } });
  for (const sensitive of ['000000000000', 'fictional-fingerprint', 'fictional raw OCR content', 'fictional-session-hash']) {
    assert.equal(body.includes(sensitive), false);
  }
});
