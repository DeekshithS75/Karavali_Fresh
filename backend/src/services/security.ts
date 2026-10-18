import { Types, type Collection } from 'mongoose';
import { areSessionSecretsConfigured, config, isOtpConfigured } from '../config.js';
import { decryptSecretValue } from '../crypto.js';
import { hashOtpPhone, hmac, randomToken } from '../crypto.js';
import { FarmerModel, OtpChallengeModel, PendingRegistrationModel, RateLimitModel, SessionModel } from '../models/index.js';
import { getOtpProvider, type OtpPurpose } from '../providers/otp.js';
import { ProviderNotConfiguredError } from '../providers/errors.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function assertRegistrationAvailable(phone: string, phoneHash: string, aadhaarHash: string) {
  const duplicateFarmer = await FarmerModel.exists({ $or: [{ phone: { $in: [phone, phone.slice(3)] } }, { aadhaarHash }] });
  const duplicatePending = !duplicateFarmer && await PendingRegistrationModel.exists({ $or: [{ phoneHash }, { aadhaarHash }], expiresAt: { $gt: new Date() } });
  if (duplicateFarmer || duplicatePending) throw new ApiError(409, 'farmer_already_registered');
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

export async function issueOtp(phone: string, purpose: OtpPurpose, ids: { farmerId?: Types.ObjectId; registrationId?: Types.ObjectId }, provider = getOtpProvider()) {
  if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  await enforceRateLimit(`otp:${hashOtpPhone(phone)}`, 3, 15 * 60_000);
  const now = new Date();
  const active = await OtpChallengeModel.findOne({ phoneHash: hashOtpPhone(phone), consumedAt: null, expiresAt: { $gt: now } }).lean().exec() as { createdAt: Date } | null;
  if (active && now.getTime() - active.createdAt.getTime() < config.OTP_RESEND_SECONDS * 1000) {
    throw new ApiError(429, 'otp_resend_too_soon');
  }
  const delivery = await provider.send(phone, purpose);
  await OtpChallengeModel.updateMany({ phoneHash: hashOtpPhone(phone), consumedAt: null }, { $set: { consumedAt: now } });
  const challenge = await OtpChallengeModel.create({
    phoneHash: hashOtpPhone(phone), purpose, ...ids, providerReference: delivery.providerReference,
    expiresAt: new Date(now.getTime() + config.OTP_TTL_SECONDS * 1000),
    maxAttempts: config.OTP_MAX_ATTEMPTS, attempts: 0, deliveryStatus: 'sent',
  });
  return challenge;
}

export async function validateOtpChallenge(id: string, code: string, purpose: OtpPurpose, provider = getOtpProvider()) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(400, 'invalid_challenge');
  const now = new Date();
  const challenge = await OtpChallengeModel.findOneAndUpdate({
    _id: id, purpose, consumedAt: null, expiresAt: { $gt: now }, $expr: { $lt: ['$attempts', '$maxAttempts'] },
  }, { $inc: { attempts: 1 } }, { new: true });
  if (!challenge) throw new ApiError(401, 'otp_invalid_or_expired');
  let phone: string | null = null;
  if (challenge.purpose === 'farmer_registration' && challenge.registrationId) {
    const registration = await PendingRegistrationModel.findOne({
      _id: challenge.registrationId, status: 'document_verified', documentComparisonStatus: 'passed', expiresAt: { $gt: now },
    }).lean().exec() as { payloadCiphertext: string } | null;
    if (registration) phone = (JSON.parse(decryptSecretValue(registration.payloadCiphertext)) as { phone?: string }).phone ?? null;
  } else if (challenge.purpose === 'farmer_login' && challenge.farmerId) {
    const farmer = await FarmerModel.findOne({ _id: challenge.farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' }).select('phone').lean().exec() as { phone: string } | null;
    phone = farmer?.phone ? toIndiaE164(farmer.phone) : null;
  }
  if (!phone) throw new ApiError(401, 'otp_invalid_or_expired');
  if (!await provider.verify(phone, code)) throw new ApiError(401, 'otp_invalid_or_expired');
  const consumed = await OtpChallengeModel.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } }, { new: true },
  );
  if (!consumed) throw new ApiError(401, 'otp_invalid_or_expired');
  return challenge;
}

function toIndiaE164(phone: string) {
  if (/^\+91[6-9]\d{9}$/.test(phone)) return phone;
  return /^[6-9]\d{9}$/.test(phone) ? `+91${phone}` : '';
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
