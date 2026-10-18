import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const farmerSchema = new Schema({
  fullName: { type: String, required: true },
  age: { type: Number, required: true },
  gender: { type: String, enum: ['male', 'female', 'other'], required: true },
  phone: { type: String, required: true, unique: true, index: true },
  aadhaarHash: { type: String, required: true, unique: true, index: true },
  address: { type: String, required: true },
  accountStatus: { type: String, enum: ['active'], required: true, default: 'active' },
  documentComparisonStatus: { type: String, enum: ['passed'], required: true },
  phoneVerificationStatus: { type: String, enum: ['verified'], required: true },
  phoneVerifiedAt: { type: Date, required: true },
  identityVerificationStatus: { type: String, enum: ['not_performed'], required: true, default: 'not_performed' },
  privacyNoticeVersion: { type: String, required: true },
  consentedAt: { type: Date, required: true },
  smsConsentedAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw' });

const pendingRegistrationSchema = new Schema({
  phoneHash: { type: String, required: true, unique: true, index: true },
  aadhaarHash: { type: String, required: true, unique: true, index: true },
  payloadCiphertext: { type: String, required: true },
  documentComparisonStatus: { type: String, enum: ['passed'], required: true },
  status: { type: String, enum: ['document_verified', 'completed', 'expired'], required: true, default: 'document_verified' },
  privacyNoticeVersion: { type: String, required: true },
  consentedAt: { type: Date, required: true },
  smsConsentedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true, strict: 'throw' });

const otpChallengeSchema = new Schema({
  phoneHash: { type: String, required: true, index: true },
  providerReference: { type: String, maxlength: 120 },
  purpose: { type: String, enum: ['farmer_login', 'farmer_registration'], required: true },
  farmerId: { type: Schema.Types.ObjectId, ref: 'Farmer' },
  registrationId: { type: Schema.Types.ObjectId, ref: 'PendingFarmerRegistration' },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  attempts: { type: Number, required: true, default: 0 },
  maxAttempts: { type: Number, required: true },
  consumedAt: { type: Date, default: null },
  deliveryStatus: { type: String, enum: ['sent', 'failed'], required: true },
}, { timestamps: true, strict: 'throw' });

const sessionSchema = new Schema({
  farmerId: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw' });

const rateLimitSchema = new Schema({
  _id: { type: String, required: true },
  windowStartedAt: { type: Date, required: true },
  count: { type: Number, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { versionKey: false, strict: 'throw' });

export type Farmer = InferSchemaType<typeof farmerSchema>;
export type PendingFarmerRegistration = InferSchemaType<typeof pendingRegistrationSchema>;
export const FarmerModel = mongoose.models.Farmer ?? mongoose.model('Farmer', farmerSchema);
export const PendingRegistrationModel = mongoose.models.PendingFarmerRegistration ?? mongoose.model('PendingFarmerRegistration', pendingRegistrationSchema);
export const OtpChallengeModel = mongoose.models.FarmerOtpChallenge ?? mongoose.model('FarmerOtpChallenge', otpChallengeSchema);
export const SessionModel = mongoose.models.FarmerSession ?? mongoose.model('FarmerSession', sessionSchema);
export const RateLimitModel = mongoose.models.FarmerRateLimit ?? mongoose.model('FarmerRateLimit', rateLimitSchema);
