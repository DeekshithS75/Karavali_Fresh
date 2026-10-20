import { Types } from 'mongoose';
import { decryptSecretValue, hmac, randomToken } from '../crypto.js';
import { CallAttemptModel, ConsumerModel, FarmerModel, NotificationModel, ProduceRequestModel } from '../models/index.js';
import { createExotelBridgedCall, ExotelCallError, isExotelCallConfigured } from '../providers/calls.js';
import { normalizeIndianPhone } from '../providers/otp.js';
import { notificationCopy } from './notification-copy.js';
import { sendAccountPush } from './push-notifications.js';

export type CallStatus = 'not_started' | 'queued' | 'initiated' | 'failed' | 'completed' | 'unavailable';
export type CallFailureCode = 'provider_not_configured' | 'participant_unavailable' | 'participant_phone_invalid' | 'provider_rejected' | 'provider_unavailable' | 'response_invalid' | 'provider_response_unknown' | 'failed' | 'busy' | 'no-answer' | 'provider_failed';

type AcceptedRequest = { _id: Types.ObjectId; buyerId: Types.ObjectId; farmerId: Types.ObjectId; status: string };
type CallParticipant = { _id: Types.ObjectId; preferredLanguage?: 'en' | 'kn' | 'tcy'; phoneCiphertext?: string };

export async function latestRequestCallStatus(requestId: Types.ObjectId) {
  const attempt = await CallAttemptModel.findOne({ requestId }).sort({ attempt: -1 }).select('status failureCode providerReference').lean().exec() as {
    status: Exclude<CallStatus, 'not_started' | 'unavailable'>; failureCode?: string; providerReference?: string;
  } | null;
  if (!attempt) return { status: 'not_started' as const, confirmed: false, failureCode: null };
  if (attempt.status === 'failed' && attempt.failureCode === 'provider_not_configured') return { status: 'unavailable' as const, confirmed: false, failureCode: 'provider_not_configured' as const };
  return { status: attempt.status, confirmed: Boolean(attempt.providerReference), failureCode: (attempt.failureCode as CallFailureCode | undefined) ?? null };
}

