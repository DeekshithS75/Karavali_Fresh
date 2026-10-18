import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import mongoose, { Types } from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { areSessionSecretsConfigured, config, isOtpConfigured, isRegistrationEncryptionConfigured } from './config.js';
import { decryptSecretValue, encryptSecretValue, hashAadhaar, hashOtpPhone, hmac } from './crypto.js';
import { FarmerModel, OtpChallengeModel, PendingRegistrationModel } from './models/index.js';
import { compareAadhaarDocument, isOcrConfigured, OCR_ENGINE_NAME, testAadhaarDocument, type OcrTestExpected, type RegistrationDetails } from './providers/ocr.js';
import { ProviderNotConfiguredError } from './providers/errors.js';
import { ApiError, assertRegistrationAvailable, createSession, enforceRateLimit, findAuthenticatedFarmer, issueOtp, validateOtpChallenge } from './services/security.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(null, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype));
  },
});
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.MOBILE_ORIGIN === '*' ? true : config.MOBILE_ORIGIN.split(',').map((value) => value.trim()) }));
app.use(express.json({ limit: '16kb' }));

const phoneSchema = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'invalid_phone');
const phoneBody = z.object({ phone: phoneSchema });
const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  age: z.coerce.number().int().min(18).max(100),
  gender: z.enum(['male', 'female', 'other']),
  phone: phoneSchema,
  aadhaar: z.string().transform((value) => value.replace(/\D/g, '')).refine((value) => /^\d{12}$/.test(value), 'invalid_aadhaar'),
  address: z.string().trim().min(5).max(500),
  consent: z.literal('true'),
  smsConsent: z.literal('true'),
  privacyNoticeVersion: z.string().min(1).max(80),
});
const ocrTestSchema = z.object({
  mode: z.literal('ocr-test'),
  fullName: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }),
  gender: z.enum(['male', 'female', 'other']),
  address: z.string().trim().min(3).max(500),
});
const otpBody = z.object({ challengeId: z.string().min(1), otp: z.string().regex(/^\d{6}$/) });
type PendingFarmerDetails = Omit<RegistrationDetails, 'aadhaar'>;

function sendError(response: Response, error: unknown) {
  if (error instanceof z.ZodError) return response.status(400).json({ error: 'validation_failed', fields: error.issues.map(({ path, message }) => ({ field: path.join('.'), message })) });
  if (error instanceof ApiError) return response.status(error.status).json({ error: error.code });
  if (error instanceof ProviderNotConfiguredError) return response.status(503).json({ error: error.provider === 'ocr' ? 'ocr_engine_not_configured' : 'otp_provider_not_configured' });
  if (error instanceof Error && ['ocr_engine_unavailable', 'otp_provider_unavailable'].includes(error.message)) {
    const provider = error.message.startsWith('ocr') ? 'ocr' : 'otp';
    return response.status(503).json({ error: provider === 'ocr' ? 'ocr_engine_unavailable' : 'otp_provider_unavailable' });
  }
  if (error instanceof multer.MulterError || (error instanceof Error && error.message.includes('File type'))) return response.status(400).json({ error: 'invalid_document' });
  if (error instanceof Error && 'code' in error && error.code === 11000) return response.status(409).json({ error: 'farmer_already_registered' });
  // Do not log request bodies, document data, OTPs, or provider responses.
  return response.status(500).json({ error: 'internal_error' });
}

app.get('/health', (_request, response) => response.json({ status: 'ok' }));

