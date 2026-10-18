import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import mongoose, { Types } from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { areSessionSecretsConfigured, config, isPhoneVerificationConfigured, isRegistrationEncryptionConfigured } from './config.js';
import { decryptSecretValue, encryptSecretValue, hashAadhaar, hashPhone, hmac } from './crypto.js';
import { FarmerModel, MarketPriceObservationModel, PendingRegistrationModel, ProduceModel } from './models/index.js';
import { compareAadhaarDocument, isOcrConfigured, OCR_ENGINE_NAME, type RegistrationDetails } from './providers/ocr.js';
import { NaCallerError } from './providers/otp.js';
import { ProviderNotConfiguredError } from './providers/errors.js';
import { ApiError, assertRegistrationAvailable, cancelPhoneVerification, completePhoneVerification, createSession, enforceRateLimit, findAuthenticatedFarmer, findAuthenticatedSession, getPhoneVerificationStatus, startPhoneVerification } from './services/security.js';
import { deleteProducePhotos, readProducePhoto, storeProducePhotos, ProduceStorageError } from './services/produce-storage.js';
import { marketPriceProvider, MarketPriceProviderError, marketRecordKey, matchesProduceCommodity, type MarketPriceRecord } from './providers/market-prices.js';
import { buildFarmerMarketComparison, previousArrivalDate, type FarmerProduceForMarket } from './services/market-comparison.js';

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
  quantity: z.coerce.number().finite().positive().max(1_000_000_000),
  unit: z.enum(['kg', 'quintal', 'bunch', 'pieces']),
  pricePerUnit: z.coerce.number().finite().positive().max(1_000_000_000),
});
const producePriceSchema = z.object({ pricePerUnit: z.coerce.number().finite().positive().max(1_000_000_000) });
const submissionIdSchema = z.string().uuid();
type PendingFarmerDetails = Omit<RegistrationDetails, 'aadhaar'>;

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

app.get('/health', (_request, response) => response.json({ status: 'ok' }));

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
    await enforceRateLimit(`registration-phone-verification-ip:${hmac(request.ip ?? 'unknown')}`, 10, 60 * 60_000);
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
    await enforceRateLimit(`phone-verification-ip:${hmac(request.ip ?? 'unknown')}`, 20, 15 * 60_000);
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
      .select('fullName accountStatus phoneVerificationStatus documentComparisonStatus')
      .lean()
      .exec() as { fullName: string; accountStatus: string; phoneVerificationStatus: string; documentComparisonStatus: string } | null;
    if (!farmer) throw new ApiError(404, 'farmer_not_found');
    if (farmer.accountStatus !== 'active' || farmer.phoneVerificationStatus !== 'verified' || farmer.documentComparisonStatus !== 'passed') {
      throw new ApiError(401, 'invalid_session');
    }
    return response.json({ profile: { fullName: farmer.fullName } });
  } catch (error) { return sendError(response, error); }
});

