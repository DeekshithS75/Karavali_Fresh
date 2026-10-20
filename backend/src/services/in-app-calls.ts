import { Types } from 'mongoose';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config.js';
import { InAppCallModel, ProduceRequestModel } from '../models/index.js';
import { randomToken } from '../crypto.js';
import { ApiError } from './security.js';
import { sendAccountPush } from './push-notifications.js';

type CallRequest = { _id: Types.ObjectId; farmerId: Types.ObjectId; buyerId: Types.ObjectId; status: string };
type CallSession = { _id: Types.ObjectId; requestId: Types.ObjectId; roomName: string; callerFarmerId: Types.ObjectId; buyerId: Types.ObjectId; status: 'ringing' | 'connected' | 'ended' | 'expired'; expiresAt: Date; farmerJoinedAt?: Date; buyerJoinedAt?: Date };
type CallRole = 'farmer' | 'consumer';

export function isLiveKitConfigured() {
  return Boolean(config.LIVEKIT_URL?.startsWith('wss://') && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET);
}

export async function startAcceptedInAppCall(requestId: Types.ObjectId, farmerId: Types.ObjectId) {
  const request = await ProduceRequestModel.findOne({ _id: requestId, farmerId, status: 'accepted' }).select('_id farmerId buyerId status').lean().exec() as CallRequest | null;
  if (!request) return null;
  if (!isLiveKitConfigured()) throw new ApiError(503, 'in_app_call_not_configured');

  const existing = await InAppCallModel.findOne({ requestId, activeRequestId: requestId }).select('_id status expiresAt').lean().exec() as Pick<CallSession, '_id' | 'status' | 'expiresAt'> | null;
  if (existing && existing.expiresAt.getTime() > Date.now() && ['ringing', 'connected'].includes(existing.status)) return { sessionId: String(existing._id), status: existing.status };
  if (existing) await InAppCallModel.updateOne({ _id: existing._id, activeRequestId: requestId }, { $set: { status: 'expired', endedAt: new Date() }, $unset: { activeRequestId: 1 } }).exec();

  const expiresAt = new Date(Date.now() + 2 * 60_000);
  let session;
  try {
    [session] = await InAppCallModel.create([{
      requestId, activeRequestId: requestId, roomName: `kf-${randomToken(18)}`,
      callerFarmerId: farmerId, buyerId: request.buyerId, status: 'ringing', expiresAt,
    }]);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 11000) {
      const active = await InAppCallModel.findOne({ activeRequestId: requestId }).select('_id status').lean().exec() as { _id: Types.ObjectId; status: string } | null;
      if (active) return { sessionId: String(active._id), status: active.status };
    }
    throw error;
  }
  if (!session) throw new ApiError(503, 'in_app_call_unavailable');
  const sessionId = String(session._id);
  void sendAccountPush('consumer', request.buyerId, {
    title: 'Incoming private call', body: 'A farmer is ready to speak about your accepted produce request.',
    url: `/call?sessionId=${encodeURIComponent(sessionId)}&role=consumer`, notificationId: sessionId,
    requestId: String(requestId), callSessionId: sessionId,
  });
  return { sessionId, status: 'ringing' as const };
}

export async function joinInAppCall(sessionId: Types.ObjectId, role: CallRole, accountId: Types.ObjectId) {
  if (!isLiveKitConfigured()) throw new ApiError(503, 'in_app_call_not_configured');
  const memberFilter = role === 'farmer' ? { callerFarmerId: accountId } : { buyerId: accountId };
  const session = await InAppCallModel.findOne({ _id: sessionId, ...memberFilter }).lean().exec() as CallSession | null;
  if (!session) throw new ApiError(404, 'in_app_call_not_found');
  if (session.expiresAt.getTime() <= Date.now() || !['ringing', 'connected'].includes(session.status)) {
    await endInAppCall(session._id, 'expired');
    throw new ApiError(410, 'in_app_call_expired');
  }
  const produceRequest = await ProduceRequestModel.findOne({ _id: session.requestId, status: 'accepted' }).select('_id').lean().exec();
  if (!produceRequest) throw new ApiError(410, 'in_app_call_request_unavailable');

  const now = new Date();
  const joinedField = role === 'farmer' ? 'farmerJoinedAt' : 'buyerJoinedAt';
  await InAppCallModel.updateOne({ _id: session._id, status: { $in: ['ringing', 'connected'] } }, { $set: { [joinedField]: now } }).exec();
  const latest = await InAppCallModel.findById(session._id).lean().exec() as CallSession | null;
  if (!latest || !['ringing', 'connected'].includes(latest.status)) throw new ApiError(410, 'in_app_call_ended');
  if (latest.farmerJoinedAt && latest.buyerJoinedAt && latest.status !== 'connected') {
    const expiresAt = new Date(Date.now() + 3 * 60 * 60_000);
    await InAppCallModel.updateOne({ _id: latest._id, status: 'ringing' }, { $set: { status: 'connected', expiresAt } }).exec();
    latest.status = 'connected';
    latest.expiresAt = expiresAt;
  }

  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: `${role}-${String(accountId)}`, ttl: '5m',
  });
  token.addGrant({ roomJoin: true, room: latest.roomName, canPublish: true, canSubscribe: true });
  return { serverUrl: config.LIVEKIT_URL, participantToken: await token.toJwt(), status: latest.status };
}

export async function endMemberInAppCall(sessionId: Types.ObjectId, role: CallRole, accountId: Types.ObjectId) {
  const memberFilter = role === 'farmer' ? { callerFarmerId: accountId } : { buyerId: accountId };
  const session = await InAppCallModel.findOne({ _id: sessionId, ...memberFilter }).select('_id roomName').lean().exec() as Pick<CallSession, '_id' | 'roomName'> | null;
  if (!session) throw new ApiError(404, 'in_app_call_not_found');
  await endInAppCall(session._id, 'ended');
  if (isLiveKitConfigured()) {
    try {
      const service = new RoomServiceClient(config.LIVEKIT_URL!.replace(/^wss:/, 'https:'), config.LIVEKIT_API_KEY!, config.LIVEKIT_API_SECRET!);
      await service.deleteRoom(session.roomName);
    } catch { /* Database state prevents new tokens; connected clients still have a local hang-up action. */ }
  }
  return { status: 'ended' as const };
}

async function endInAppCall(sessionId: Types.ObjectId, status: 'ended' | 'expired') {
  await InAppCallModel.updateOne({ _id: sessionId, status: { $in: ['ringing', 'connected'] } }, { $set: { status, endedAt: new Date() }, $unset: { activeRequestId: 1 } }).exec();
}
