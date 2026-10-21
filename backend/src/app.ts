import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import mongoose, { Types } from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { areSessionSecretsConfigured, config, isPhoneVerificationConfigured, isRegistrationEncryptionConfigured } from './config.js';
import { decryptSecretValue, encryptSecretValue, hashAadhaar, hashPhone, hmac } from './crypto.js';
import { ConsumerModel, FarmerModel, MarketPriceObservationModel, NotificationModel, OtpChallengeModel, PendingRegistrationModel, ProduceModel, ProduceRequestModel, PushTokenModel } from './models/index.js';
import { compareAadhaarDocument, isOcrConfigured, OCR_ENGINE_NAME, type RegistrationDetails } from './providers/ocr.js';
import { NaCallerError, normalizeIndianPhone } from './providers/otp.js';
import { ProviderNotConfiguredError } from './providers/errors.js';
import { ApiError, assertRegistrationAvailable, cancelPhoneVerification, completePhoneVerification, createSession, enforceRateLimit, enforceStrictRateLimit, findAuthenticatedFarmer, findAuthenticatedSession, getPhoneVerificationStatus, startPhoneVerification } from './services/security.js';
import { createProducePhotoDeliveryUrl, deleteProducePhotos, readLegacyProducePhoto, readProducePhoto, storeProducePhotos, ProduceStorageError } from './services/produce-storage.js';
import { marketPriceProvider, MarketPriceProviderError, marketRecordKey, matchesProduceCommodity, type MarketPriceRecord } from './providers/market-prices.js';
import { buildFarmerMarketComparison, previousArrivalDate, type FarmerProduceForMarket } from './services/market-comparison.js';
import { createConsumerSession, findAuthenticatedConsumer } from './services/consumer-auth.js';
import { sendAccountPush } from './services/push-notifications.js';
import { notificationCopy } from './services/notification-copy.js';
import { normalizeCommodityName, resolveOfficialCommodity } from './providers/market-commodities.js';
import { applyExotelCallStatus, latestRequestCallStatus } from './services/accepted-request-calls.js';
import { endMemberInAppCall, joinInAppCall, startAcceptedInAppCall } from './services/in-app-calls.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(null, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype));
  },
});
const produceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (_request, file, callback) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    ? callback(null, true)
    : callback(new Error('invalid_produce_image')),
});
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.NODE_ENV === 'development' || config.MOBILE_ORIGIN === '*'
  ? true
  : config.MOBILE_ORIGIN.split(',').map((value) => value.trim()) }));
app.use(express.json({ limit: '16kb' }));

const phoneSchema = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'invalid_phone');
const phoneBody = z.object({ phone: phoneSchema });
const phoneVerificationBody = z.object({ phone: phoneSchema, phoneVerificationConsent: z.literal('true') });
const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  age: z.coerce.number().int().min(18).max(100),
  gender: z.enum(['male', 'female', 'other']),
  phone: phoneSchema,
  aadhaar: z.string().transform((value) => value.replace(/\D/g, '')).refine((value) => /^\d{12}$/.test(value), 'invalid_aadhaar'),
  address: z.string().trim().min(5).max(500),
  consent: z.literal('true'),
  phoneVerificationConsent: z.literal('true'),
  privacyNoticeVersion: z.string().min(1).max(80),
});
const challengeIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const produceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceLanguage: z.enum(['en', 'kn', 'tcy']).default('en'),
  nameTranslations: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.object({ en: z.string().trim().max(120).optional(), kn: z.string().trim().max(120).optional(), tcy: z.string().trim().max(120).optional() }).optional()),
  quantity: z.coerce.number().finite().positive().max(1_000_000_000),
  unit: z.enum(['kg', 'quintal', 'bunch', 'pieces']),
  pricePerUnit: z.preprocess((value) => value === '' || value == null ? null : value, z.coerce.number().finite().positive().max(1_000_000_000).nullable().optional()),
  priceUnit: z.enum(['kg', 'quintal', 'bunch', 'pieces']).optional(),
  location: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.discriminatedUnion('status', [
    z.object({ status: z.literal('unavailable') }).strict(),
    z.object({
      status: z.literal('captured'),
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
      accuracyMeters: z.number().finite().min(0).max(100_000),
      capturedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
    }).strict(),
  ])).optional(),
});
const producePriceSchema = z.object({ pricePerUnit: z.coerce.number().finite().positive().max(1_000_000_000) });
const submissionIdSchema = z.object({ submissionId: z.string().uuid() });
const consumerVerificationStartSchema = z.object({
  phone: z.string().trim().min(7).max(30),
  purpose: z.enum(['login', 'registration']),
  phoneVerificationConsent: z.literal(true),
  fullName: z.string().trim().min(2).max(100).optional(),
}).superRefine((value, context) => {
  if (value.purpose === 'registration' && !value.fullName) context.addIssue({ code: 'custom', path: ['fullName'], message: 'name_required' });
});
const consumerVerificationCompleteSchema = z.object({ fullName: z.string().trim().min(2).max(100).optional(), preferredLanguage: z.enum(['en', 'kn', 'tcy']).optional() });
const consumerListingsQuery = z.object({
  search: z.string().trim().max(80).default(''),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(12),
  sort: z.enum(['newest', 'nearby']).default('newest'),
  latitude: z.coerce.number().finite().min(-90).max(90).optional(),
  longitude: z.coerce.number().finite().min(-180).max(180).optional(),
  accuracyMeters: z.coerce.number().finite().min(0).max(100_000).optional(),
  distanceKm: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine((query, context) => {
  const hasLatitude = query.latitude !== undefined;
  const hasLongitude = query.longitude !== undefined;
  const hasAccuracy = query.accuracyMeters !== undefined;
  if (hasLatitude !== hasLongitude || hasLatitude !== hasAccuracy) context.addIssue({ code: 'custom', message: 'location_fields_must_be_provided_together' });
  if (query.sort === 'nearby' && (!hasLatitude || !hasLongitude || !hasAccuracy || query.accuracyMeters! > 1_000)) context.addIssue({ code: 'custom', message: 'reliable_location_required_for_nearby_sort' });
});
const publishListingSchema = z.object({ published: z.boolean() });
const produceRequestSchema = z.object({ requestedQuantity: z.coerce.number().finite().gt(0).max(1_000_000_000), requestKey: z.string().uuid().optional(), callConsent: z.literal(true) });
const produceRequestDecisionSchema = z.object({ decision: z.enum(['accepted', 'rejected']) });
const pushTokenSchema = z.object({ token: z.string().regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/).max(200) });
type PendingFarmerDetails = Omit<RegistrationDetails, 'aadhaar'>;

async function cancelPendingProduceRequests(listingId: Types.ObjectId, farmerId: Types.ObjectId, session: mongoose.ClientSession, reason: 'listing_deleted' | 'listing_unavailable') {
  const pending = await ProduceRequestModel.find({ listingId, farmerId, status: 'pending' }).select('_id buyerId').session(session).lean().exec() as unknown as Array<{ _id: Types.ObjectId; buyerId: Types.ObjectId }>;
  if (!pending.length) return;
  const decidedAt = new Date();
  await ProduceRequestModel.updateMany(
    { _id: { $in: pending.map((item) => item._id) }, farmerId, status: 'pending' },
    { $set: { status: 'cancelled', decisionReason: reason, decidedAt } }, { session },
  ).exec();
  await NotificationModel.create(pending.map((item) => ({
    recipientRole: 'consumer', recipientId: item.buyerId, requestId: item._id, event: 'request_cancelled',
  })), { session });
}

function sendError(response: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = error.issues.map(({ path, message }) => ({ field: path.join('.'), message }));
    if (fields.some(({ field }) => field === 'pricePerUnit')) return response.status(400).json({ error: 'produce_price_invalid', fields });
    return response.status(400).json({ error: 'validation_failed', fields });
  }
  if (error instanceof ApiError) return response.status(error.status).json({ error: error.code });
  if (error instanceof ProviderNotConfiguredError) return response.status(503).json({ error: error.provider === 'ocr' ? 'ocr_engine_not_configured' : 'phone_verification_provider_not_configured' });
  if (error instanceof NaCallerError) {
    if (error.code === 'invalid_phone') return response.status(400).json({ error: 'invalid_phone' });
    if (error.code === 'credits_exhausted') return response.status(503).json({ error: 'verification_credits_exhausted' });
    if (error.code === 'rate_limited') return response.status(429).json({ error: 'rate_limit_exceeded' });
    if (error.code === 'line_not_configured') return response.status(503).json({ error: 'verification_line_not_configured' });
    if (error.code === 'request_not_found') return response.status(502).json({ error: 'verification_request_unavailable' });
    return response.status(503).json({ error: 'verification_provider_unavailable' });
  }
  if (error instanceof ProduceStorageError) {
    if (error.code === 'invalid_image') return response.status(400).json({ error: 'invalid_produce_image' });
    if (error.code === 'not_found') return response.status(404).json({ error: 'produce_image_not_found' });
    if (error.code === 'not_configured') return response.status(503).json({ error: 'produce_image_storage_not_configured' });
    return response.status(503).json({ error: 'produce_image_storage_failed' });
  }
  if (error instanceof MarketPriceProviderError) {
    if (error.code === 'not_configured') return response.status(503).json({ error: 'market_price_provider_not_configured' });
    if (error.code === 'response_invalid') return response.status(502).json({ error: 'market_price_response_invalid' });
    if (error.code === 'invalid_api_key') return response.status(503).json({ error: 'market_price_api_key_invalid' });
    if (error.code === 'rate_limited') return response.status(429).json({ error: 'market_price_rate_limited' });
    if (error.code === 'commodity_unrecognized') return response.status(422).json({ error: 'market_commodity_unrecognized' });
    if (error.code === 'origin_invalid') return response.status(400).json({ error: 'market_origin_invalid' });
    return response.status(503).json({ error: 'market_price_provider_unavailable' });
  }
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'produce_image_too_large' : error.code === 'LIMIT_FILE_COUNT' ? 'too_many_produce_images' : 'invalid_produce_upload' });
  }
  if (error instanceof Error && error.message === 'invalid_produce_image') return response.status(400).json({ error: 'invalid_produce_image' });
  if (error instanceof Error && error.message === 'ocr_engine_unavailable') {
    return response.status(503).json({ error: 'ocr_engine_unavailable' });
  }
  if (error instanceof multer.MulterError || (error instanceof Error && error.message.includes('File type'))) return response.status(400).json({ error: 'invalid_document' });
  if (error instanceof Error && 'code' in error && error.code === 11000) return response.status(409).json({ error: 'farmer_already_registered' });
  // Do not log request bodies, document data, OTPs, or provider responses.
  return response.status(500).json({ error: 'internal_error' });
}