function formatProduce(record: { id: string; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; status: string; photos: Array<{ storageKey: string; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date }) {
  return {
    id: record.id,
    name: record.name,
    ...(record.nameTranslations ? { nameTranslations: record.nameTranslations } : {}),
    quantity: record.quantity,
    unit: record.unit,
    pricePerUnit: record.pricePerUnit ?? null,
    status: record.status,
    photos: record.photos.map((photo, index) => ({
      url: `/api/farmer/produce/${record.id}/photos/${index}`,
      mimeType: photo.mimeType,
      size: photo.size,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

app.get('/api/farmer/produce', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const records = await ProduceModel.find({ farmerId: farmer._id }).sort({ createdAt: -1 }).lean().exec() as unknown as Array<{
      _id: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; status: string;
      photos: Array<{ storageKey: string; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
    }>;
    return response.json({ items: records.map((record) => formatProduce({ ...record, id: String(record._id) })) });
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

    const names = [record.name, ...Object.values(record.nameTranslations ?? {})].filter((name): name is string => Boolean(name?.trim()));
    const dataset = await marketPriceProvider.getCoastalRecords(names);
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
    return response.json({
      comparison: buildFarmerMarketComparison({
        name: record.name, nameTranslations: record.nameTranslations, unit: record.unit, pricePerUnit: record.pricePerUnit ?? null,
      }, dataset.records, dataset.fetchedAt, previousByKeyAndDate),
    });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/produce', produceUpload.array('photos', 5), async (request, response) => {
  let storedPhotos: Awaited<ReturnType<typeof storeProducePhotos>> = [];
  let ownerId: Types.ObjectId | null = null;
  let requestSubmissionId: string | null = null;
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    const submissionId = submissionIdSchema.parse(request.header('idempotency-key'));
    ownerId = farmer._id;
    requestSubmissionId = submissionId;
    const input = produceInputSchema.parse(request.body);
    const uploads = (request.files ?? []) as Express.Multer.File[];
    if (uploads.length < 2 || uploads.length > 5) throw new ApiError(400, 'produce_photo_count_invalid');
    const existing = await ProduceModel.findOne({ farmerId: farmer._id, submissionId }).lean().exec() as {
      _id: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit?: number | null; status: string;
      photos: Array<{ storageKey: string; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
    } | null;
    if (existing) {
      if (existing.status === 'awaiting_price' && existing.pricePerUnit == null) {
        const updated = await ProduceModel.findOneAndUpdate(
          { _id: existing._id, farmerId: farmer._id, status: 'awaiting_price', pricePerUnit: null },
          { $set: { pricePerUnit: input.pricePerUnit, status: 'priced_unpublished' } },
          { new: true, runValidators: true },
        ).lean().exec() as typeof existing | null;
        if (updated) return response.status(200).json({ item: formatProduce({ ...updated, id: String(updated._id) }) });
      }
      return response.status(200).json({ item: formatProduce({ ...existing, id: String(existing._id) }) });
    }

    storedPhotos = await storeProducePhotos(uploads);
    const [record] = await ProduceModel.create([{
      farmerId: farmer._id, submissionId, name: input.name, quantity: input.quantity, unit: input.unit,
      pricePerUnit: input.pricePerUnit, photos: storedPhotos, status: 'priced_unpublished',
    }]);
    return response.status(201).json({ item: formatProduce({
      id: String(record._id), name: record.name, quantity: record.quantity, unit: record.unit,
      pricePerUnit: record.pricePerUnit, status: record.status, photos: record.photos, createdAt: record.createdAt, updatedAt: record.updatedAt,
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
    const record = await ProduceModel.findOneAndUpdate(
      { _id: request.params.produceId, farmerId: farmer._id, status: 'awaiting_price', pricePerUnit: null },
      { $set: { pricePerUnit, status: 'priced_unpublished' } },
      { new: true, runValidators: true },
    ).lean().exec() as {
      _id: Types.ObjectId; name: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: number; unit: string; pricePerUnit: number | null; status: string;
      photos: Array<{ storageKey: string; mimeType: string; size: number }>; createdAt: Date; updatedAt: Date;
    } | null;
    if (!record) {
      const ownedRecord = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id }).select('_id').lean().exec();
      if (!ownedRecord) throw new ApiError(404, 'produce_not_found');
      throw new ApiError(409, 'produce_price_already_set');
    }
    return response.json({ item: formatProduce({ ...record, id: String(record._id) }) });
  } catch (error) { return sendError(response, error); }
});

app.get('/api/farmer/produce/:produceId/photos/:photoIndex', async (request, response) => {
  try {
    const { farmer } = await findAuthenticatedFarmer(request.header('authorization'));
    if (!Types.ObjectId.isValid(request.params.produceId)) throw new ApiError(404, 'produce_image_not_found');
    const record = await ProduceModel.findOne({ _id: request.params.produceId, farmerId: farmer._id }).lean().exec() as {
      photos: Array<{ storageKey: string; mimeType: string }>;
    } | null;
    const index = Number(request.params.photoIndex);
    if (!record || !Number.isInteger(index) || index < 0 || index >= record.photos.length) throw new ProduceStorageError('not_found');
    const photo = record.photos[index]!;
    const bytes = await readProducePhoto(photo.storageKey);
    response.type(photo.mimeType).set('Cache-Control', 'private, no-store').send(bytes);
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/logout', async (request, response) => {
  try {
    const { session } = await findAuthenticatedFarmer(request.header('authorization'));
    session.revokedAt = new Date();
    await session.save();
    return response.status(204).end();
  } catch (error) { return sendError(response, error); }
});

const errorHandler: ErrorRequestHandler = (error, _request: Request, response: Response, _next) => { sendError(response, error); };
app.use(errorHandler);

export default app;
