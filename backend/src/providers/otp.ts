import { config, isOtpConfigured } from '../config.js';
import { ProviderNotConfiguredError } from './errors.js';

export interface OtpDeliveryProvider {
  send(phone: string, code: string, purpose: 'farmer_login' | 'farmer_registration'): Promise<void>;
}

export class HttpOtpDeliveryProvider implements OtpDeliveryProvider {
  async send(phone: string, code: string, purpose: 'farmer_login' | 'farmer_registration') {
    let response: Response;
    try {
      response = await fetch(config.OTP_DELIVERY_URL!, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.OTP_DELIVERY_API_KEY!}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code, purpose }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('otp_provider_unavailable');
    }
    if (!response.ok) throw new Error('otp_provider_unavailable');
  }
}

export function getOtpProvider(): OtpDeliveryProvider {
  if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
  return new HttpOtpDeliveryProvider();
}
