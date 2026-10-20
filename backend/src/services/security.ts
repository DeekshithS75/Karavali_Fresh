import { Types, type Collection } from 'mongoose';
import { areSessionSecretsConfigured, config, isPhoneVerificationConfigured } from '../config.js';
import { decryptSecretValue, encryptSecretValue, hashPhone, hmac, randomToken } from '../crypto.js';
import { ConsumerModel, FarmerModel, OtpChallengeModel, PendingRegistrationModel, RateLimitModel, SessionModel } from '../models/index.js';
import { getPhoneVerificationProvider, normalizeIndianPhone, type PhoneVerificationProvider, type PhoneVerificationPurpose } from '../providers/otp.js';
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
  // Keep development testing unblocked. Test and production environments retain
  // the configured limits, and provider-side limits still apply independently.
  if (config.NODE_ENV === 'development') return;

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

export async function enforceStrictRateLimit(key: string, limit: number, windowMs: number) {
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

export type PhoneVerificationStart = {
  challengeId: string;
  callNumber: string;
  instruction: string;
  expiresAt: string;
  status: 'pending';
};

export type PhoneVerificationSnapshot = {
  status: 'pending' | 'verified' | 'expired' | 'cancelled';
  expiresAt: string;
};

export async function startPhoneVerification(
  phone: string,
  purpose: PhoneVerificationPurpose,
  ids: { farmerId?: Types.ObjectId; registrationId?: Types.ObjectId; consumerId?: Types.ObjectId },
  provider: PhoneVerificationProvider = getPhoneVerificationProvider(),
): Promise<PhoneVerificationStart> {
  if (!isPhoneVerificationConfigured()) throw new ProviderNotConfiguredError('otp');
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  const normalizedPhone = normalizeIndianPhone(phone);
  if (!normalizedPhone) throw new ApiError(400, 'invalid_phone');
  const now = new Date();
  const active = await OtpChallengeModel.findOne({
    phoneHash: hashPhone(normalizedPhone), status: { $in: ['starting', 'pending', 'verified'] },
    purpose, ...ids, consumedAt: null, expiresAt: { $gt: now },
  }).lean().exec() as { _id: Types.ObjectId; createdAt: Date; status: string; callNumber?: string; instruction?: string; expiresAt: Date } | null;
  if (active && active.status !== 'starting' && active.callNumber && active.instruction) {
    return {
      challengeId: String(active._id), callNumber: active.callNumber, instruction: active.instruction,
      expiresAt: active.expiresAt.toISOString(), status: 'pending',
    };
  }
  if (active) {
    throw new ApiError(409, 'verification_start_in_progress');
  }
  const latest = await OtpChallengeModel.findOne({ phoneHash: hashPhone(normalizedPhone) }).sort({ createdAt: -1 }).select('createdAt status').lean().exec() as { createdAt: Date; status: string } | null;
  if (purpose.startsWith('consumer_') && latest && ['starting', 'pending', 'verified'].includes(latest.status) && now.getTime() - latest.createdAt.getTime() < config.PHONE_VERIFICATION_RESEND_SECONDS * 1000) {
    throw new ApiError(429, 'verification_resend_too_soon');
  }
  if (purpose.startsWith('consumer_')) await enforceRateLimit(`phone-verify:${hashPhone(normalizedPhone)}`, 3, 15 * 60_000);

  const challenge = await OtpChallengeModel.create({
    phoneHash: hashPhone(normalizedPhone), purpose, ...ids,
    ...(purpose.startsWith('consumer_') ? { phoneCiphertext: encryptSecretValue(normalizedPhone) } : {}),
    expiresAt: new Date(now.getTime() + config.PHONE_VERIFICATION_TTL_SECONDS * 1000),
    consumedAt: null, cancelledAt: null, consentedAt: now, status: 'starting',
  });
  try {
    const started = await provider.start(normalizedPhone, String(challenge._id));
    if (started.phone !== normalizedPhone.slice(3) || started.status !== 'pending') throw new ApiError(502, 'verification_provider_response_invalid');
    const expiresAt = new Date(Math.min(started.expiresAt.getTime(), now.getTime() + config.PHONE_VERIFICATION_TTL_SECONDS * 1000));
    if (expiresAt.getTime() <= Date.now()) throw new ApiError(502, 'verification_provider_response_invalid');
    const updated = await OtpChallengeModel.findOneAndUpdate(
      { _id: challenge._id, status: 'starting', consumedAt: null },
      { $set: { providerRequestId: started.requestId, callNumber: started.callNumber, instruction: started.instruction, status: 'pending', expiresAt } },
      { new: true },
    );
    if (!updated) throw new ApiError(503, 'verification_challenge_unavailable');
    return {
      challengeId: String(challenge._id), callNumber: started.callNumber, instruction: started.instruction,
      expiresAt: expiresAt.toISOString(), status: 'pending',
    };
  } catch (error) {
    await OtpChallengeModel.updateOne({ _id: challenge._id, status: 'starting' }, { $set: { status: 'failed', consumedAt: new Date() } });
    throw error;
  }
}

export async function getPhoneVerificationStatus(
  id: string,
  provider: PhoneVerificationProvider = getPhoneVerificationProvider(),
): Promise<PhoneVerificationSnapshot> {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, 'verification_challenge_not_found');
  const challenge = await OtpChallengeModel.findById(id).select('+phoneCiphertext');
  if (!challenge) throw new ApiError(404, 'verification_challenge_not_found');
  if (challenge.status === 'cancelled') return { status: 'cancelled', expiresAt: challenge.expiresAt.toISOString() };
  if (challenge.status === 'expired' || challenge.status === 'failed') return { status: 'expired', expiresAt: challenge.expiresAt.toISOString() };
  if (challenge.consumedAt) throw new ApiError(409, 'verification_already_completed');
  if (challenge.expiresAt <= new Date()) {
    await OtpChallengeModel.updateOne({ _id: challenge._id, consumedAt: null }, { $set: { status: 'expired', consumedAt: new Date() } });
    return { status: 'expired', expiresAt: challenge.expiresAt.toISOString() };
  }
  if (!challenge.providerRequestId || !['pending', 'verified'].includes(challenge.status)) throw new ApiError(409, 'verification_not_started');

  const phone = await getChallengePhone(challenge);
  if (!phone) {
    await OtpChallengeModel.updateOne({ _id: challenge._id, consumedAt: null }, { $set: { status: 'failed', consumedAt: new Date() } });
    throw new ApiError(409, 'verification_owner_unavailable');
  }
  const remote = await provider.status(challenge.providerRequestId);
  if (remote.requestId !== challenge.providerRequestId || remote.reference !== String(challenge._id) || remote.phone !== phone.slice(3)) {
    throw new ApiError(502, 'verification_provider_response_invalid');
  }
  const status = remote.status === 'expired' || remote.expiresAt <= new Date() ? 'expired' : remote.status;
  const consumedAt = status === 'expired' ? new Date() : null;
  await OtpChallengeModel.updateOne(
    { _id: challenge._id, providerRequestId: remote.requestId, consumedAt: null },
    { $set: { status, consumedAt } },
  );
  return { status, expiresAt: challenge.expiresAt.toISOString() };
}

