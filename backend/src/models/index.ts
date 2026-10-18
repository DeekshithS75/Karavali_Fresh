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
  phoneVerificationConsentedAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw' });

const pendingRegistrationSchema = new Schema({
  phoneHash: { type: String, required: true, unique: true, index: true },
  aadhaarHash: { type: String, required: true, unique: true, index: true },
  payloadCiphertext: { type: String, required: true },
  documentComparisonStatus: { type: String, enum: ['passed'], required: true },
  status: { type: String, enum: ['document_verified', 'completed', 'expired'], required: true, default: 'document_verified' },
  privacyNoticeVersion: { type: String, required: true },
  consentedAt: { type: Date, required: true },
  phoneVerificationConsentedAt: { type: Date },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true, strict: 'throw' });

const otpChallengeSchema = new Schema({
  phoneHash: { type: String, required: true, index: true },
  providerRequestId: { type: String, unique: true, sparse: true, index: true },
  callNumber: { type: String, maxlength: 80 },
  instruction: { type: String, maxlength: 500 },
  purpose: { type: String, enum: ['farmer_login', 'farmer_registration'], required: true },
  farmerId: { type: Schema.Types.ObjectId, ref: 'Farmer' },
  registrationId: { type: Schema.Types.ObjectId, ref: 'PendingFarmerRegistration' },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  consumedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  consentedAt: { type: Date, required: true },
  status: { type: String, enum: ['starting', 'pending', 'verified', 'expired', 'cancelled', 'failed'], required: true },
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

const produceSchema = new Schema({
  farmerId: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true, index: true },
  submissionId: { type: String, required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  nameTranslations: {
    en: { type: String, trim: true, maxlength: 120 },
    kn: { type: String, trim: true, maxlength: 120 },
    tcy: { type: String, trim: true, maxlength: 120 },
  },
  quantity: { type: Number, required: true, min: Number.MIN_VALUE, max: 1_000_000_000 },
  unit: { type: String, enum: ['kg', 'quintal', 'bunch', 'pieces'], required: true },
  pricePerUnit: { type: Number, min: Number.MIN_VALUE, max: 1_000_000_000, default: null },
  photos: [{ storageKey: { type: String, required: true }, mimeType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true }, size: { type: Number, required: true } }],
  status: { type: String, enum: ['awaiting_price', 'priced_unpublished'], required: true, default: 'awaiting_price' },
}, { timestamps: true, strict: 'throw' });
produceSchema.index({ farmerId: 1, submissionId: 1 }, { unique: true });

const marketPriceObservationSchema = new Schema({
  recordKey: { type: String, required: true },
  state: { type: String, required: true },
  district: { type: String, required: true },
  market: { type: String, required: true },
  commodity: { type: String, required: true },
  variety: { type: String, default: '' },
  grade: { type: String, default: '' },
  arrivalDate: { type: String, required: true },
  minPrice: { type: Number, required: true },
  maxPrice: { type: Number, required: true },
  modalPrice: { type: Number, required: true },
  fetchedAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw' });
marketPriceObservationSchema.index({ recordKey: 1, arrivalDate: 1 }, { unique: true });
marketPriceObservationSchema.index({ recordKey: 1, arrivalDate: -1 });

export type Farmer = InferSchemaType<typeof farmerSchema>;
export type PendingFarmerRegistration = InferSchemaType<typeof pendingRegistrationSchema>;
export const FarmerModel = mongoose.models.Farmer ?? mongoose.model('Farmer', farmerSchema);
export const PendingRegistrationModel = mongoose.models.PendingFarmerRegistration ?? mongoose.model('PendingFarmerRegistration', pendingRegistrationSchema);
export const OtpChallengeModel = mongoose.models.FarmerOtpChallenge ?? mongoose.model('FarmerOtpChallenge', otpChallengeSchema);
export const SessionModel = mongoose.models.FarmerSession ?? mongoose.model('FarmerSession', sessionSchema);
export const RateLimitModel = mongoose.models.FarmerRateLimit ?? mongoose.model('FarmerRateLimit', rateLimitSchema);
export const ProduceModel = mongoose.models.FarmerProduce ?? mongoose.model('FarmerProduce', produceSchema);
export const MarketPriceObservationModel = mongoose.models.MarketPriceObservation ?? mongoose.model('MarketPriceObservation', marketPriceObservationSchema);
