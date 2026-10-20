import { Types } from 'mongoose';
import { areSessionSecretsConfigured, config } from '../config.js';
import { hmac, randomToken } from '../crypto.js';
import { ConsumerModel, ConsumerSessionModel } from '../models/index.js';
import { ApiError } from './security.js';

export async function createConsumerSession(consumerId: Types.ObjectId) {
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  const accessToken = randomToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);
  await ConsumerSessionModel.create({ consumerId, tokenHash: hmac(accessToken), expiresAt, revokedAt: null });
  return { accessToken, expiresAt: expiresAt.toISOString() };
}

export async function findAuthenticatedConsumerSession(authorization: string | undefined) {
  if (!areSessionSecretsConfigured()) throw new ApiError(503, 'session_signing_not_configured');
  if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'authentication_required');
  const rawToken = authorization.slice(7);
  if (rawToken.length < 32 || rawToken.length > 256) throw new ApiError(401, 'invalid_session');
  const session = await ConsumerSessionModel.findOne({ tokenHash: hmac(rawToken), revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!session) throw new ApiError(401, 'invalid_session');
  return session;
}

export async function findAuthenticatedConsumer(authorization: string | undefined) {
  const session = await findAuthenticatedConsumerSession(authorization);
  const consumer = await ConsumerModel.findOne({ _id: session.consumerId, accountStatus: 'active' }).select('fullName preferredLanguage accountStatus').exec();
  if (!consumer) throw new ApiError(401, 'invalid_session');
  return { session, consumer };
}
