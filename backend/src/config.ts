import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().optional(),
  MOBILE_ORIGIN: z.string().default('*'),
  TOKEN_HMAC_SECRET: z.string().optional(),
  OTP_HMAC_SECRET: z.string().optional(),
  AADHAAR_HASH_SECRET: z.string().optional(),
  AADHAAR_ENCRYPTION_KEY_BASE64: z.string().optional(),
  OTP_DELIVERY_URL: z.string().optional(),
  OTP_DELIVERY_API_KEY: z.string().optional(),
  OCR_TEST_MODE_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  PRIVACY_NOTICE_VERSION: z.string().default('farmer-registration-v1'),
  PRIVACY_NOTICE_EN: z.string().default('Your details and document are processed for farmer registration and document comparison. OCR is not proof of identity; phone ownership is checked separately by OTP.'),
  PRIVACY_NOTICE_KN: z.string().default('ರೈತರ ನೋಂದಣಿ ಮತ್ತು ದಾಖಲೆ ಹೋಲಿಕೆಗಾಗಿ ನಿಮ್ಮ ವಿವರಗಳನ್ನು ಸಂಸ್ಕರಿಸಲಾಗುತ್ತದೆ. OCR ಗುರುತಿನ ಪುರಾವೆಯಲ್ಲ; OTP ಮೂಲಕ ಫೋನ್ ಬಳಕೆಯನ್ನು ಪ್ರತ್ಯೇಕವಾಗಿ ಪರಿಶೀಲಿಸಲಾಗುತ್ತದೆ.'),
  PRIVACY_NOTICE_TCY: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  OTP_RESEND_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(60 * 60 * 24 * 90).default(60 * 60 * 24 * 30),
  REGISTRATION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(24),
});

export const config = schema.parse(process.env);

export function validateRuntimeConfig() {
  if (config.NODE_ENV === 'production') {
    if (!config.MONGODB_URI) throw new Error('MONGODB_URI is required in production');
    if (config.MOBILE_ORIGIN === '*') throw new Error('MOBILE_ORIGIN must be restricted in production');
    for (const [name, value] of [
      ['TOKEN_HMAC_SECRET', config.TOKEN_HMAC_SECRET],
      ['OTP_HMAC_SECRET', config.OTP_HMAC_SECRET],
      ['AADHAAR_HASH_SECRET', config.AADHAAR_HASH_SECRET],
      ['AADHAAR_ENCRYPTION_KEY_BASE64', config.AADHAAR_ENCRYPTION_KEY_BASE64],
    ] as const) {
      if (!value || value.length < 32) throw new Error(`${name} must be configured with a strong secret in production`);
    }
  }
  if (config.AADHAAR_ENCRYPTION_KEY_BASE64) {
    const key = Buffer.from(config.AADHAAR_ENCRYPTION_KEY_BASE64, 'base64');
    if (key.length !== 32) throw new Error('AADHAAR_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  }
  for (const url of [config.OTP_DELIVERY_URL]) {
    if (url && new URL(url).protocol !== 'https:' && config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
      throw new Error('Provider URLs must use HTTPS');
    }
  }
}

const usableSecret = (value: string | undefined) => Boolean(value && value.length >= 32 && !value.startsWith('replace-'));
export const isOtpConfigured = () => Boolean(config.OTP_DELIVERY_URL && config.OTP_DELIVERY_API_KEY && usableSecret(config.OTP_HMAC_SECRET));
export const areSessionSecretsConfigured = () => usableSecret(config.TOKEN_HMAC_SECRET);
export const isRegistrationEncryptionConfigured = () => Boolean(config.AADHAAR_ENCRYPTION_KEY_BASE64 && Buffer.from(config.AADHAAR_ENCRYPTION_KEY_BASE64, 'base64').length === 32 && usableSecret(config.AADHAAR_HASH_SECRET));