app.get('/health', (_request, response) => {
  if (mongoose.connection.readyState !== 1) return response.status(503).json({ status: 'unavailable' });
  return response.json({ status: 'ok' });
});

app.post('/api/provider/exotel/calls/:token', async (request, response) => {
  try {
    const body = z.object({ Call: z.object({ Sid: z.string().max(160), Status: z.string().max(40) }).optional(), CallSid: z.string().max(160).optional(), Status: z.string().max(40).optional(), EventType: z.string().max(40).optional(), CustomField: z.string().max(100).optional(), custom_field: z.string().max(100).optional() }).passthrough().parse(request.body);
    const callSid = body.Call?.Sid ?? body.CallSid;
    const status = body.Call?.Status ?? body.Status;
    if (!callSid || !status || !/^[\w-]{6,160}$/.test(callSid)) throw new ApiError(400, 'invalid_call_callback');
    await applyExotelCallStatus({ token: request.params.token, callSid, status, eventType: body.EventType, customField: body.CustomField ?? body.custom_field ?? '' });
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

const consumerSessionReply = async (consumer: { _id: Types.ObjectId; fullName: string; preferredLanguage?: 'en' | 'kn' | 'tcy' }) => ({
  ...(await createConsumerSession(consumer._id)),
  consumer: { id: String(consumer._id), fullName: consumer.fullName, preferredLanguage: consumer.preferredLanguage ?? 'en' },
});

app.post('/api/consumer/auth/phone-verification', async (request, response) => {
  try {
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const input = consumerVerificationStartSchema.parse(request.body);
    const phone = normalizeIndianPhone(input.phone);
    if (!phone) throw new ApiError(400, 'invalid_phone');
    const phoneHash = hashPhone(phone);
    const consumer = await ConsumerModel.findOne({ phoneHash, accountStatus: 'active' }).select('_id').lean().exec() as { _id: Types.ObjectId } | null;
    if (input.purpose === 'login' && !consumer) throw new ApiError(404, 'consumer_account_not_found');
    if (input.purpose === 'registration' && consumer) throw new ApiError(409, 'consumer_phone_registered');
    const challenge = await startPhoneVerification(phone, input.purpose === 'login' ? 'consumer_login' : 'consumer_registration', consumer ? { consumerId: consumer._id } : {});
    return response.status(202).json(challenge);
  } catch (error) { return sendError(response, error); }
});

app.get('/api/consumer/auth/phone-verification/:challengeId/status', async (request, response) => {
  try {
    const challengeId = challengeIdSchema.parse(request.params.challengeId);
    await enforceStrictRateLimit(`consumer-phone-status-ip:${hmac(request.ip ?? 'unknown')}`, 120, 60_000);
    const owner = await OtpChallengeModel.exists({ _id: challengeId, purpose: { $in: ['consumer_login', 'consumer_registration'] } });
    if (!owner) throw new ApiError(404, 'verification_challenge_not_found');
    return response.json(await getPhoneVerificationStatus(challengeId));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/auth/phone-verification/:challengeId/cancel', async (request, response) => {
  try {
    const challengeId = challengeIdSchema.parse(request.params.challengeId);
    const owner = await OtpChallengeModel.exists({ _id: challengeId, purpose: { $in: ['consumer_login', 'consumer_registration'] } });
    if (!owner) throw new ApiError(404, 'verification_challenge_not_found');
    await enforceStrictRateLimit(`consumer-phone-cancel-ip:${hmac(request.ip ?? 'unknown')}`, 20, 60_000);
    return response.json(await cancelPhoneVerification(challengeId));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/auth/phone-verification/:challengeId/complete', async (request, response) => {
  try {
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const challengeId = challengeIdSchema.parse(request.params.challengeId);
    const input = consumerVerificationCompleteSchema.parse(request.body ?? {});
    const pending = await OtpChallengeModel.findOne({ _id: challengeId, purpose: { $in: ['consumer_login', 'consumer_registration'] }, consumedAt: null }).select('+phoneCiphertext').lean().exec() as { purpose: string; phoneHash: string; phoneCiphertext?: string; consumerId?: Types.ObjectId } | null;
    if (!pending) throw new ApiError(404, 'verification_challenge_not_found');
    if (pending.purpose === 'consumer_registration' && !input.fullName) throw new ApiError(400, 'consumer_name_required');
    const challenge = await completePhoneVerification(challengeId);
    if (!challenge.phoneCiphertext || !challenge.phoneHash) throw new ApiError(409, 'verification_owner_unavailable');
    if (challenge.purpose === 'consumer_registration') {
      if (await ConsumerModel.exists({ phoneHash: challenge.phoneHash })) throw new ApiError(409, 'consumer_phone_registered');
      let consumer;
      try {
        consumer = await ConsumerModel.create({
          fullName: input.fullName!, phoneHash: challenge.phoneHash, phoneCiphertext: challenge.phoneCiphertext,
          phoneVerifiedAt: new Date(), preferredLanguage: input.preferredLanguage ?? 'en', accountStatus: 'active',
        });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 11000) throw new ApiError(409, 'consumer_phone_registered');
        throw error;
      }
      return response.status(201).json(await consumerSessionReply(consumer));
    }
    const consumer = await ConsumerModel.findOne({
      ...(challenge.consumerId ? { _id: challenge.consumerId } : {}),
      phoneHash: challenge.phoneHash, accountStatus: 'active',
    }).select('_id fullName preferredLanguage').exec() as { _id: Types.ObjectId; fullName: string; preferredLanguage?: 'en' | 'kn' | 'tcy' } | null;
    if (!consumer) throw new ApiError(404, 'consumer_account_not_found');
    return response.json(await consumerSessionReply(consumer));
  } catch (error) { return sendError(response, error); }
});

app.get('/api/consumer/auth/session', async (request, response) => {
  try {
    const { session, consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    return response.json({ valid: true, role: 'consumer', consumerId: String(consumer._id), fullName: consumer.fullName, preferredLanguage: consumer.preferredLanguage ?? 'en', expiresAt: session.expiresAt });
  } catch (error) { return sendError(response, error); }
});

app.patch('/api/consumer/profile/language', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const { language } = z.object({ language: z.enum(['en', 'kn', 'tcy']) }).parse(request.body);
    await ConsumerModel.updateOne({ _id: consumer._id }, { $set: { preferredLanguage: language } }).exec();
    return response.json({ language });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/auth/logout', async (request, response) => {
  try {
    const { session, consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const { token } = z.object({ token: pushTokenSchema.shape.token.optional() }).optional().parse(request.body) ?? {};
    if (token) await PushTokenModel.updateOne({ token, recipientRole: 'consumer', recipientId: consumer._id }, { $set: { disabledAt: new Date() } }).exec();
    session.revokedAt = new Date();
    await session.save();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/push-tokens', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const { token } = pushTokenSchema.parse(request.body);
    await PushTokenModel.updateOne({ token }, { $set: { token, recipientRole: 'consumer', recipientId: consumer._id, disabledAt: null } }, { upsert: true }).exec();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

app.delete('/api/consumer/push-tokens', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const { token } = pushTokenSchema.parse(request.body);
    await PushTokenModel.updateOne({ token, recipientRole: 'consumer', recipientId: consumer._id }, { $set: { disabledAt: new Date() } }).exec();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/auth/capabilities', (_request, response) => {
  const ocrReady = isOcrConfigured();
  const phoneVerificationReady = isPhoneVerificationConfigured();
  const sessionSigningReady = areSessionSecretsConfigured();
  const registrationEncryptionReady = isRegistrationEncryptionConfigured();
  const missingConfiguration = [
    ...(!sessionSigningReady ? ['TOKEN_HMAC_SECRET'] : []),
    ...(!config.PHONE_HASH_SECRET || config.PHONE_HASH_SECRET.length < 32 || config.PHONE_HASH_SECRET.startsWith('replace-') ? ['PHONE_HASH_SECRET'] : []),
    ...(!config.AADHAAR_HASH_SECRET || config.AADHAAR_HASH_SECRET.length < 32 || config.AADHAAR_HASH_SECRET.startsWith('replace-') ? ['AADHAAR_HASH_SECRET'] : []),
    ...(!config.AADHAAR_ENCRYPTION_KEY_BASE64 || Buffer.from(config.AADHAAR_ENCRYPTION_KEY_BASE64, 'base64').length !== 32 ? ['AADHAAR_ENCRYPTION_KEY_BASE64'] : []),
    ...(!config.NACALLER_KEY || config.NACALLER_KEY.length < 16 || config.NACALLER_KEY.startsWith('replace-') ? ['NACALLER_KEY'] : []),
  ];
  const privacyNotice = { en: config.PRIVACY_NOTICE_EN, kn: config.PRIVACY_NOTICE_KN, tcy: config.PRIVACY_NOTICE_TCY || config.PRIVACY_NOTICE_EN };
  response.json({
    registrationEnabled: ocrReady && sessionSigningReady && registrationEncryptionReady,
    phoneVerificationEnabled: phoneVerificationReady && sessionSigningReady,
    documentComparisonEnabled: ocrReady,
    ocrEngineConfigured: ocrReady,
    phoneVerificationConfigured: phoneVerificationReady,
    sessionSigningConfigured: sessionSigningReady,
    registrationEncryptionConfigured: registrationEncryptionReady,
    missingConfiguration,
    ocrEngineName: ocrReady ? OCR_ENGINE_NAME : '',
    privacyNoticeVersion: config.PRIVACY_NOTICE_VERSION,
    privacyNotice,
  });
});

// This endpoint returns only account status and is rate-limited to reduce enumeration.
app.post('/api/farmer/auth/lookup', async (request, response) => {
  try {
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const { phone } = phoneBody.parse(request.body);
    await enforceRateLimit(`lookup:${hmac(phone)}`, 5, 60 * 60_000);
    await enforceRateLimit(`lookup-ip:${hmac(request.ip ?? 'unknown')}`, 30, 60 * 60_000);
    const phoneHash = hashPhone(phone);
    const registered = Boolean(await FarmerModel.exists({ phone: { $in: [phone, phone.slice(3)] }, accountStatus: 'active' }));
    const pending = !registered
      ? await PendingRegistrationModel.findOne({ phoneHash, status: 'document_verified', expiresAt: { $gt: new Date() } }).select('_id').lean().exec() as { _id: Types.ObjectId } | null
      : null;
    return response.json({ accountStatus: registered ? 'registered' : pending ? 'pending' : 'new', ...(pending ? { verificationId: String(pending._id) } : {}) });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/registrations', upload.single('document'), async (request, response) => {
  try {
    const data = registrationSchema.parse(request.body) as RegistrationDetails & { consent: 'true'; phoneVerificationConsent: 'true'; privacyNoticeVersion: string };
    if (data.privacyNoticeVersion !== config.PRIVACY_NOTICE_VERSION) throw new ApiError(400, 'privacy_notice_version_mismatch');
    if (!request.file || !request.file.buffer.length) throw new ApiError(400, 'document_required');
    if (!isOcrConfigured()) throw new ProviderNotConfiguredError('ocr');
    if (!areSessionSecretsConfigured() || !isRegistrationEncryptionConfigured()) {
      throw new ApiError(503, 'registration_encryption_not_configured');
    }
    const aadhaarHash = hashAadhaar(data.aadhaar);
    const phoneHash = hashPhone(data.phone);
    await enforceRateLimit(`registration-ip:${hmac(request.ip ?? 'unknown')}`, 50, 24 * 60 * 60_000);
    await enforceRateLimit(`registration:${phoneHash}`, 10, 24 * 60 * 60_000);
    await PendingRegistrationModel.deleteMany({ expiresAt: { $lte: new Date() }, $or: [{ phoneHash }, { aadhaarHash }] });
    await assertRegistrationAvailable(data.phone, phoneHash, aadhaarHash);

    const comparison = await compareAadhaarDocument(request.file.buffer, request.file.mimetype, data);
    if (comparison.status === 'unreadable') return response.status(422).json({
      error: 'document_unreadable',
      issues: comparison.issues,
      ...(comparison.missingFields ? { missingFields: comparison.missingFields } : {}),
    });
    if (comparison.status === 'mismatch') return response.status(422).json({
      error: 'document_mismatch',
      fields: comparison.mismatches,
      ...(comparison.mismatches.includes('name') && comparison.fields.fullName
        ? { suggestedFullName: comparison.fields.fullName }
        : {}),
    });

    const now = new Date();
    const registration = await PendingRegistrationModel.create({
      phoneHash,
      aadhaarHash,
      payloadCiphertext: encryptSecretValue(JSON.stringify({
        fullName: data.fullName, age: data.age, gender: data.gender, phone: data.phone,
        address: data.address,
      })),
      documentComparisonStatus: 'passed',
      status: 'document_verified',
      privacyNoticeVersion: data.privacyNoticeVersion,
      consentedAt: now,
      phoneVerificationConsentedAt: now,
      expiresAt: new Date(now.getTime() + config.REGISTRATION_TTL_HOURS * 60 * 60_000),
    });
    return response.status(201).json({ status: 'pending', documentComparison: 'passed', verificationId: registration.id });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/registrations/:id/verification', async (request, response) => {
  try {
    if (!Types.ObjectId.isValid(request.params.id)) throw new ApiError(404, 'verification_not_found');
    const registration = await PendingRegistrationModel.findById(request.params.id);
    if (!registration || registration.expiresAt <= new Date()) throw new ApiError(404, 'verification_not_found');
    return response.json({ status: 'pending', documentComparison: registration.documentComparisonStatus, phoneVerificationConsentRequired: !registration.phoneVerificationConsentedAt });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/registrations/:id/phone-verification-consent', async (request, response) => {
  try {
    if (!Types.ObjectId.isValid(request.params.id)) throw new ApiError(404, 'verification_not_found');
    z.object({ phoneVerificationConsent: z.literal('true') }).parse(request.body);
    const registration = await PendingRegistrationModel.findOneAndUpdate(
      { _id: request.params.id, status: 'document_verified', documentComparisonStatus: 'passed', expiresAt: { $gt: new Date() } },
      { $set: { phoneVerificationConsentedAt: new Date() } }, { new: true },
    );
    if (!registration) throw new ApiError(404, 'verification_not_found');
    return response.json({ consented: true });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/registrations/:id/phone-verification', async (request, response) => {
  try {
    if (!Types.ObjectId.isValid(request.params.id)) throw new ApiError(404, 'verification_not_found');
    const registration = await PendingRegistrationModel.findById(request.params.id);
    if (!registration || registration.status !== 'document_verified' || registration.expiresAt <= new Date() || registration.documentComparisonStatus !== 'passed') {
      throw new ApiError(409, 'document_comparison_required');
    }
    if (!registration.phoneVerificationConsentedAt) throw new ApiError(409, 'phone_verification_consent_required');
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    if (!isPhoneVerificationConfigured()) throw new ProviderNotConfiguredError('otp');
    const data = JSON.parse(decryptSecretValue(registration.payloadCiphertext)) as PendingFarmerDetails;
    const challenge = await startPhoneVerification(data.phone, 'farmer_registration', { registrationId: registration._id });
    return response.status(202).json(challenge);
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/phone-verification', async (request, response) => {
  try {
    if (!isPhoneVerificationConfigured()) throw new ProviderNotConfiguredError('otp');
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const { phone } = phoneVerificationBody.parse(request.body);
    const farmer = await FarmerModel.findOne({ phone: { $in: [phone, phone.slice(3)] }, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' });
    if (!farmer) throw new ApiError(404, 'farmer_not_found');
    const challenge = await startPhoneVerification(phone, 'farmer_login', { farmerId: farmer._id });
    return response.status(202).json(challenge);
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/auth/phone-verification/:challengeId/status', async (request, response) => {
  try {
    if (!isPhoneVerificationConfigured()) throw new ProviderNotConfiguredError('otp');
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const challengeId = challengeIdSchema.parse(request.params.challengeId);
    await enforceRateLimit(`phone-verification-status-ip:${hmac(request.ip ?? 'unknown')}`, 120, 60_000);
    return response.json(await getPhoneVerificationStatus(challengeId));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/phone-verification/:challengeId/cancel', async (request, response) => {
  try {
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const challengeId = challengeIdSchema.parse(request.params.challengeId);
    await enforceRateLimit(`phone-verification-cancel-ip:${hmac(request.ip ?? 'unknown')}`, 20, 60_000);
    return response.json(await cancelPhoneVerification(challengeId));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/phone-verification/:challengeId/complete', async (request, response) => {
  try {
    if (!isPhoneVerificationConfigured()) throw new ProviderNotConfiguredError('otp');
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const challengeId = challengeIdSchema.parse(request.params.challengeId);
    await enforceRateLimit(`phone-verification-complete-ip:${hmac(request.ip ?? 'unknown')}`, 30, 15 * 60_000);
    const challenge = await completePhoneVerification(challengeId);

    let farmerId: Types.ObjectId;
    if (challenge.purpose === 'farmer_registration') {
      const connection = mongoose.connection;
      const transaction = await connection.startSession();
      try {
        transaction.startTransaction();
        const registration = await PendingRegistrationModel.findOne({ _id: challenge.registrationId, status: 'document_verified', documentComparisonStatus: 'passed', expiresAt: { $gt: new Date() } }).session(transaction);
        if (!registration) throw new ApiError(409, 'registration_expired_or_invalid');
        const data = JSON.parse(decryptSecretValue(registration.payloadCiphertext)) as PendingFarmerDetails;
        const [farmer] = await FarmerModel.create([{
          fullName: data.fullName, age: data.age, gender: data.gender, phone: data.phone,
          aadhaarHash: registration.aadhaarHash, address: data.address,
          accountStatus: 'active', documentComparisonStatus: 'passed', phoneVerificationStatus: 'verified',
          phoneVerifiedAt: new Date(), identityVerificationStatus: 'not_performed',
          privacyNoticeVersion: registration.privacyNoticeVersion, consentedAt: registration.consentedAt,
          phoneVerificationConsentedAt: registration.phoneVerificationConsentedAt,
        }], { session: transaction });
        registration.status = 'completed';
        await registration.save({ session: transaction });
        farmerId = farmer._id;
        await transaction.commitTransaction();
      } catch (error) {
        await transaction.abortTransaction();
        throw error;
      } finally { await transaction.endSession(); }
    } else {
      if (!challenge.farmerId) throw new ApiError(401, 'otp_invalid_or_expired');
      farmerId = challenge.farmerId;
    }
    return response.json(await createSession(farmerId));
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/auth/session', async (request, response) => {
  try {
    const { farmer, session } = await findAuthenticatedFarmer(request.header('authorization'));
    return response.json({ valid: true, role: 'farmer', farmerId: farmer.id, expiresAt: session.expiresAt });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/profile', async (request, response) => {
  try {
    const session = await findAuthenticatedSession(request.header('authorization'));
    const farmer = await FarmerModel.findById(session.farmerId)
      .select('fullName preferredLanguage accountStatus phoneVerificationStatus documentComparisonStatus')
      .lean()
      .exec() as { fullName: string; preferredLanguage?: 'en' | 'kn' | 'tcy'; accountStatus: string; phoneVerificationStatus: string; documentComparisonStatus: string } | null;
    if (!farmer) throw new ApiError(404, 'farmer_not_found');
    if (farmer.accountStatus !== 'active' || farmer.phoneVerificationStatus !== 'verified' || farmer.documentComparisonStatus !== 'passed') {
      throw new ApiError(401, 'invalid_session');
    }
    return response.json({ profile: { fullName: farmer.fullName, preferredLanguage: farmer.preferredLanguage ?? 'en' } });
  } catch (error) { return sendError(response, error); }
});

app.patch('/api/farmer/profile/language', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const { language } = z.object({ language: z.enum(['en', 'kn', 'tcy']) }).parse(request.body);
    await FarmerModel.updateOne({ _id: farmer._id }, { $set: { preferredLanguage: language } }).exec();
    return response.json({ language });
  } catch (error) { return sendError(response, error); }
});

function formatProduce(record: { id: string; name: string; sourceLanguage?: 'en' | 'kn' | 'tcy'; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; priceUnit?: string | null; status: string; location?: { status: 'captured' | 'unavailable'; latitude?: number; longitude?: number; accuracyMeters?: number; capturedAt?: Date }; photos: Array<{ storageKey?: string; publicId?: string; assetId?: string; resourceType?: 'image'; format?: string; width?: number; height?: number; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date }) {
  return {
    id: record.id,
    name: record.name,
    sourceLanguage: record.sourceLanguage ?? 'en',
    ...(record.nameTranslations ? { nameTranslations: record.nameTranslations } : {}),
    quantity: record.quantity,
    unit: record.unit,
    pricePerUnit: record.pricePerUnit ?? null,
    priceUnit: record.priceUnit ?? null,
    status: record.status,
    ...(record.location ? { location: record.location } : {}),
    photos: record.photos.map((photo, index) => ({
      url: `/api/farmer/produce/${record.id}/photos/${index}`,
      mimeType: photo.mimeType,
      size: photo.size,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function distanceMetersBetween(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const arc = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function distanceBand(distanceMeters: number) {
  if (distanceMeters <= 2_000) return 'within_2_km';
  if (distanceMeters <= 10_000) return 'within_10_km';
  return 'nearby_region';
}

app.get('/api/consumer/produce', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const input = consumerListingsQuery.parse(request.query);
    const filter: Record<string, unknown> = {
      status: 'published', quantity: { $gt: 0 }, pricePerUnit: { $gt: 0 }, priceUnit: { $in: ['kg', 'quintal', 'bunch', 'pieces'] },
    };
    if (input.search) {
      const expression = new RegExp(input.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: expression }, { 'nameTranslations.en': expression }, { 'nameTranslations.kn': expression }, { 'nameTranslations.tcy': expression }];
    }
    if (input.sort === 'nearby') {
      filter['location.status'] = 'captured';
      filter['location.accuracyMeters'] = { $lte: 1_000 };
      filter.locationPoint = { $near: {
        $geometry: { type: 'Point', coordinates: [input.longitude!, input.latitude!] },
        $maxDistance: input.distanceKm * 1_000,
      } };
    }
    const skip = (input.page - 1) * input.limit;
    let query = ProduceModel.find(filter);
    if (input.sort !== 'nearby') query = query.sort({ createdAt: -1, _id: -1 });
    const records = await query.skip(skip).limit(input.limit + 1).lean().exec() as unknown as Array<{
      _id: Types.ObjectId; farmerId: Types.ObjectId; name: string; sourceLanguage: 'en' | 'kn' | 'tcy'; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
      quantity: number; unit: 'kg' | 'quintal' | 'bunch' | 'pieces'; pricePerUnit: number; priceUnit: 'kg' | 'quintal' | 'bunch' | 'pieces';
      location?: { status: string; latitude?: number; longitude?: number; accuracyMeters?: number };
      locationPoint?: { type: 'Point'; coordinates: [number, number] };
      photos: Array<{ mimeType: string }>;
    }>;
    const hasMore = records.length > input.limit;
    const pageRecords = records.slice(0, input.limit);
    const activeRequests = await ProduceRequestModel.find({ buyerId: consumer._id, status: { $in: ['pending', 'accepted'] } }).lean().exec() as unknown as Array<{ _id: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; commodityKey?: string; status: 'pending' | 'accepted' }>;
    const activeByCommodity = new Map(activeRequests.map((item) => [`${String(item.farmerId)}:${item.commodityKey ?? (resolveOfficialCommodity([item.listingName]) ?? normalizeCommodityName(item.listingName))}`, item]));
    const farmerIds = [...new Set(pageRecords.map((record) => String((record as { farmerId?: Types.ObjectId }).farmerId ?? ''))) ].filter(Boolean);
    const farmers = farmerIds.length ? await FarmerModel.find({ _id: { $in: farmerIds } }).select('_id fullName').lean().exec() as unknown as Array<{ _id: Types.ObjectId; fullName: string }> : [];
    const farmerNames = new Map(farmers.map((farmer) => [String(farmer._id), farmer.fullName]));
    const items = await Promise.all(pageRecords.map(async (record) => {
      const coords = record.locationPoint?.coordinates;
      const canEstimateDistance = input.latitude !== undefined && input.longitude !== undefined && input.accuracyMeters !== undefined && input.accuracyMeters <= 1_000 &&
        record.location?.status === 'captured' && (record.location.accuracyMeters ?? Infinity) <= 1_000 && coords?.length === 2;
      const distance = canEstimateDistance ? distanceMetersBetween(input.latitude!, input.longitude!, coords![1], coords![0]) : null;
      let marketComparison: unknown = null;
      try {
        marketComparison = await createMarketComparison({ name: record.name, nameTranslations: record.nameTranslations, unit: record.priceUnit, pricePerUnit: record.pricePerUnit });
      } catch { /* A missing or unavailable market source is represented explicitly to consumers. */ }
      return {
        id: String(record._id), name: record.name, sourceLanguage: record.sourceLanguage ?? 'en',
        ...(record.nameTranslations ? { nameTranslations: record.nameTranslations } : {}),
        quantity: record.quantity, unit: record.unit, pricePerUnit: record.pricePerUnit, priceUnit: record.priceUnit,
        farmerName: farmerNames.get(String((record as { farmerId?: Types.ObjectId }).farmerId)) ?? null,
        marketComparison,
        distanceBand: distance === null ? null : distanceBand(distance),
        photoUrl: record.photos.length ? `/api/consumer/produce/${String(record._id)}/photos/0` : null,
        ...(activeByCommodity.get(`${String(record.farmerId)}:${resolveOfficialCommodity([record.name, ...Object.values(record.nameTranslations ?? {})]) ?? normalizeCommodityName(record.name)}`)
          ? { existingRequest: (() => { const request = activeByCommodity.get(`${String(record.farmerId)}:${resolveOfficialCommodity([record.name, ...Object.values(record.nameTranslations ?? {})]) ?? normalizeCommodityName(record.name)}`)!; return { id: String(request._id), status: request.status }; })() }
          : { existingRequest: null }),
      };
    }));
    return response.json({ items, page: input.page, hasMore });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/consumer/produce/:produceId', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_not_available');
    const record = await ProduceModel.findOne({
      _id: request.params.produceId, status: 'published', quantity: { $gt: 0 }, pricePerUnit: { $gt: 0 },
      priceUnit: { $in: ['kg', 'quintal', 'bunch', 'pieces'] },
    }).select('_id farmerId name sourceLanguage nameTranslations quantity unit pricePerUnit priceUnit photos').lean().exec() as {
      _id: Types.ObjectId; farmerId: Types.ObjectId; name: string; sourceLanguage: 'en' | 'kn' | 'tcy';
      nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string;
      pricePerUnit: number; priceUnit: string; photos: Array<{ mimeType: string }>;
    } | null;
    if (!record) throw new ApiError(404, 'produce_not_available');
    const farmer = await FarmerModel.findById(record.farmerId).select('fullName').lean().exec() as { fullName: string } | null;
    const commodityKey = resolveOfficialCommodity([record.name, ...Object.values(record.nameTranslations ?? {})]) ?? normalizeCommodityName(record.name);
    const previousRequests = await ProduceRequestModel.find({ buyerId: consumer._id, farmerId: record.farmerId, status: { $in: ['pending', 'accepted'] } }).sort({ createdAt: -1 }).lean().exec() as unknown as Array<{ _id: Types.ObjectId; status: 'pending' | 'accepted'; commodityKey?: string; listingName: string }>;
    const previousRequest = previousRequests.find((item) => (item.commodityKey ?? (resolveOfficialCommodity([item.listingName]) ?? normalizeCommodityName(item.listingName))) === commodityKey) ?? null;
    let marketComparison: unknown = null;
    try { marketComparison = await createMarketComparison({ name: record.name, nameTranslations: record.nameTranslations, unit: record.priceUnit as FarmerProduceForMarket['unit'], pricePerUnit: record.pricePerUnit }); }
    catch { /* The client displays an explicit unavailable state. */ }
    return response.json({ item: {
      id: String(record._id), name: record.name, sourceLanguage: record.sourceLanguage ?? 'en',
      ...(record.nameTranslations ? { nameTranslations: record.nameTranslations } : {}),
      quantity: record.quantity, unit: record.unit, pricePerUnit: record.pricePerUnit, priceUnit: record.priceUnit,
      farmerName: farmer?.fullName ?? null, marketComparison,
      photoUrls: record.photos.map((_photo, index) => `/api/consumer/produce/${String(record._id)}/photos/${index}`),
      existingRequest: previousRequest ? { id: String(previousRequest._id), status: previousRequest.status } : null,
    } });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/consumer/produce/:produceId/photos/:photoIndex', async (request, response) => {
  try {
    await findAuthenticatedConsumer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ProduceStorageError('not_found');
    const index = Number(request.params.photoIndex);
    if (!Number.isInteger(index) || index < 0) throw new ProduceStorageError('not_found');
    const record = await ProduceModel.findOne({ _id: request.params.produceId, status: 'published', quantity: { $gt: 0 }, pricePerUnit: { $gt: 0 }, priceUnit: { $in: ['kg', 'quintal', 'bunch', 'pieces'] } })
      .select('photos').lean().exec() as { photos: Array<{ storageKey?: string; publicId?: string; resourceType?: 'image'; format?: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }> } | null;
    if (!record || index >= record.photos.length) throw new ProduceStorageError('not_found');
    const photo = record.photos[index]!;
    const bytes = await readProducePhoto(photo);
    return response.type(photo.mimeType).set('Cache-Control', 'private, no-store').send(bytes);
  } catch (error) { return sendError(response, error); }
});

async function formatBuyerRequest(record: {
  _id: Types.ObjectId; listingId: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
  listingPricePerUnit: number; listingPriceUnit: string; requestedQuantity: number; unit: string;
  status: string; createdAt: Date; decidedAt?: Date | null;
}) {
  const call = await latestRequestCallStatus(record._id);
  return {
    id: String(record._id), listingId: String(record.listingId), listingName: record.listingName, ...(record.listingNameTranslations ? { listingNameTranslations: record.listingNameTranslations } : {}),
    pricePerUnit: record.listingPricePerUnit, priceUnit: record.listingPriceUnit,
    requestedQuantity: record.requestedQuantity, unit: record.unit, status: record.status,
    createdAt: record.createdAt, decidedAt: record.decidedAt ?? null, callStatus: call.status, callConfirmed: call.confirmed,
  };
}

async function requestPhoneShare(record: {
  _id: Types.ObjectId; buyerId: Types.ObjectId; farmerId: Types.ObjectId; status: string;
  buyerSharedPhoneAt?: Date | null; farmerSharedPhoneAt?: Date | null;
}, viewerRole: 'consumer' | 'farmer') {
  const ownSharedAt = viewerRole === 'consumer' ? record.buyerSharedPhoneAt : record.farmerSharedPhoneAt;
  const otherSharedAt = viewerRole === 'consumer' ? record.farmerSharedPhoneAt : record.buyerSharedPhoneAt;
  let sharedPhone: string | null = null;
  if (record.status === 'accepted' && otherSharedAt) {
    if (viewerRole === 'consumer') {
      const farmer = await FarmerModel.findById(record.farmerId).select('phone').lean().exec() as { phone?: string } | null;
      sharedPhone = farmer?.phone ? normalizeIndianPhone(farmer.phone) : null;
    } else {
      const buyer = await ConsumerModel.findById(record.buyerId).select('+phoneCiphertext').lean().exec() as { phoneCiphertext?: string } | null;
      if (buyer?.phoneCiphertext) {
        try { sharedPhone = normalizeIndianPhone(decryptSecretValue(buyer.phoneCiphertext)); } catch { sharedPhone = null; }
      }
    }
  }
  return { ownPhoneShared: Boolean(ownSharedAt), sharedPhone };
}

async function shareRequestPhone(requestId: string, role: 'consumer' | 'farmer', participantId: Types.ObjectId) {
  if (!Types.ObjectId.isValid(requestId)) throw new ApiError(404, 'produce_request_not_found');
  const participantField = role === 'consumer' ? 'buyerId' : 'farmerId';
  const shareField = role === 'consumer' ? 'buyerSharedPhoneAt' : 'farmerSharedPhoneAt';
  const record = await ProduceRequestModel.findOneAndUpdate(
    { _id: requestId, [participantField]: participantId, status: 'accepted' },
    { $set: { [shareField]: new Date() } },
    { new: true },
  ).lean().exec();
  if (!record) throw new ApiError(404, 'accepted_produce_request_not_found');
  return { shared: true };
}

app.post('/api/consumer/requests/:requestId/share-phone', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    return response.json(await shareRequestPhone(request.params.requestId, 'consumer', consumer._id));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/requests/:requestId/share-phone', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    return response.json(await shareRequestPhone(request.params.requestId, 'farmer', farmer._id));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/produce/:produceId/requests', async (request, response) => {
  let buyerId: Types.ObjectId | null = null;
  let requestKey: string | undefined;
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    buyerId = consumer._id;
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_not_available');
    const input = produceRequestSchema.parse(request.body);
    requestKey = input.requestKey;
    const { requestedQuantity } = input;
    if (requestKey) {
      const existing = await ProduceRequestModel.findOne({ buyerId: consumer._id, requestKey }).lean().exec() as unknown as Parameters<typeof formatBuyerRequest>[0] | null;
      if (existing) return response.status(200).json({ request: await formatBuyerRequest(existing) });
    }
    const session = await mongoose.startSession();
    let saved: { _id: Types.ObjectId; listingId: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; listingPricePerUnit: number; listingPriceUnit: string; requestedQuantity: number; unit: string; status: string; createdAt: Date } | undefined;
    let noticeId = '';
    try {
      await session.withTransaction(async () => {
        const listing = await ProduceModel.findOneAndUpdate({
          _id: request.params.produceId, status: 'published', quantity: { $gt: 0 },
          pricePerUnit: { $gt: 0 }, priceUnit: { $in: ['kg', 'quintal', 'bunch', 'pieces'] },
        }, { $inc: { requestVersion: 1 } }, { new: true, session }).select('farmerId name nameTranslations unit quantity pricePerUnit priceUnit').lean().exec() as {
          farmerId: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; unit: string; quantity: number; pricePerUnit: number; priceUnit: string;
        } | null;
        if (!listing) throw new ApiError(409, 'produce_not_available');
        if (requestedQuantity > listing.quantity) throw new ApiError(409, 'produce_request_quantity_exceeds_available');
        const commodityKey = resolveOfficialCommodity([listing.name, ...Object.values(listing.nameTranslations ?? {})]) ?? normalizeCommodityName(listing.name);
        const activeRequests = await ProduceRequestModel.find({ buyerId: consumer._id, farmerId: listing.farmerId, status: { $in: ['pending', 'accepted'] } }).session(session).lean().exec() as unknown as Array<{ commodityKey?: string; listingName: string }>;
        const activeRequest = activeRequests.some((item) => (item.commodityKey ?? (resolveOfficialCommodity([item.listingName]) ?? normalizeCommodityName(item.listingName))) === commodityKey);
        if (activeRequest) throw new ApiError(409, 'produce_request_already_active');
        const [created] = await ProduceRequestModel.create([{
          buyerId: consumer._id, listingId: new Types.ObjectId(request.params.produceId), farmerId: listing.farmerId,
          listingName: listing.name, listingNameTranslations: listing.nameTranslations, commodityKey, listingPricePerUnit: listing.pricePerUnit, listingPriceUnit: listing.priceUnit,
          requestedQuantity, requestKey, callConsentAt: new Date(), unit: listing.unit, status: 'pending',
        }], { session });
        const [notice] = await NotificationModel.create([{
          recipientRole: 'farmer', recipientId: listing.farmerId, requestId: created!._id, event: 'request_created',
        }], { session });
        noticeId = String(notice!._id);
        saved = created!.toObject() as typeof saved;
      });
    } finally { await session.endSession(); }
    const farmerLanguage = await FarmerModel.findById(saved!.farmerId).select('preferredLanguage').lean().exec() as { preferredLanguage?: 'en' | 'kn' | 'tcy' } | null;
    const buyerDisplayName = consumer.fullName;
    const copy = notificationCopy(farmerLanguage?.preferredLanguage, 'request_created', { buyerName: buyerDisplayName, vegetableName: saved!.listingName, quantity: saved!.requestedQuantity, unit: saved!.unit });
    void sendAccountPush('farmer', saved!.farmerId, { ...copy, url: '/farmer/requests?requestId=' + String(saved!._id), notificationId: noticeId, requestId: String(saved!._id), categoryId: 'produceRequest' });
    return response.status(201).json({ request: await formatBuyerRequest(saved!) });
  } catch (error) {
    if (buyerId && error instanceof Error && 'code' in error && error.code === 11000) {
      const listing = Types.ObjectId.isValid(request.params.produceId) ? await ProduceModel.findById(request.params.produceId).select('farmerId name nameTranslations').lean().exec() as { farmerId: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>> } | null : null;
      if (listing) {
        const commodityKey = resolveOfficialCommodity([listing.name, ...Object.values(listing.nameTranslations ?? {})]) ?? normalizeCommodityName(listing.name);
        const duplicate = await ProduceRequestModel.findOne({ buyerId, farmerId: listing.farmerId, commodityKey, status: { $in: ['pending', 'accepted'] } }).lean().exec();
        if (duplicate) return response.status(409).json({ error: 'produce_request_already_active' });
      }
    }
    if (buyerId && requestKey && error instanceof Error && 'code' in error && error.code === 11000) {
      const existing = await ProduceRequestModel.findOne({ buyerId, requestKey }).lean().exec() as unknown as Parameters<typeof formatBuyerRequest>[0] | null;
      if (existing) return response.status(200).json({ request: await formatBuyerRequest(existing) });
    }
    return sendError(response, error);
  }
});

app.get('/api/consumer/requests', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const records = await ProduceRequestModel.find({ buyerId: consumer._id }).sort({ createdAt: -1 }).limit(100).lean().exec() as unknown as Array<{
      _id: Types.ObjectId; buyerId: Types.ObjectId; listingId: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; listingPricePerUnit: number; listingPriceUnit: string; requestedQuantity: number; unit: string; status: string; createdAt: Date; decidedAt?: Date | null; buyerSharedPhoneAt?: Date | null; farmerSharedPhoneAt?: Date | null;
    }>;
    return response.json({ items: await Promise.all(records.map(async (record) => ({ ...await formatBuyerRequest(record), ...await requestPhoneShare(record, 'consumer') }))) });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/requests', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const items = await ProduceRequestModel.find({ farmerId: farmer._id }).sort({ createdAt: -1 }).limit(100).lean().exec() as unknown as Array<{
      _id: Types.ObjectId; buyerId: Types.ObjectId; listingId: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; listingPricePerUnit: number; listingPriceUnit: string; requestedQuantity: number; unit: string; status: string; createdAt: Date; decidedAt?: Date | null; buyerSharedPhoneAt?: Date | null; farmerSharedPhoneAt?: Date | null;
    }>;
    const buyerIds = [...new Set(items.map((item) => String(item.buyerId)))];
    const buyers = buyerIds.length ? await ConsumerModel.find({ _id: { $in: buyerIds } }).select('_id fullName').lean().exec() as unknown as Array<{ _id: Types.ObjectId; fullName: string }> : [];
    const buyerNames = new Map(buyers.map((buyer) => [String(buyer._id), buyer.fullName]));
    return response.json({ items: await Promise.all(items.map(async (item) => {
      const call = await latestRequestCallStatus(item._id);
      return ({
      id: String(item._id), listingId: String(item.listingId), listingName: item.listingName, ...(item.listingNameTranslations ? { listingNameTranslations: item.listingNameTranslations } : {}),
      buyerName: buyerNames.get(String(item.buyerId)) ?? 'Buyer', pricePerUnit: item.listingPricePerUnit, priceUnit: item.listingPriceUnit, requestedQuantity: item.requestedQuantity, unit: item.unit, status: item.status,
      createdAt: item.createdAt, decidedAt: item.decidedAt ?? null, callStatus: call.status, callConfirmed: call.confirmed, callFailureCode: call.failureCode,
      ...await requestPhoneShare(item, 'farmer'),
    });
    })) });
  } catch (error) { return sendError(response, error); }
});

app.patch('/api/farmer/requests/:requestId/decision', async (request, response) => {
  let session: mongoose.ClientSession | null = null;
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.requestId)) throw new ApiError(404, 'produce_request_not_found');
    const { decision } = produceRequestDecisionSchema.parse(request.body);
    const transactionSession = await mongoose.startSession();
    session = transactionSession;
    let decidedStatus = decision;
    let noticeId = '';
    let recipientId: Types.ObjectId | null = null;
    await transactionSession.withTransaction(async () => {
      const current = await ProduceRequestModel.findOne({ _id: request.params.requestId, farmerId: farmer._id }).session(transactionSession).lean().exec() as {
        _id: Types.ObjectId; buyerId: Types.ObjectId; listingId: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; requestedQuantity: number; unit: string; status: string;
      } | null;
      if (!current) throw new ApiError(404, 'produce_request_not_found');
      recipientId = current.buyerId;
      if (current.status !== 'pending') throw new ApiError(409, 'produce_request_already_decided');
      const decidedAt = new Date();
      if (decision === 'rejected') {
        const changed = await ProduceRequestModel.updateOne(
          { _id: current._id, farmerId: farmer._id, status: 'pending' },
          { $set: { status: 'rejected', decidedAt } }, { session: transactionSession },
        ).exec();
        if (changed.modifiedCount !== 1) throw new ApiError(409, 'produce_request_already_decided');
      } else {
        const updatedListing = await ProduceModel.findOneAndUpdate({
          _id: current.listingId, farmerId: farmer._id, status: 'published', unit: current.unit,
          quantity: { $gte: current.requestedQuantity },
        }, { $inc: { quantity: -current.requestedQuantity } }, { new: true, session: transactionSession }).select('quantity').lean().exec() as { quantity: number } | null;
        if (!updatedListing) {
          const listing = await ProduceModel.findOne({ _id: current.listingId, farmerId: farmer._id }).select('status quantity').session(transactionSession).lean().exec() as { status: string; quantity: number } | null;
          if (!listing || listing.status !== 'published' || listing.quantity <= 0) throw new ApiError(409, 'produce_request_listing_unavailable');
          throw new ApiError(409, 'produce_request_insufficient_quantity');
        }
        if (updatedListing.quantity === 0) {
          await ProduceModel.updateOne({ _id: current.listingId, farmerId: farmer._id, status: 'published', quantity: 0 }, { $set: { status: 'priced_unpublished' } }, { session: transactionSession }).exec();
        }
        const changed = await ProduceRequestModel.updateOne(
          { _id: current._id, farmerId: farmer._id, status: 'pending' },
          { $set: { status: 'accepted', decidedAt } }, { session: transactionSession },
        ).exec();
        if (changed.modifiedCount !== 1) throw new ApiError(409, 'produce_request_already_decided');
        if (updatedListing.quantity === 0) {
          await cancelPendingProduceRequests(current.listingId, farmer._id, transactionSession, 'listing_unavailable');
        }
      }
      const [notice] = await NotificationModel.create([{
        recipientRole: 'consumer', recipientId: current.buyerId, requestId: current._id, event: 'request_decided',
      }], { session: transactionSession });
      noticeId = String(notice!._id);
      decidedStatus = decision;
    });
    // Notification persistence commits with the request. Push delivery is best effort.
    if (recipientId) {
      const buyer = await ConsumerModel.findOne({ _id: recipientId, accountStatus: 'active' }).select('preferredLanguage').exec() as { preferredLanguage?: 'en' | 'kn' | 'tcy' } | null;
      const copy = notificationCopy(buyer?.preferredLanguage, 'request_decided', { decision });
      void sendAccountPush('consumer', recipientId, { ...copy, url: '/consumer?section=requests&requestId=' + request.params.requestId, notificationId: noticeId, requestId: request.params.requestId });
    }
    return response.json({ status: decidedStatus });
  } catch (error) { return sendError(response, error); }
  finally { if (session) await session.endSession(); }
});

app.post('/api/farmer/requests/:requestId/call', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.requestId)) throw new ApiError(404, 'produce_request_not_found');
    const result = await startAcceptedInAppCall(new Types.ObjectId(request.params.requestId), farmer._id);
    if (!result) throw new ApiError(404, 'produce_request_not_found');
    return response.json(result);
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/requests/:requestId/call/retry', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.requestId)) throw new ApiError(404, 'produce_request_not_found');
    const result = await startAcceptedInAppCall(new Types.ObjectId(request.params.requestId), farmer._id);
    if (!result) throw new ApiError(404, 'produce_request_not_found');
    if ('conflict' in result && result.conflict) throw new ApiError(409, 'call_attempt_not_retryable');
    return response.json(result);
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/calls/:sessionId/join', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.sessionId)) throw new ApiError(404, 'in_app_call_not_found');
    return response.json(await joinInAppCall(new Types.ObjectId(request.params.sessionId), 'farmer', farmer._id));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/calls/:sessionId/join', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.sessionId)) throw new ApiError(404, 'in_app_call_not_found');
    return response.json(await joinInAppCall(new Types.ObjectId(request.params.sessionId), 'consumer', consumer._id));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/calls/:sessionId/end', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.sessionId)) throw new ApiError(404, 'in_app_call_not_found');
    return response.json(await endMemberInAppCall(new Types.ObjectId(request.params.sessionId), 'farmer', farmer._id));
  } catch (error) { return sendError(response, error); }
});

app.post('/api/consumer/calls/:sessionId/end', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.sessionId)) throw new ApiError(404, 'in_app_call_not_found');
    return response.json(await endMemberInAppCall(new Types.ObjectId(request.params.sessionId), 'consumer', consumer._id));
  } catch (error) { return sendError(response, error); }
});

async function notificationsFor(role: 'consumer' | 'farmer', recipientId: Types.ObjectId, page: number) {
  const pageSize = 50;
  const [records, unreadCount] = await Promise.all([
    NotificationModel.find({ recipientRole: role, recipientId }).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize + 1).lean().exec() as unknown as Promise<Array<{ _id: Types.ObjectId; requestId: Types.ObjectId; event: string; readAt?: Date | null; createdAt: Date }>>,
    NotificationModel.countDocuments({ recipientRole: role, recipientId, readAt: null }),
  ]);
  const requests = await ProduceRequestModel.find({ _id: { $in: records.map((item) => item.requestId) } }).lean().exec() as unknown as Array<{
    _id: Types.ObjectId; buyerId: Types.ObjectId; listingId: Types.ObjectId; farmerId: Types.ObjectId; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; listingPricePerUnit: number; listingPriceUnit: string; requestedQuantity: number; unit: string; status: string; createdAt: Date; decidedAt?: Date | null;
  }>;
  const requestById = new Map(requests.map((item) => [String(item._id), item]));
  const buyerIds = role === 'farmer' ? [...new Set(requests.map((item) => String(item.buyerId)))].filter((id) => id !== 'undefined') : [];
  const buyers = buyerIds.length ? await ConsumerModel.find({ _id: { $in: buyerIds } }).select('_id fullName').lean().exec() as unknown as Array<{ _id: Types.ObjectId; fullName: string }> : [];
  const buyerNames = new Map(buyers.map((buyer) => [String(buyer._id), buyer.fullName]));
  const items = await Promise.all(records.map(async (item) => {
    const produceRequest = requestById.get(String(item.requestId));
    const requestData = produceRequest ? await formatBuyerRequest(produceRequest) : null;
    return {
      id: String(item._id), event: item.event, readAt: item.readAt ?? null, createdAt: item.createdAt,
      request: requestData ? { ...requestData, ...(role === 'farmer' && produceRequest ? { buyerName: buyerNames.get(String(produceRequest.buyerId)) ?? 'Buyer' } : {}) } : null,
    };
  }));
  const hasMore = items.length > pageSize;
  return { items: items.slice(0, pageSize), unreadCount, page, hasMore };
}

const notificationPageQuery = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) });

app.get('/api/consumer/notifications', async (request, response) => {
  try {
    const { consumer } = await findAuthenticatedConsumer(request.header('authorization'));
    const { page } = notificationPageQuery.parse(request.query);
    return response.json(await notificationsFor('consumer', consumer._id, page));
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/notifications', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const { page } = notificationPageQuery.parse(request.query);
    return response.json(await notificationsFor('farmer', farmer._id, page));
  } catch (error) { return sendError(response, error); }
});

async function markNotificationRead(request: Request, response: Response, role: 'consumer' | 'farmer', recipientId: Types.ObjectId) {
  const notificationId = String(request.params.notificationId);
  if (!Types.ObjectId.isValid(notificationId)) throw new ApiError(404, 'notification_not_found');
  const result = await NotificationModel.updateOne(
    { _id: notificationId, recipientRole: role, recipientId },
    { $set: { readAt: new Date() } },
  ).exec();
  if (!result.matchedCount) throw new ApiError(404, 'notification_not_found');
  return response.json({ read: true });
}

app.patch('/api/consumer/notifications/:notificationId/read', async (request, response) => {
  try { const { consumer } = await findAuthenticatedConsumer(request.header('authorization')); return await markNotificationRead(request, response, 'consumer', consumer._id); }
  catch (error) { return sendError(response, error); }
});

app.patch('/api/farmer/notifications/:notificationId/read', async (request, response) => {
  try { const { farmer } = await findAuthenticatedFarmer(request.header('authorization')); return await markNotificationRead(request, response, 'farmer', farmer._id); }
  catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/produce', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const records = await ProduceModel.find({ farmerId: farmer._id }).sort({ createdAt: -1 }).lean().exec() as unknown as Array<{
      _id: Types.ObjectId; name: string; sourceLanguage: 'en' | 'kn' | 'tcy'; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; priceUnit?: string | null; status: string; location?: { status: 'captured' | 'unavailable'; latitude?: number; longitude?: number; accuracyMeters?: number; capturedAt?: Date };
      photos: Array<{ storageKey?: string; publicId?: string; assetId?: string; resourceType?: 'image'; format?: string; width?: number; height?: number; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
    }>;
    return response.json({ items: records.map((record) => formatProduce({ ...record, id: String(record._id) })) });
  } catch (error) { return sendError(response, error); }
});

const marketQuoteQuery = z.object({
  commodity: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().max(120).optional(),
  nameKn: z.string().trim().max(120).optional(),
  nameTcy: z.string().trim().max(120).optional(),
  unit: z.enum(['kg', 'quintal', 'bunch', 'pieces']),
  askingPrice: z.coerce.number().finite().positive().max(1_000_000_000).nullable().optional(),
});

async function createMarketComparison(produce: FarmerProduceForMarket) {
  const names = [produce.name, ...Object.values(produce.nameTranslations ?? {})].filter((name): name is string => Boolean(name?.trim()));
  const dataset = await marketPriceProvider.getRelevantRecords(names);
  const matching = dataset.records.filter((item) => matchesProduceCommodity(item, names));
  const previousQueries = matching.map((item) => ({ recordKey: marketRecordKey(item), arrivalDate: previousArrivalDate(item.arrivalDate) }));
  const previous = previousQueries.length
    ? await MarketPriceObservationModel.find({ $or: previousQueries }).lean().exec() as unknown as Array<{
      recordKey: string; arrivalDate: string; state: string; district: string; market: string; commodity: string;
      variety: string; grade: string; minPrice: number; maxPrice: number; modalPrice: number;
    }>
    : [];
  const previousByKeyAndDate = new Map(previous.map((item) => [
    `${item.recordKey}|${item.arrivalDate}`,
    { ...item, arrivalDate: item.arrivalDate } as MarketPriceRecord,
  ]));
  if (matching.length) await MarketPriceObservationModel.bulkWrite(matching.map((item) => {
    const recordKey = marketRecordKey(item);
    return { updateOne: {
      filter: { recordKey, arrivalDate: item.arrivalDate },
      update: { $set: { recordKey, state: item.state, district: item.district, market: item.market, commodity: item.commodity,
        variety: item.variety, grade: item.grade, arrivalDate: item.arrivalDate, minPrice: item.minPrice, maxPrice: item.maxPrice,
        modalPrice: item.modalPrice, fetchedAt: new Date(dataset.fetchedAt) } },
      upsert: true,
    } };
  }));
  return buildFarmerMarketComparison(produce, dataset, previousByKeyAndDate);
}

app.get('/api/farmer/market-quote', async (request, response) => {
  try {
    await findAuthenticatedFarmer(request.header('authorization'));
    const input = marketQuoteQuery.parse(request.query);
    const comparison = await createMarketComparison({
      name: input.commodity,
      nameTranslations: { en: input.nameEn, kn: input.nameKn, tcy: input.nameTcy },
      unit: input.unit, pricePerUnit: input.askingPrice ?? null,
    });
    return response.json({ comparison });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/produce/:produceId/market-comparison', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_not_found');
    const record = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id }).lean().exec() as {
      _id: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
      unit: FarmerProduceForMarket['unit']; pricePerUnit?: number | null;
    } | null;
    if (!record) throw new ApiError(404, 'produce_not_found');
    return response.json({ comparison: await createMarketComparison({
      name: record.name, nameTranslations: record.nameTranslations, unit: record.unit, pricePerUnit: record.pricePerUnit ?? null,
    }) });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/produce', produceUpload.array('photos', 5), async (request, response) => {
  let storedPhotos: Awaited<ReturnType<typeof storeProducePhotos>> = [];
  let ownerId: Types.ObjectId | null = null;
  let requestSubmissionId: string | null = null;
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const { submissionId } = submissionIdSchema.parse({ submissionId: request.header('idempotency-key') });
    ownerId = farmer._id;
    requestSubmissionId = submissionId;
    const input = produceInputSchema.parse(request.body);
    const uploads = (request.files ?? []) as Express.Multer.File[];
    if (uploads.length > 5) throw new ApiError(400, 'produce_photo_count_invalid');
    const existing = await ProduceModel.findOne({ farmerId: farmer._id, submissionId }).lean().exec() as {
      _id: Types.ObjectId; name: string; sourceLanguage: 'en' | 'kn' | 'tcy'; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; priceUnit?: string | null; status: string; location?: { status: 'captured' | 'unavailable'; latitude?: number; longitude?: number; accuracyMeters?: number; capturedAt?: Date };
      photos: Array<{ storageKey?: string; publicId?: string; assetId?: string; resourceType?: 'image'; format?: string; width?: number; height?: number; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
    } | null;
    if (existing) {
      return response.status(200).json({ item: formatProduce({ ...existing, id: String(existing._id) }) });
    }

    const produceId = new Types.ObjectId();
    storedPhotos = uploads.length ? await storeProducePhotos(uploads, String(farmer._id), String(produceId)) : [];
    const [record] = await ProduceModel.create([{
      _id: produceId, farmerId: farmer._id, submissionId, name: input.name, sourceLanguage: input.sourceLanguage,
      nameTranslations: input.nameTranslations, quantity: input.quantity, unit: input.unit,
      pricePerUnit: input.pricePerUnit ?? null, priceUnit: input.pricePerUnit == null ? null : (input.priceUnit ?? input.unit),
      photos: storedPhotos,
      ...(input.location ? { location: input.location } : {}),
      ...(input.location?.status === 'captured' ? { locationPoint: { type: 'Point', coordinates: [input.location.longitude, input.location.latitude] } } : {}),
      status: input.pricePerUnit == null ? 'awaiting_price' : 'published',
    }]);
    return response.status(201).json({ item: formatProduce({
      id: String(record._id), name: record.name, sourceLanguage: record.sourceLanguage,
      nameTranslations: record.nameTranslations, quantity: record.quantity, unit: record.unit,
      pricePerUnit: record.pricePerUnit, priceUnit: record.priceUnit, status: record.status,
      location: record.location,
      photos: record.photos, createdAt: record.createdAt, updatedAt: record.updatedAt,
    }) });
  } catch (error) {
    await deleteProducePhotos(storedPhotos);
    if (ownerId && requestSubmissionId && error instanceof Error && 'code' in error && error.code === 11000) {
      const existing = await ProduceModel.findOne({ farmerId: ownerId, submissionId: requestSubmissionId }).lean().exec() as unknown as {
        _id: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; status: string;
        photos: Array<{ storageKey: string; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
      } | null;
      if (existing) return response.status(200).json({ item: formatProduce({ ...existing, id: String(existing._id) }) });
    }
    return sendError(response, error);
  }
});