export async function completePhoneVerification(id: string, provider: PhoneVerificationProvider = getPhoneVerificationProvider()) {
  const snapshot = await getPhoneVerificationStatus(id, provider);
  if (snapshot.status === 'expired') throw new ApiError(410, 'verification_expired');
  if (snapshot.status === 'cancelled') throw new ApiError(409, 'verification_cancelled');
  if (snapshot.status !== 'verified') throw new ApiError(409, 'verification_pending');
  const challenge = await OtpChallengeModel.findOneAndUpdate(
    { _id: id, status: 'verified', consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } }, { new: true },
  ).select('+phoneCiphertext consumerId purpose phoneHash');
  if (!challenge) throw new ApiError(409, 'verification_already_completed');
  return challenge;
}

export async function cancelPhoneVerification(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, 'verification_challenge_not_found');
  const now = new Date();
  const challenge = await OtpChallengeModel.findOneAndUpdate(
    { _id: id, status: { $in: ['starting', 'pending'] }, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { status: 'cancelled', cancelledAt: now, consumedAt: now } }, { new: true },
  );
  if (!challenge) throw new ApiError(409, 'verification_cannot_be_cancelled');
  return { status: 'cancelled' as const };
}

async function getChallengePhone(challenge: { purpose: string; registrationId?: Types.ObjectId | null; farmerId?: Types.ObjectId | null; consumerId?: Types.ObjectId | null; phoneCiphertext?: string }) {
  let raw: string | undefined;
  if (challenge.purpose.startsWith('consumer_') && challenge.phoneCiphertext) {
    raw = decryptSecretValue(challenge.phoneCiphertext);
    if (challenge.purpose === 'consumer_login' && challenge.consumerId) {
      const consumer = await ConsumerModel.exists({ _id: challenge.consumerId, phoneHash: hashPhone(raw), accountStatus: 'active' });
      if (!consumer) raw = undefined;
    }
  } else if (challenge.purpose === 'farmer_registration' && challenge.registrationId) {
    const registration = await PendingRegistrationModel.findOne({
      _id: challenge.registrationId, status: 'document_verified', documentComparisonStatus: 'passed', expiresAt: { $gt: new Date() },
    }).lean().exec() as { payloadCiphertext: string } | null;
    if (registration) raw = (JSON.parse(decryptSecretValue(registration.payloadCiphertext)) as { phone?: string }).phone;
  } else if (challenge.purpose === 'farmer_login' && challenge.farmerId) {
    const farmer = await FarmerModel.findOne({
      _id: challenge.farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed',
    }).select('phone').lean().exec() as { phone: string } | null;
    raw = farmer?.phone;
  }
  return raw ? normalizeIndianPhone(raw) : null;
}

export async function createSession(farmerId: Types.ObjectId) {
  const rawToken = randomToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);
  await SessionModel.create({ farmerId, tokenHash: hmac(rawToken), expiresAt, revokedAt: null });
  return { accessToken: rawToken, expiresAt: expiresAt.toISOString() };
}

export async function findAuthenticatedSession(authorization: string | undefined) {
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'authentication_required');
  const rawToken = authorization.slice(7);
  if (rawToken.length < 32 || rawToken.length > 256) throw new ApiError(401, 'invalid_session');
  const session = await SessionModel.findOne({ tokenHash: hmac(rawToken), revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!session) throw new ApiError(401, 'invalid_session');
  return session;
}

export async function findAuthenticatedFarmer(authorization: string | undefined) {
  const session = await findAuthenticatedSession(authorization);
  const farmer = await FarmerModel.findById(session.farmerId);
  if (!farmer || farmer.accountStatus !== 'active' || farmer.phoneVerificationStatus !== 'verified' || farmer.documentComparisonStatus !== 'passed') {
    throw new ApiError(401, 'invalid_session');
  }
  return { session, farmer };
}
