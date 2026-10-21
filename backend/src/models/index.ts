import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const farmerSchema = new Schema({
  fullName: { type: String, required: true },
  preferredLanguage: { type: String, enum: ['en', 'kn', 'tcy'], default: 'en' },
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

const consumerSchema = new Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  preferredLanguage: { type: String, enum: ['en', 'kn', 'tcy'], default: 'en' },
  phoneHash: { type: String, required: true, unique: true, index: true, select: false },
  phoneCiphertext: { type: String, required: true, select: false },
  phoneVerifiedAt: { type: Date },
  devLoginOnly: { type: Boolean, default: false, select: false },
  accountStatus: { type: String, enum: ['active'], required: true, default: 'active' },
}, { timestamps: true, strict: 'throw' });

const consumerSessionSchema = new Schema({
  consumerId: { type: Schema.Types.ObjectId, ref: 'Consumer', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date, default: null },
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
  purpose: { type: String, enum: ['farmer_login', 'farmer_registration', 'consumer_login', 'consumer_registration'], required: true },
  farmerId: { type: Schema.Types.ObjectId, ref: 'Farmer' },
  registrationId: { type: Schema.Types.ObjectId, ref: 'PendingFarmerRegistration' },
  consumerId: { type: Schema.Types.ObjectId, ref: 'Consumer' },
  phoneCiphertext: { type: String, select: false },
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
  sourceLanguage: { type: String, enum: ['en', 'kn', 'tcy'], required: true, default: 'en' },
  nameTranslations: {
    en: { type: String, trim: true, maxlength: 120 },
    kn: { type: String, trim: true, maxlength: 120 },
    tcy: { type: String, trim: true, maxlength: 120 },
  },
  quantity: { type: Number, required: true, min: Number.MIN_VALUE, max: 1_000_000_000 },
  requestVersion: { type: Number, required: true, default: 0, min: 0 },
  unit: { type: String, enum: ['kg', 'quintal', 'bunch', 'pieces'], required: true },
  pricePerUnit: { type: Number, min: Number.MIN_VALUE, max: 1_000_000_000, default: null },
  priceUnit: { type: String, enum: ['kg', 'quintal', 'bunch', 'pieces'], default: null },
  photos: [{
    // storageKey remains optional for local assets created before Cloudinary migration.
    storageKey: { type: String },
    publicId: { type: String },
    assetId: { type: String },
    resourceType: { type: String, enum: ['image'] },
    format: { type: String, enum: ['jpeg', 'png', 'webp'] },
    width: { type: Number },
    height: { type: Number },
    mimeType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
    size: { type: Number, required: true },
  }],
  location: {
    status: { type: String, enum: ['captured', 'unavailable'], required: true },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0, max: 100_000 },
    capturedAt: { type: Date },
  },
  locationPoint: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },
  status: { type: String, enum: ['awaiting_price', 'priced_unpublished', 'published'], required: true, default: 'awaiting_price' },
}, { timestamps: true, strict: 'throw' });
produceSchema.index({ farmerId: 1, submissionId: 1 }, { unique: true });
produceSchema.index({ locationPoint: '2dsphere' });

const produceRequestSchema = new Schema({
  buyerId: { type: Schema.Types.ObjectId, ref: 'Consumer', required: true, index: true },
  listingId: { type: Schema.Types.ObjectId, ref: 'FarmerProduce', required: true, index: true },
  farmerId: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true, index: true },
  listingName: { type: String, required: true, maxlength: 120 },
  listingNameTranslations: {
    en: { type: String, trim: true, maxlength: 120 },
    kn: { type: String, trim: true, maxlength: 120 },
    tcy: { type: String, trim: true, maxlength: 120 },
  },
  commodityKey: { type: String, required: true, maxlength: 120 },
  listingPricePerUnit: { type: Number, required: true, min: Number.MIN_VALUE },
  listingPriceUnit: { type: String, enum: ['kg', 'quintal', 'bunch', 'pieces'], required: true },
  requestedQuantity: { type: Number, required: true, min: Number.MIN_VALUE, max: 1_000_000_000 },
  requestKey: { type: String, maxlength: 80 },
  callConsentAt: { type: Date },
  buyerSharedPhoneAt: { type: Date, default: null },
  farmerSharedPhoneAt: { type: Date, default: null },
  unit: { type: String, enum: ['kg', 'quintal', 'bunch', 'pieces'], required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'cancelled'], required: true, default: 'pending', index: true },
  decidedAt: { type: Date, default: null },
  decisionReason: { type: String, enum: ['listing_deleted', 'listing_unavailable', 'insufficient_quantity', 'buyer_account_reset'], default: null },
}, { timestamps: true, strict: 'throw' });
produceRequestSchema.index({ buyerId: 1, createdAt: -1 });
produceRequestSchema.index({ farmerId: 1, status: 1, createdAt: -1 });
produceRequestSchema.index({ buyerId: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });
produceRequestSchema.index({ buyerId: 1, farmerId: 1, commodityKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['pending', 'accepted'] }, commodityKey: { $type: 'string' } } });