export async function initiateAcceptedRequestCall(requestId: Types.ObjectId, farmerId: Types.ObjectId, allowRetry = false) {
  const request = await ProduceRequestModel.findOne({
    _id: requestId, status: 'accepted', farmerId,
  }).select('_id buyerId farmerId status').lean().exec() as AcceptedRequest | null;
  if (!request) return null;

  const active = await CallAttemptModel.findOne({ requestId, status: { $in: ['queued', 'initiated'] } })
    .select('status providerReference').lean().exec() as { status: 'queued' | 'initiated'; providerReference?: string } | null;
  if (active) return { status: active.status, confirmed: Boolean(active.providerReference) };

  const previous = await CallAttemptModel.findOne({ requestId }).sort({ attempt: -1 }).select('attempt status failureCode').lean().exec() as { attempt: number; status: string; failureCode?: string } | null;
  // A new call endpoint is idempotent after any attempt. Only the separate,
  // explicit retry action may create another attempt after a definite failure.
  if (previous && (!allowRetry || previous.status !== 'failed')) return latestRequestCallStatus(requestId);
  const attemptNumber = (previous?.attempt ?? 0) + 1;
  const callbackToken = randomToken(32);
  let attempt;
  try {
    [attempt] = await CallAttemptModel.create([{
      requestId, activeRequestId: requestId, attempt: attemptNumber, status: 'queued', callbackTokenHash: hmac(callbackToken), startedAt: new Date(),
    }]);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 11000) return latestRequestCallStatus(requestId);
    throw error;
  }
  if (!attempt) return { status: 'unavailable' as const, confirmed: false };

  if (!isExotelCallConfigured()) {
    const changed = await CallAttemptModel.updateOne({ _id: attempt._id, status: 'queued' }, { $set: { status: 'failed', failureCode: 'provider_not_configured', completedAt: new Date() }, $unset: { activeRequestId: 1 } }).exec();
    if (changed.modifiedCount) await notifyParticipants(request, 'call_failed', 'provider_not_configured');
    return { status: 'unavailable' as const, confirmed: false, failureCode: 'provider_not_configured' as const };
  }

  const [buyer, farmer] = await Promise.all([
    ConsumerModel.findOne({ _id: request.buyerId, accountStatus: 'active' }).select('+phoneCiphertext preferredLanguage').lean().exec() as Promise<CallParticipant | null>,
    FarmerModel.findOne({ _id: request.farmerId, accountStatus: 'active', phoneVerificationStatus: 'verified' }).select('phone preferredLanguage').lean().exec() as Promise<(CallParticipant & { phone?: string }) | null>,
  ]);
  let consumerPhone: string | null = null;
  if (buyer?.phoneCiphertext) {
    try { consumerPhone = normalizeIndianPhone(decryptSecretValue(buyer.phoneCiphertext)); }
    catch { consumerPhone = null; }
  }
  const farmerPhone = farmer?.phone ? normalizeIndianPhone(farmer.phone) : null;
  if (!consumerPhone || !farmerPhone) {
    const failureCode = buyer?.phoneCiphertext && farmer?.phone ? 'participant_phone_invalid' : 'participant_unavailable';
    const changed = await CallAttemptModel.updateOne({ _id: attempt._id, status: 'queued' }, { $set: { status: 'failed', failureCode, completedAt: new Date() }, $unset: { activeRequestId: 1 } }).exec();
    if (changed.modifiedCount) await notifyParticipants(request, 'call_failed', failureCode);
    return { status: 'failed' as const, confirmed: false, failureCode };
  }

  let result;
  try {
    result = await createExotelBridgedCall({
      consumerPhone, farmerPhone,
      callAttemptId: String(attempt._id), callbackToken,
    });
  } catch (error) {
    const ambiguous = error instanceof ExotelCallError && error.ambiguous;
    if (!ambiguous) {
      const failureCode = error instanceof ExotelCallError ? error.code : 'provider_unavailable';
      const changed = await CallAttemptModel.updateOne({ _id: attempt._id, status: 'queued' }, { $set: { status: 'failed', failureCode, completedAt: new Date() }, $unset: { activeRequestId: 1 } }).exec();
      if (changed.modifiedCount) await notifyParticipants(request, 'call_failed', failureCode);
      return { status: 'failed' as const, confirmed: false, failureCode: failureCode as CallFailureCode };
    }
    await CallAttemptModel.updateOne({ _id: attempt._id, status: 'queued' }, { $set: { failureCode: 'provider_response_unknown' } }).exec();
    return { status: 'queued' as const, confirmed: false, failureCode: 'provider_response_unknown' as const };
  }

  const nextStatus = result.status;
  const changed = await CallAttemptModel.updateOne({ _id: attempt._id, status: 'queued' }, {
    $set: { providerReference: result.providerReference, status: nextStatus, ...(result.failureCode ? { failureCode: result.failureCode } : {}), ...(nextStatus === 'failed' || nextStatus === 'completed' ? { completedAt: new Date() } : {}) },
    $unset: { ...(!result.failureCode ? { failureCode: 1 } : {}), ...(nextStatus === 'failed' || nextStatus === 'completed' ? { activeRequestId: 1 } : {}) },
  }).exec();
  const current = await CallAttemptModel.findById(attempt._id).select('status providerReference failureCode').lean().exec() as { status: 'queued' | 'initiated' | 'failed' | 'completed'; providerReference?: string; failureCode?: string } | null;
  if (changed.modifiedCount && current?.status === 'failed') await notifyParticipants(request, 'call_failed', current.failureCode ?? 'provider_failed');
  else if (changed.modifiedCount && current?.status === 'completed') await notifyParticipants(request, 'call_completed');
  else if (changed.modifiedCount && current?.status === 'initiated') await notifyParticipants(request, 'call_initiated');
  else if (changed.modifiedCount && current?.status === 'queued' && current.providerReference) await notifyParticipants(request, 'call_queued');
  return { status: current?.status ?? 'queued', confirmed: Boolean(current?.providerReference), failureCode: current?.failureCode as CallFailureCode | undefined ?? null };
}

