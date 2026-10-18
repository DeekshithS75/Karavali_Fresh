import { randomInt } from 'node:crypto';
import { Types, type Collection } from 'mongoose';
import { areSessionSecretsConfigured, config, isOtpConfigured } from '../config.js';
import { constantTimeHexEqual, hashOtp, hmac, randomToken } from '../crypto.js';
import { FarmerModel, OtpChallengeModel, RateLimitModel, SessionModel } from '../models/index.js';
import { getOtpProvider } from '../providers/otp.js';
import { ProviderNotConfiguredError } from '../providers/errors.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function enforceRateLimit(key: string, limit: number, windowMs: number) {
  const now = new Date();
  const start = new Date(now.getTime() - windowMs);
  const collection = RateLimitModel.collection as unknown as Collection<{ _id: string; windowStartedAt: Date; count: number; expiresAt: Date }>;
  const result = await collection.findOneAndUpdate(
    { _id: key },
    [{ $set: {
      windowStartedAt: { $cond: [{ $gt: ['$windowStartedAt', start] }, '$windowStartedAt', now] },
      count: { $cond: [{ $gt: ['$windowStartedAt', start] }, { $add: ['$count', 1] }, 1] },
      expiresAt: new Date(now.getTime() + windowMs * 2),
    } }],
    { upsert: true, returnDocument: 'after' },
  );
  if (result && typeof result === 'object' && 'count' in result && Number(result.count) > limit) {
    throw new ApiError(429, 'rate_limit_exceeded');
  }
}

export async function issueOtp(phone: string, purpose: 'farmer_login' | 'farmer_registration', ids: { farmerId?: Types.ObjectId; registrationId?: Types.ObjectId }) {
  if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  await enforceRateLimit(`otp:${hmac(phone)}`, 3, 15 * 60_000);
  const now = new Date();
  const active = await OtpChallengeModel.findOne({ phoneHash: hmac(phone), consumedAt: null, expiresAt: { $gt: now } }).lean().exec() as { createdAt: Date } | null;
  if (active && now.getTime() - active.createdAt.getTime() < config.OTP_RESEND_SECONDS * 1000) {
    throw new ApiError(429, 'otp_resend_too_soon');
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const provider = getOtpProvider();
  await provider.send(phone, code, purpose);
  await OtpChallengeModel.updateMany({ phoneHash: hmac(phone), consumedAt: null }, { $set: { consumedAt: now } });
  const challenge = await OtpChallengeModel.create({
    phoneHash: hmac(phone), codeHash: hashOtp(code), purpose, ...ids,
    expiresAt: new Date(now.getTime() + config.OTP_TTL_SECONDS * 1000),
    maxAttempts: config.OTP_MAX_ATTEMPTS, attempts: 0, deliveryStatus: 'sent',
  });
  return challenge;
}

export async function validateOtpChallenge(id: string, code: string, purpose: 'farmer_login' | 'farmer_registration') {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(400, 'invalid_challenge');
  const now = new Date();
  const challenge = await OtpChallengeModel.findOneAndUpdate({
    _id: id, purpose, consumedAt: null, expiresAt: { $gt: now }, $expr: { $lt: ['$attempts', '$maxAttempts'] },
  }, { $inc: { attempts: 1 } }, { new: true });
  if (!challenge) throw new ApiError(401, 'otp_invalid_or_expired');
  if (!constantTimeHexEqual(challenge.codeHash, hashOtp(code))) throw new ApiError(401, 'otp_invalid_or_expired');
  const consumed = await OtpChallengeModel.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } }, { new: true },
  );
  if (!consumed) throw new ApiError(401, 'otp_invalid_or_expired');
  return challenge;
}

export async function createSession(farmerId: Types.ObjectId) {
  const rawToken = randomToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);
  await SessionModel.create({ farmerId, tokenHash: hmac(rawToken), expiresAt, revokedAt: null });
  return { accessToken: rawToken, expiresAt: expiresAt.toISOString() };
}

export async function findAuthenticatedFarmer(authorization: string | undefined) {
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'authentication_required');
  const rawToken = authorization.slice(7);
  if (rawToken.length < 32 || rawToken.length > 256) throw new ApiError(401, 'invalid_session');
  const session = await SessionModel.findOne({ tokenHash: hmac(rawToken), revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!session) throw new ApiError(401, 'invalid_session');
  const farmer = await FarmerModel.findById(session.farmerId);
  if (!farmer || farmer.accountStatus !== 'active' || farmer.phoneVerificationStatus !== 'verified' || farmer.documentComparisonStatus !== 'passed') {
    throw new ApiError(401, 'invalid_session');
  }
  return { session, farmer };
}
