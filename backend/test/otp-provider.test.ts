import assert from 'node:assert/strict';
import test from 'node:test';
import { NaCallerError, NaCallerMissOtpProvider } from '../src/providers/otp.js';

const phone = '9876543210';
const expiry = new Date(Date.now() + 120_000).toISOString();

test('NaCaller start uses the documented URL, bearer key and unique reference', async () => {
  let request: { url: URL; init?: RequestInit } | undefined;
  const provider = new NaCallerMissOtpProvider('secret-key', async (input, init) => {
    request = { url: new URL(String(input)), init };
    return Response.json({ requestId: 'request-123', phone, callNumber: '+911234567890', instruction: 'Call this number', status: 'pending', expiresAt: expiry });
  });
  const result = await provider.start(`+91${phone}`, 'challenge-reference');
  assert.equal(request?.url.href, 'https://api.nacaller.com/api/verify/start');
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer secret-key');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { phone: `+91${phone}`, reference: 'challenge-reference' });
  assert.equal(result.callNumber, '+911234567890');
  assert.equal(result.status, 'pending');
});

test('NaCaller status reads only the provider request endpoint and returns pending then verified states', async () => {
  let status: 'pending' | 'verified' = 'pending';
  const provider = new NaCallerMissOtpProvider('secret-key', async (input) => {
    assert.equal(String(input), 'https://api.nacaller.com/api/verify/status/request-123');
    return Response.json({ requestId: 'request-123', phone, reference: 'challenge-reference', status, verified: status === 'verified', expiresAt: expiry });
  });
  assert.equal((await provider.status('request-123')).status, 'pending');
  status = 'verified';
  assert.equal((await provider.status('request-123')).status, 'verified');
});

test('NaCaller returns expired state and fails closed on provider credits and invalid phone', async () => {
  const expired = new NaCallerMissOtpProvider('secret-key', async () => Response.json({ requestId: 'request-123', phone, reference: 'challenge-reference', status: 'expired', verified: false, expiresAt: expiry }));
  assert.equal((await expired.status('request-123')).status, 'expired');
  const returnedPhone = new NaCallerMissOtpProvider('secret-key', async () => Response.json({ requestId: 'request-123', phone: '9876543211', reference: 'challenge-reference', status: 'pending', verified: false, expiresAt: expiry }));
  assert.equal((await returnedPhone.status('request-123')).phone, '9876543211');
  const credits = new NaCallerMissOtpProvider('secret-key', async () => Response.json({ error: 'credits' }, { status: 402 }));
  await assert.rejects(credits.start(`+91${phone}`, 'ref'), (error) => error instanceof NaCallerError && error.code === 'credits_exhausted');
  const invalidPhone = new NaCallerMissOtpProvider('secret-key', async () => Response.json({}));
  await assert.rejects(invalidPhone.start('+911234', 'ref'), (error) => error instanceof NaCallerError && error.code === 'invalid_phone');
});