export async function retryAcceptedRequestCall(requestId: Types.ObjectId, farmerId: Types.ObjectId) {
  const request = await ProduceRequestModel.findOne({ _id: requestId, farmerId, status: 'accepted' }).select('_id').lean().exec();
  if (!request) return null;
  const latest = await CallAttemptModel.findOne({ requestId }).sort({ attempt: -1 }).select('status').lean().exec() as { status: string } | null;
  if (!latest || latest.status !== 'failed') return { conflict: true as const, ...(await latestRequestCallStatus(requestId)) };
  return initiateAcceptedRequestCall(requestId, farmerId, true);
}

export async function applyExotelCallStatus(input: {
  token: string; callSid: string; status: string; eventType?: string; customField: string;
}) {
  const attempt = await CallAttemptModel.findOne({ callbackTokenHash: hmac(input.token) }).select('+callbackTokenHash requestId status providerReference').lean().exec() as {
    _id: Types.ObjectId; requestId: Types.ObjectId; status: string; providerReference?: string;
  } | null;
  if (!attempt || input.customField !== String(attempt._id)) return false;
  const mapped = input.eventType === 'answered' || input.status === 'in-progress' ? 'initiated'
    : input.status === 'completed' ? 'completed'
      : ['failed', 'busy', 'no-answer', 'canceled', 'cancelled'].includes(input.status) ? 'failed' : null;
  if (!mapped || (attempt.status !== 'queued' && attempt.status !== 'initiated')) return true;
  if (attempt.providerReference && attempt.providerReference !== input.callSid) return false;
  const failureCode = mapped === 'failed' ? input.status.replace(/[^a-z-]/g, '').slice(0, 40) || 'provider_failed' : undefined;
  const allowedStatuses = mapped === 'initiated' ? ['queued'] : ['queued', 'initiated'];
  const changed = await CallAttemptModel.updateOne({
    _id: attempt._id, status: { $in: allowedStatuses }, $or: [{ providerReference: { $exists: false } }, { providerReference: input.callSid }],
  }, { $set: { providerReference: input.callSid, status: mapped, ...(mapped === 'completed' || mapped === 'failed' ? { completedAt: new Date() } : {}), ...(failureCode ? { failureCode } : {}) }, ...(mapped === 'completed' || mapped === 'failed' ? { $unset: { activeRequestId: 1 } } : {}) }).exec();
  if (changed.modifiedCount) {
    const request = await ProduceRequestModel.findById(attempt.requestId).select('_id buyerId farmerId status').lean().exec() as AcceptedRequest | null;
    if (request) await notifyParticipants(request, mapped === 'initiated' ? 'call_initiated' : mapped === 'completed' ? 'call_completed' : 'call_failed', failureCode);
  }
  return true;
}

async function notifyParticipants(request: AcceptedRequest, event: 'call_queued' | 'call_initiated' | 'call_failed' | 'call_completed', failureCode?: string) {
  const [consumer, farmer] = await Promise.all([
    ConsumerModel.findById(request.buyerId).select('preferredLanguage').lean().exec() as Promise<{ preferredLanguage?: 'en' | 'kn' | 'tcy' } | null>,
    FarmerModel.findById(request.farmerId).select('preferredLanguage').lean().exec() as Promise<{ preferredLanguage?: 'en' | 'kn' | 'tcy' } | null>,
  ]);
  const recipients = [
    { role: 'consumer' as const, id: request.buyerId, language: consumer?.preferredLanguage },
    { role: 'farmer' as const, id: request.farmerId, language: farmer?.preferredLanguage },
  ];
  await Promise.all(recipients.map(async (recipient) => {
    const copy = notificationCopy(recipient.language, event, { failureCode });
    const [notice] = await NotificationModel.create([{
      recipientRole: recipient.role, recipientId: recipient.id, requestId: request._id, event,
    }]);
    void sendAccountPush(recipient.role, recipient.id, {
      ...copy, url: recipient.role === 'consumer' ? '/consumer?section=requests&requestId=' + request._id : '/farmer/requests?requestId=' + request._id,
      notificationId: String(notice!._id), requestId: String(request._id),
    });
  }));
}