app.get('/api/farmer/auth/capabilities', (_request, response) => {
  const ocrReady = isOcrConfigured();
  const otpReady = isOtpConfigured();
  const secretsReady = areSessionSecretsConfigured() && isRegistrationEncryptionConfigured();
  const privacyNotice = { en: config.PRIVACY_NOTICE_EN, kn: config.PRIVACY_NOTICE_KN, tcy: config.PRIVACY_NOTICE_TCY || config.PRIVACY_NOTICE_EN };
  response.json({
    registrationEnabled: ocrReady && secretsReady,
    otpLoginEnabled: otpReady && areSessionSecretsConfigured(),
    documentComparisonEnabled: ocrReady,
    ocrEngineConfigured: ocrReady,
    otpDeliveryConfigured: otpReady,
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
    const phoneHash = hashOtpPhone(phone);
    const registered = Boolean(await FarmerModel.exists({ phone: { $in: [phone, phone.slice(3)] }, accountStatus: 'active' }));
    const pending = !registered
      ? await PendingRegistrationModel.findOne({ phoneHash, status: 'document_verified', expiresAt: { $gt: new Date() } }).select('_id').lean().exec() as { _id: Types.ObjectId } | null
      : null;
    return response.json({ accountStatus: registered ? 'registered' : pending ? 'pending' : 'new', ...(pending ? { verificationId: String(pending._id) } : {}) });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/registrations', upload.single('document'), async (request, response) => {
  try {
    if (request.body?.mode === 'ocr-test') {
      if (config.NODE_ENV === 'production' || !config.OCR_TEST_MODE_ENABLED) throw new ApiError(404, 'route_not_found');
      const expected = ocrTestSchema.parse(request.body) as OcrTestExpected & { mode: 'ocr-test' };
      if (!request.file || !request.file.buffer.length) throw new ApiError(400, 'document_required');
      if (!isOcrConfigured()) throw new ProviderNotConfiguredError('ocr');
      const result = await testAadhaarDocument(request.file.buffer, request.file.mimetype, expected);
      return response.status(result.status === 'unreadable' ? 422 : 200).json(result);
    }
    const data = registrationSchema.parse(request.body) as RegistrationDetails & { consent: 'true'; smsConsent: 'true'; privacyNoticeVersion: string };
    if (data.privacyNoticeVersion !== config.PRIVACY_NOTICE_VERSION) throw new ApiError(400, 'privacy_notice_version_mismatch');
    if (!request.file || !request.file.buffer.length) throw new ApiError(400, 'document_required');
    if (!isOcrConfigured()) throw new ProviderNotConfiguredError('ocr');
    if (!areSessionSecretsConfigured() || !isRegistrationEncryptionConfigured()) {
      throw new ApiError(503, 'registration_encryption_not_configured');
    }
    const aadhaarHash = hashAadhaar(data.aadhaar);
    const phoneHash = hashOtpPhone(data.phone);
    await enforceRateLimit(`registration-ip:${hmac(request.ip ?? 'unknown')}`, 10, 24 * 60 * 60_000);
    await enforceRateLimit(`registration:${phoneHash}`, 3, 24 * 60 * 60_000);
    await PendingRegistrationModel.deleteMany({ expiresAt: { $lte: new Date() }, $or: [{ phoneHash }, { aadhaarHash }] });
    await assertRegistrationAvailable(data.phone, phoneHash, aadhaarHash);

    const comparison = await compareAadhaarDocument(request.file.buffer, request.file.mimetype, data);
    if (comparison.status === 'unreadable') return response.status(422).json({ error: 'document_unreadable', issues: comparison.issues });
    if (comparison.status === 'mismatch') return response.status(422).json({ error: 'document_mismatch', fields: comparison.mismatches });

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
      smsConsentedAt: now,
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
    return response.json({ status: 'pending', documentComparison: registration.documentComparisonStatus });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/registrations/:id/otp', async (request, response) => {
  try {
    if (!Types.ObjectId.isValid(request.params.id)) throw new ApiError(404, 'verification_not_found');
    const registration = await PendingRegistrationModel.findById(request.params.id);
    if (!registration || registration.status !== 'document_verified' || registration.expiresAt <= new Date() || registration.documentComparisonStatus !== 'passed') {
      throw new ApiError(409, 'document_comparison_required');
    }
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
    await enforceRateLimit(`registration-otp-ip:${hmac(request.ip ?? 'unknown')}`, 10, 60 * 60_000);
    const data = JSON.parse(decryptSecretValue(registration.payloadCiphertext)) as PendingFarmerDetails;
    const challenge = await issueOtp(data.phone, 'farmer_registration', { registrationId: registration._id });
    return response.status(202).json({ challengeId: challenge.id });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/otp/request', async (request, response) => {
  try {
    if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    const { phone } = phoneBody.parse(request.body);
    await enforceRateLimit(`otp-ip:${hmac(request.ip ?? 'unknown')}`, 20, 15 * 60_000);
    const farmer = await FarmerModel.findOne({ phone: { $in: [phone, phone.slice(3)] }, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed' });
    if (!farmer) throw new ApiError(404, 'farmer_not_found');
    const challenge = await issueOtp(phone, 'farmer_login', { farmerId: farmer._id });
    return response.status(202).json({ challengeId: challenge.id });
  } catch (error) { return sendError(response, error); }
});

app.post('/api/farmer/auth/otp/verify', async (request, response) => {
  try {
    if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
    if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
    await enforceRateLimit(`otp-verify-ip:${hmac(request.ip ?? 'unknown')}`, 30, 15 * 60_000);
    const { challengeId, otp } = otpBody.parse(request.body);
    const registrationChallenge = Types.ObjectId.isValid(challengeId)
      ? await OtpChallengeModel.findById(challengeId).select('purpose').lean().exec() as { purpose: string } | null
      : null;
    const purpose = registrationChallenge?.purpose === 'farmer_registration' ? 'farmer_registration' : 'farmer_login';
    const challenge = await validateOtpChallenge(challengeId, otp, purpose);

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
          smsConsentedAt: registration.smsConsentedAt,
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
