import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { areSessionSecretsConfigured, config } from '../config.js';
import { hmac, randomToken } from '../crypto.js';
import { ConsumerModel, ConsumerSessionModel } from '../models/index.js';
import { ApiError } from './security.js';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_BYTES = 64;

function derivePassword(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, HASH_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export async function hashConsumerPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyConsumerPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltEncoded, hashEncoded] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== String(SCRYPT_N) || r !== String(SCRYPT_R) || p !== String(SCRYPT_P) || !saltEncoded || !hashEncoded) return false;
  const salt = Buffer.from(saltEncoded, 'base64url');
  const expected = Buffer.from(hashEncoded, 'base64url');
  if (salt.length !== 16 || expected.length !== HASH_BYTES) return false;
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}

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
  const consumer = await ConsumerModel.findOne({ _id: session.consumerId, accountStatus: 'active' }).select('fullName email accountStatus').exec();
  if (!consumer) throw new ApiError(401, 'invalid_session');
  return { session, consumer };
}
