import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 't'.repeat(64);
process.env.OTP_HMAC_SECRET = 'o'.repeat(64);
process.env.MSG91_AUTH_KEY = 'mock-auth-key';
process.env.MSG91_REGISTRATION_TEMPLATE_ID = 'registration-template';
process.env.MSG91_LOGIN_TEMPLATE_ID = 'login-template';

const [{ ApiError, assertRegistrationAvailable, findAuthenticatedFarmer, issueOtp, validateOtpChallenge }, { FarmerModel, OtpChallengeModel, PendingRegistrationModel, RateLimitModel, SessionModel }] = await Promise.all([
  import('../src/services/security.js'), import('../src/models/index.js'),
]);

const provider = (options: { send?: () => Promise<{ providerReference?: string }>; verify?: (phone: string, code: string) => Promise<boolean> } = {}) => ({
  send: options.send ?? (async () => ({ providerReference: 'ref-1' })),
  verify: options.verify ?? (async (_phone: string, _code: string) => true),
});

function rateLimit(context: test.TestContext, count = 1) {
  const collection = RateLimitModel.collection as unknown as { findOneAndUpdate: () => Promise<unknown> };
  context.mock.method(collection, 'findOneAndUpdate', async () => ({ count }));
}

test('OTP issue sends via provider and persists a challenge without an OTP hash', async (context) => {
  rateLimit(context);
  context.mock.method(OtpChallengeModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  context.mock.method(OtpChallengeModel, 'updateMany', async () => ({} as never));
  context.mock.method(OtpChallengeModel, 'create', async (value: unknown) => ({ id: 'challenge-1', ...(value as Record<string, unknown>) }) as never);
  let sent = false;
  const result = await issueOtp('+919876543210', 'farmer_login', {}, provider({ send: async () => { sent = true; return { providerReference: 'provider-ref' }; } }));
  assert.equal(sent, true);
  assert.equal(result.id, 'challenge-1');
  assert.equal(result.providerReference, 'provider-ref');
  assert.equal('codeHash' in result, false);
});

test('OTP issue enforces resend cooldown, rate limits, and provider delivery failure', async (context) => {
  rateLimit(context);
  context.mock.method(OtpChallengeModel, 'findOne', () => ({ lean: () => ({ exec: async () => ({ createdAt: new Date() }) }) }) as never);
  await assert.rejects(issueOtp('+919876543210', 'farmer_login', {}, provider()), (error: unknown) => error instanceof ApiError && error.status === 429);

  context.mock.restoreAll();
  rateLimit(context, 4);
  await assert.rejects(issueOtp('+919876543210', 'farmer_login', {}, provider()), (error: unknown) => error instanceof ApiError && error.status === 429);

  context.mock.restoreAll();
  rateLimit(context);
  context.mock.method(OtpChallengeModel, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }) as never);
  await assert.rejects(issueOtp('+919876543210', 'farmer_login', {}, provider({ send: async () => { throw new Error('otp_provider_unavailable'); } })), /otp_provider_unavailable/);
});

test('OTP verification enforces attempts and expiry, calls provider, and consumes only a valid challenge', async (context) => {
  const challenge = { _id: 'challenge-id', purpose: 'farmer_login', farmerId: 'farmer-id' };
  let updateCount = 0;
  context.mock.method(OtpChallengeModel, 'findOneAndUpdate', async () => { updateCount += 1; return challenge as never; });
  context.mock.method(FarmerModel, 'findOne', () => ({ select: () => ({ lean: () => ({ exec: async () => ({ phone: '9876543210' }) }) }) }) as never);
  const successfulProvider = provider({ verify: async (phone) => phone === '+919876543210' });
  await validateOtpChallenge('507f1f77bcf86cd799439011', '123456', 'farmer_login', successfulProvider);
  assert.equal(updateCount, 2);

  context.mock.restoreAll();
  context.mock.method(OtpChallengeModel, 'findOneAndUpdate', async () => challenge as never);
  context.mock.method(FarmerModel, 'findOne', () => ({ select: () => ({ lean: () => ({ exec: async () => ({ phone: '+919876543210' }) }) }) }) as never);
  await assert.rejects(validateOtpChallenge('507f1f77bcf86cd799439011', '000000', 'farmer_login', provider({ verify: async () => false })), (error: unknown) => error instanceof ApiError && error.status === 401);

  context.mock.restoreAll();
  let rejectionFilter: Record<string, unknown> | undefined;
  context.mock.method(OtpChallengeModel, 'findOneAndUpdate', async (filter: Record<string, unknown>) => { rejectionFilter = filter; return null as never; });
  await assert.rejects(validateOtpChallenge('507f1f77bcf86cd799439011', '123456', 'farmer_login', provider()), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.ok(rejectionFilter?.expiresAt);
  assert.ok(rejectionFilter?.$expr);
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
  await assert.rejects(findAuthenticatedFarmer(`Bearer ${'s'.repeat(40)}`), (error: unknown) => error instanceof ApiError && error.status === 401);
});

test('registration refuses an existing farmer phone or Aadhaar fingerprint', async (context) => {
  context.mock.method(FarmerModel, 'exists', async () => ({ _id: 'existing' }) as never);
  await assert.rejects(assertRegistrationAvailable('+919876543210', 'phone-hash', 'aadhaar-fingerprint'), (error: unknown) => error instanceof ApiError && error.status === 409);

  context.mock.restoreAll();
  context.mock.method(FarmerModel, 'exists', async () => null as never);
  context.mock.method(PendingRegistrationModel, 'exists', async () => ({ _id: 'pending' }) as never);
  await assert.rejects(assertRegistrationAvailable('+919876543210', 'phone-hash', 'aadhaar-fingerprint'), (error: unknown) => error instanceof ApiError && error.status === 409);
});