app.patch('/api/farmer/produce/:produceId/price', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_not_found');
    const { pricePerUnit } = producePriceSchema.parse(request.body);
    const awaitingRecord = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id, status: 'awaiting_price', pricePerUnit: null })
      .select('unit').lean().exec() as { unit: string } | null;
    if (!awaitingRecord) {
      const ownedRecord = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id }).select('_id').lean().exec();
      if (!ownedRecord) throw new ApiError(404, 'produce_not_found');
      throw new ApiError(409, 'produce_price_already_set');
    }
    const record = await ProduceModel.findOneAndUpdate(
      { _id: request.params.produceId, farmerId: farmer._id, status: 'awaiting_price', pricePerUnit: null },
      { $set: { pricePerUnit, priceUnit: awaitingRecord.unit, status: 'published' } },
      { new: true, runValidators: true },
    ).lean().exec() as {
      _id: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit: number | null; status: string;
      photos: Array<{ storageKey?: string; publicId?: string; assetId?: string; resourceType?: 'image'; format?: string; width?: number; height?: number; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
    } | null;
    if (!record) throw new ApiError(409, 'produce_price_already_set');
    return response.json({ item: formatProduce({ ...record, id: String(record._id) }) });
  } catch (error) { return sendError(response, error); }
});

app.patch('/api/farmer/produce/:produceId/publication', async (request, response) => {
  const session = await mongoose.startSession();
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_not_found');
    const { published } = publishListingSchema.parse(request.body);
    let nextStatus = published ? 'published' : 'priced_unpublished';
    await session.withTransaction(async () => {
      const current = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id }).select('status quantity pricePerUnit priceUnit').session(session).lean().exec() as {
        status: string; quantity: number; pricePerUnit?: number | null; priceUnit?: string | null;
      } | null;
      if (!current) throw new ApiError(404, 'produce_not_found');
      if (published && (current.quantity <= 0 || !current.pricePerUnit || current.pricePerUnit <= 0 || !current.priceUnit)) throw new ApiError(409, 'produce_not_ready_to_publish');
      nextStatus = published ? 'published' : 'priced_unpublished';
      if (current.status === nextStatus) return;
      if (published && current.status !== 'priced_unpublished' || !published && current.status !== 'published') throw new ApiError(409, 'produce_not_ready_to_publish');
      const updated = await ProduceModel.findOneAndUpdate(
        { _id: request.params.produceId, farmerId: farmer._id, status: current.status },
        { $set: { status: nextStatus } }, { new: true, runValidators: true, session },
      ).select('status').lean().exec() as { status: string } | null;
      if (!updated) throw new ApiError(409, 'produce_not_ready_to_publish');
      if (!published) await cancelPendingProduceRequests(new Types.ObjectId(request.params.produceId), farmer._id, session, 'listing_unavailable');
    });
    return response.json({ status: nextStatus });
  } catch (error) { return sendError(response, error); }
  finally { await session.endSession(); }
});

