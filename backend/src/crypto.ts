import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

function secret(value: string | undefined, name: string): Buffer {
  if (!value || value.length < 32) throw new Error(`${name} is not configured`);
  return Buffer.from(value);
}

export function hmac(value: string, secretValue = config.TOKEN_HMAC_SECRET): string {
  return createHmac('sha256', secret(secretValue, 'TOKEN_HMAC_SECRET')).update(value).digest('hex');
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function randomToken(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }

export function encryptSecretValue(value: string): string {
  const key = Buffer.from(config.AADHAAR_ENCRYPTION_KEY_BASE64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('AADHAAR_ENCRYPTION_KEY_BASE64 is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString('base64url')).join('.');
}

export function decryptSecretValue(value: string): string {
  const key = Buffer.from(config.AADHAAR_ENCRYPTION_KEY_BASE64 ?? '', 'base64');
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export const hashOtp = (code: string) => hmac(code, config.OTP_HMAC_SECRET);
export const hashAadhaar = (number: string) => hmac(number, config.AADHAAR_HASH_SECRET);
