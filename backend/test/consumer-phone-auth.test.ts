import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';

process.env.NODE_ENV = 'development';
process.env.TOKEN_HMAC_SECRET = 'consumer-phone-token-secret'.padEnd(64, 'x');
process.env.PHONE_HASH_SECRET = 'consumer-phone-hash-secret'.padEnd(64, 'x');
process.env.AADHAAR_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
process.env.NACALLER_KEY = 'consumer-phone-test-nacaller-key';

const [{ startPhoneVerification, completePhoneVerification }, models, { decryptSecretValue, encryptSecretValue, hashPhone }, { normalizeIndianPhone }] = await Promise.all([
  import('../src/services/security.js'), import('../src/models/index.js'), import('../src/crypto.js'), import('../src/providers/otp.js'),
]);

const nullQuery = () => ({ sort() { return this; }, select() { return this; }, lean() { return this; }, exec: async () => null });
const selected = <T>(value: T) => Object.assign({ select() { return this; }, then(resolve: (input: T) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(value).then(resolve, reject); } }, value);

test('Consumer phone registration normalizes the number and keeps it encrypted in the verification challenge', async (context: TestContext) => {
  let saved: Record<string, unknown> | null = null;
  context.mock.method(models.OtpChallengeModel, 'findOne', nullQuery as never);
  context.mock.method(models.OtpChallengeModel, 'create', async (record: Record<string, unknown>) => { saved = { _id: new Types.ObjectId(), ...record }; return saved as never; });
  context.mock.method(models.OtpChallengeModel, 'findOneAndUpdate', async (_filter: unknown, update: { $set?: Record<string, unknown> }) => { Object.assign(saved!, update.$set); return saved as never; });
  const provider = { start: async (phone: string) => ({ requestId: 'provider-consumer-1', phone: phone.slice(3), callNumber: '+18005550123', instruction: 'Call this number', status: 'pending' as const, expiresAt: new Date(Date.now() + 60_000) }) };
  const started = await startPhoneVerification('98765 43210', 'consumer_registration', {}, provider as never);
  assert.equal(started.status, 'pending');
  assert.equal(normalizeIndianPhone('98765 43210'), '+919876543210');
  assert.ok(saved);
  const persisted = saved as Record<string, unknown>;
  assert.equal(persisted.phoneHash, hashPhone('+919876543210'));
  assert.equal(decryptSecretValue(String(persisted.phoneCiphertext)), '+919876543210');
  assert.equal(JSON.stringify(persisted).includes('+919876543210'), false);
});

test('a failed NaCaller start never verifies a Consumer challenge or creates a Consumer account', async (context: TestContext) => {
  let challengeStatus = '';
  context.mock.method(models.OtpChallengeModel, 'findOne', nullQuery as never);
  context.mock.method(models.OtpChallengeModel, 'create', async (record: Record<string, unknown>) => ({ _id: new Types.ObjectId(), ...record }) as never);
  context.mock.method(models.OtpChallengeModel, 'updateOne', async (_filter: unknown, update: { $set: { status: string } }) => { challengeStatus = update.$set.status; return {} as never; });
  let consumerCreated = false;
  context.mock.method(models.ConsumerModel, 'create', async () => { consumerCreated = true; return {} as never; });
  await assert.rejects(startPhoneVerification('+919876543210', 'consumer_registration', {}, { start: async () => { throw new Error('provider unavailable'); } } as never));
  assert.equal(challengeStatus, 'failed');
  assert.equal(consumerCreated, false);
});

test('Consumer account creation requires a matching verified provider status before a challenge can be consumed', async (context: TestContext) => {
  const challengeId = '507f1f77bcf86cd799439011';
  const challenge = { _id: challengeId, purpose: 'consumer_registration', phoneCiphertext: encryptSecretValue('+919876543210'), phoneHash: hashPhone('+919876543210'), providerRequestId: 'provider-2', status: 'pending', consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  context.mock.method(models.OtpChallengeModel, 'findById', () => selected(challenge) as never);
  context.mock.method(models.OtpChallengeModel, 'updateOne', async () => ({} as never));
  let consumed = false;
  context.mock.method(models.OtpChallengeModel, 'findOneAndUpdate', () => { consumed = true; return selected(null) as never; });
  const pendingProvider = { status: async () => ({ requestId: 'provider-2', phone: '9876543210', reference: challengeId, status: 'pending', verified: false, expiresAt: challenge.expiresAt }) };
  await assert.rejects(completePhoneVerification(challengeId, pendingProvider as never), (error: unknown) => error instanceof Error && error.message === 'verification_pending');
  assert.equal(consumed, false);
});

test('a matching verified NaCaller result consumes the Consumer challenge exactly once', async (context: TestContext) => {
  const challengeId = '507f1f77bcf86cd799439012';
  const challenge = { _id: challengeId, purpose: 'consumer_registration', phoneCiphertext: encryptSecretValue('+919876543210'), phoneHash: hashPhone('+919876543210'), providerRequestId: 'provider-3', status: 'pending', consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  context.mock.method(models.OtpChallengeModel, 'findById', () => selected(challenge) as never);
  context.mock.method(models.OtpChallengeModel, 'updateOne', async () => ({} as never));
  const consumedChallenge = { ...challenge, status: 'verified', consumedAt: new Date() };
  context.mock.method(models.OtpChallengeModel, 'findOneAndUpdate', () => selected(consumedChallenge) as never);
  const verifiedProvider = { status: async () => ({ requestId: 'provider-3', phone: '9876543210', reference: challengeId, status: 'verified', verified: true, expiresAt: challenge.expiresAt }) };
  const result = await completePhoneVerification(challengeId, verifiedProvider as never);
  assert.equal(result.status, 'verified');
  assert.equal(result.consumedAt instanceof Date, true);
});