app.delete('/api/farmer/produce/:produceId', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_not_found');
    const record = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id })
      .select('photos')
      .lean()
      .exec() as { photos: Array<{ storageKey?: string; publicId?: string; resourceType?: 'image' }> } | null;
    if (!record) throw new ApiError(404, 'produce_not_found');

    // Remove assets first. If Cloudinary is unavailable, keep the Mongo record
    // so the owner can retry and no private asset reference is lost.
    if (record.photos.length && !await deleteProducePhotos(record.photos)) {
      throw new ApiError(503, 'produce_image_cleanup_failed');
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await cancelPendingProduceRequests(new Types.ObjectId(request.params.produceId), farmer._id, session, 'listing_deleted');
        const result = await ProduceModel.deleteOne({ _id: request.params.produceId, farmerId: farmer._id }).session(session).exec();
        if (result.deletedCount !== 1) throw new ApiError(404, 'produce_not_found');
      });
    } finally { await session.endSession(); }
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/produce/:produceId/photos/:photoIndex', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_image_not_found');
    const record = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id }).lean().exec() as {
      photos: Array<{ storageKey?: string; publicId?: string; assetId?: string; resourceType?: 'image'; format?: string; mimeType: string }>;
    } | null;
    const index = Number(request.params.photoIndex);
    if (!record || !Number.isInteger(index) || index < 0 || index >= record.photos.length) throw new ProduceStorageError('not_found');
    const photo = record.photos[index]!;
    if (photo.publicId && photo.format) {
      return response.set('Cache-Control', 'private, no-store').redirect(302, createProducePhotoDeliveryUrl(photo));
    }
    if (!photo.storageKey) throw new ProduceStorageError('not_found');
    const bytes = await readLegacyProducePhoto(photo.storageKey);
    response.type(photo.mimeType).set('Cache-Control', 'private, no-store').send(bytes);
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/logout', async (request, response) => {
  try {
    const { session, farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const { token } = z.object({ token: pushTokenSchema.shape.token.optional() }).optional().parse(request.body) ?? {};
    if (token) await PushTokenModel.updateOne({ token, recipientRole: 'farmer', recipientId: farmer._id }, { $set: { disabledAt: new Date() } }).exec();
    session.revokedAt = new Date();
    await session.save();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/push-tokens', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const { token } = pushTokenSchema.parse(request.body);
    await PushTokenModel.updateOne({ token }, { $set: { token, recipientRole: 'farmer', recipientId: farmer._id, disabledAt: null } }, { upsert: true }).exec();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

app.delete('/api/farmer/push-tokens', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const { token } = pushTokenSchema.parse(request.body);
    await PushTokenModel.updateOne({ token, recipientRole: 'farmer', recipientId: farmer._id }, { $set: { disabledAt: new Date() } }).exec();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

const errorHandler: ErrorRequestHandler = (error, _request: Request, response: Response, _next) => { sendError(response, error); };
app.use(errorHandler);

export default app;
