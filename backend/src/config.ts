import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().optional(),
  MOBILE_ORIGIN: z.string().default('*'),
  TOKEN_HMAC_SECRET: z.string().optional(),
  PHONE_HASH_SECRET: z.string().optional(),
  AADHAAR_HASH_SECRET: z.string().optional(),
  AADHAAR_ENCRYPTION_KEY_BASE64: z.string().optional(),
  NACALLER_KEY: z.string().optional(),
  DATA_GOV_IN_API_KEY: z.string().optional(),
  MARKET_PRICE_FRESHNESS_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  PRIVACY_NOTICE_VERSION: z.string().default('farmer-registration-phone-v2'),
  PRIVACY_NOTICE_EN: z.string().default('Your details and document are processed for farmer registration and document comparison. OCR is not proof of identity; control of the supplied phone number is checked separately through a missed call.'),
  PRIVACY_NOTICE_KN: z.string().default('ರೈತರ ನೋಂದಣಿ ಮತ್ತು ದಾಖಲೆ ಹೋಲಿಕೆಗಾಗಿ ನಿಮ್ಮ ವಿವರಗಳನ್ನು ಸಂಸ್ಕರಿಸಲಾಗುತ್ತದೆ. OCR ಗುರುತಿನ ಪುರಾವೆಯಲ್ಲ; ನೀಡಿದ ಫೋನ್ ಸಂಖ್ಯೆಯ ಬಳಕೆಯನ್ನು ಮಿಸ್ಡ್ ಕಾಲ್ ಮೂಲಕ ಪ್ರತ್ಯೇಕವಾಗಿ ಪರಿಶೀಲಿಸಲಾಗುತ್ತದೆ.'),
  PRIVACY_NOTICE_TCY: z.string().optional(),
  PHONE_VERIFICATION_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  PHONE_VERIFICATION_RESEND_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
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
      ['PHONE_HASH_SECRET', config.PHONE_HASH_SECRET],
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
}

const usableSecret = (value: string | undefined) => Boolean(value && value.length >= 32 && !value.startsWith('replace-'));
export const isPhoneVerificationConfigured = () => Boolean(config.NACALLER_KEY && config.NACALLER_KEY.length >= 16 && !config.NACALLER_KEY.startsWith('replace-') && usableSecret(config.PHONE_HASH_SECRET));
export const areSessionSecretsConfigured = () => usableSecret(config.TOKEN_HMAC_SECRET);
export const isRegistrationEncryptionConfigured = () => Boolean(config.AADHAAR_ENCRYPTION_KEY_BASE64 && Buffer.from(config.AADHAAR_ENCRYPTION_KEY_BASE64, 'base64').length === 32 && usableSecret(config.AADHAAR_HASH_SECRET));
