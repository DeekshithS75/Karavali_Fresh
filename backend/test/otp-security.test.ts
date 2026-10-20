import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 't'.repeat(64);
process.env.PHONE_HASH_SECRET = 'o'.repeat(64);
process.env.NACALLER_KEY = 'mock-nacaller-key';

const [{ ApiError, assertRegistrationAvailable, completePhoneVerification, findAuthenticatedFarmer, getPhoneVerificationStatus }, { FarmerModel, OtpChallengeModel, PendingRegistrationModel, SessionModel }] = await Promise.all([
  import('../src/services/security.js'), import('../src/models/index.js'),
]);

const selected = <T>(value: T) => Object.assign({ select() { return this; }, then(resolve: (input: T) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(value).then(resolve, reject); } }, value);

test('phone challenge status remains pending until provider confirms it, and mismatched challenge references fail closed', async (context) => {
  const challenge = { _id: '507f1f77bcf86cd799439011', purpose: 'farmer_login', farmerId: 'farmer-id', providerRequestId: 'provider-1', status: 'pending', consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  context.mock.method(OtpChallengeModel, 'findById', () => selected(challenge) as never);
  context.mock.method(FarmerModel, 'findOne', () => ({ select: () => ({ lean: () => ({ exec: async () => ({ phone: '+919876543210' }) }) }) }) as never);
  context.mock.method(OtpChallengeModel, 'updateOne', async () => ({} as never));
  const pending = { status: async () => ({ requestId: 'provider-1', phone: '9876543210', reference: challenge._id, status: 'pending', verified: false, expiresAt: challenge.expiresAt }) };
  assert.equal((await getPhoneVerificationStatus(challenge._id, pending as never)).status, 'pending');
  const mismatched = { status: async () => ({ requestId: 'provider-1', phone: '9876543210', reference: 'another-challenge', status: 'verified', verified: true, expiresAt: challenge.expiresAt }) };
  await assert.rejects(getPhoneVerificationStatus(challenge._id, mismatched as never), (error) => error instanceof ApiError && error.code === 'verification_provider_response_invalid');
});

test('completion does not consume a challenge or issue a session while provider status is pending', async (context) => {
  const challenge = { _id: '507f1f77bcf86cd799439011', purpose: 'farmer_login', farmerId: 'farmer-id', providerRequestId: 'provider-1', status: 'pending', consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  context.mock.method(OtpChallengeModel, 'findById', () => selected(challenge) as never);
  context.mock.method(FarmerModel, 'findOne', () => ({ select: () => ({ lean: () => ({ exec: async () => ({ phone: '+919876543210' }) }) }) }) as never);
  context.mock.method(OtpChallengeModel, 'updateOne', async () => ({} as never));
  let consumed = false;
  context.mock.method(OtpChallengeModel, 'findOneAndUpdate', () => { consumed = true; return selected(null) as never; });
  const provider = { status: async () => ({ requestId: 'provider-1', phone: '9876543210', reference: challenge._id, status: 'pending', verified: false, expiresAt: challenge.expiresAt }) };
  await assert.rejects(completePhoneVerification(challenge._id, provider as never), (error) => error instanceof ApiError && error.code === 'verification_pending');
  assert.equal(consumed, false);
});

test('completion consumes a challenge only after NaCaller reports the matching request verified', async (context) => {
  const challenge = { _id: '507f1f77bcf86cd799439011', purpose: 'farmer_login', farmerId: 'farmer-id', providerRequestId: 'provider-1', status: 'pending', consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  context.mock.method(OtpChallengeModel, 'findById', () => selected(challenge) as never);
  context.mock.method(FarmerModel, 'findOne', () => ({ select: () => ({ lean: () => ({ exec: async () => ({ phone: '+919876543210' }) }) }) }) as never);
  context.mock.method(OtpChallengeModel, 'updateOne', async () => ({} as never));
  const consumed = { ...challenge, status: 'verified', consumedAt: new Date() };
  context.mock.method(OtpChallengeModel, 'findOneAndUpdate', () => selected(consumed) as never);
  const provider = { status: async () => ({ requestId: 'provider-1', phone: '9876543210', reference: challenge._id, status: 'verified', verified: true, expiresAt: challenge.expiresAt }) };
  assert.equal(await completePhoneVerification(challenge._id, provider as never), consumed);
});

test('session restoration accepts only an active server session and eligible farmer account', async (context) => {
  const session = { farmerId: 'farmer-id', expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  const farmer = { id: 'farmer-id', accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' };
  context.mock.method(SessionModel, 'findOne', async () => session as never);
  context.mock.method(FarmerModel, 'findById', async () => farmer as never);
  const result = await findAuthenticatedFarmer(`Bearer ${'s'.repeat(40)}`);
  assert.equal(result.farmer, farmer);
  context.mock.restoreAll();
  context.mock.method(SessionModel, 'findOne', async () => null as never);
  await assert.rejects(findAuthenticatedFarmer(`Bearer ${'s'.repeat(40)}`), (error) => error instanceof ApiError && error.status === 401);
});

test('registration refuses an existing farmer phone or Aadhaar fingerprint', async (context) => {
  context.mock.method(FarmerModel, 'exists', async () => ({ _id: 'existing' }) as never);
  await assert.rejects(assertRegistrationAvailable('+919876543210', 'phone-hash', 'aadhaar-fingerprint'), (error) => error instanceof ApiError && error.status === 409);
  context.mock.restoreAll();
  context.mock.method(FarmerModel, 'exists', async () => null as never);
  context.mock.method(PendingRegistrationModel, 'exists', async () => ({ _id: 'pending' }) as never);
  await assert.rejects(assertRegistrationAvailable('+919876543210', 'phone-hash', 'aadhaar-fingerprint'), (error) => error instanceof ApiError && error.status === 409);
});