const notificationSchema = new Schema({
  recipientRole: { type: String, enum: ['consumer', 'farmer'], required: true, index: true },
  recipientId: { type: Schema.Types.ObjectId, required: true, index: true },
  requestId: { type: Schema.Types.ObjectId, ref: 'ProduceRequest', required: true, index: true },
  event: { type: String, enum: ['request_created', 'request_decided', 'request_cancelled', 'call_queued', 'call_initiated', 'call_failed', 'call_completed'], required: true },
  readAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw' });
notificationSchema.index({ recipientRole: 1, recipientId: 1, createdAt: -1 });

const pushTokenSchema = new Schema({
  recipientRole: { type: String, enum: ['consumer', 'farmer'], required: true, index: true },
  recipientId: { type: Schema.Types.ObjectId, required: true, index: true },
  token: { type: String, required: true, unique: true },
  disabledAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw' });
pushTokenSchema.index({ recipientRole: 1, recipientId: 1, disabledAt: 1 });

const callAttemptSchema = new Schema({
  requestId: { type: Schema.Types.ObjectId, ref: 'ProduceRequest', required: true },
  activeRequestId: { type: Schema.Types.ObjectId, select: false },
  attempt: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['queued', 'initiated', 'failed', 'completed'], required: true, index: true },
  provider: { type: String, enum: ['exotel'], default: 'exotel', required: true },
  providerReference: { type: String, maxlength: 160 },
  callbackTokenHash: { type: String, required: true, select: false, index: true },
  failureCode: { type: String, maxlength: 80 },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date },
}, { timestamps: true, strict: 'throw' });
callAttemptSchema.index({ requestId: 1, attempt: 1 }, { unique: true });
callAttemptSchema.index({ activeRequestId: 1 }, { unique: true, sparse: true });
callAttemptSchema.index({ providerReference: 1 }, { unique: true, sparse: true });

const inAppCallSchema = new Schema({
  requestId: { type: Schema.Types.ObjectId, ref: 'ProduceRequest', required: true, index: true },
  activeRequestId: { type: Schema.Types.ObjectId, select: false },
  roomName: { type: String, required: true, unique: true, maxlength: 100 },
  callerFarmerId: { type: Schema.Types.ObjectId, required: true },
  buyerId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['ringing', 'connected', 'ended', 'expired'], required: true, index: true },
  farmerJoinedAt: { type: Date },
  buyerJoinedAt: { type: Date },
  expiresAt: { type: Date, required: true },
  endedAt: { type: Date },
}, { timestamps: true, strict: 'throw' });
inAppCallSchema.index({ activeRequestId: 1 }, { unique: true, sparse: true });

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
export const ConsumerModel = mongoose.models.Consumer ?? mongoose.model('Consumer', consumerSchema);
export const ConsumerSessionModel = mongoose.models.ConsumerSession ?? mongoose.model('ConsumerSession', consumerSessionSchema);
export const PendingRegistrationModel = mongoose.models.PendingFarmerRegistration ?? mongoose.model('PendingFarmerRegistration', pendingRegistrationSchema);
export const OtpChallengeModel = mongoose.models.FarmerOtpChallenge ?? mongoose.model('FarmerOtpChallenge', otpChallengeSchema);
export const SessionModel = mongoose.models.FarmerSession ?? mongoose.model('FarmerSession', sessionSchema);
export const RateLimitModel = mongoose.models.FarmerRateLimit ?? mongoose.model('FarmerRateLimit', rateLimitSchema);
export const ProduceModel = mongoose.models.FarmerProduce ?? mongoose.model('FarmerProduce', produceSchema);
export const ProduceRequestModel = mongoose.models.ProduceRequest ?? mongoose.model('ProduceRequest', produceRequestSchema);
export const NotificationModel = mongoose.models.Notification ?? mongoose.model('Notification', notificationSchema);
export const PushTokenModel = mongoose.models.PushToken ?? mongoose.model('PushToken', pushTokenSchema);
export const CallAttemptModel = mongoose.models.CallAttempt ?? mongoose.model('CallAttempt', callAttemptSchema);
export const InAppCallModel = mongoose.models.InAppCall ?? mongoose.model('InAppCall', inAppCallSchema);
export const MarketPriceObservationModel = mongoose.models.MarketPriceObservation ?? mongoose.model('MarketPriceObservation', marketPriceObservationSchema);
