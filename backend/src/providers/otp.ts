import { config, isOtpConfigured } from '../config.js';
import { ProviderNotConfiguredError } from './errors.js';

export type OtpPurpose = 'farmer_login' | 'farmer_registration';

export interface OtpDeliveryProvider {
  send(phone: string, purpose: OtpPurpose): Promise<{ providerReference?: string }>;
  verify(phone: string, code: string): Promise<boolean>;
}

type Fetcher = typeof fetch;
type Msg91Response = { type?: unknown; message?: unknown; request_id?: unknown; requestId?: unknown };

/** MSG91 credentials and OTPs stay on the server. Phone is supplied in E.164 and sent to MSG91 without '+'. */
export class Msg91OtpProvider implements OtpDeliveryProvider {
  constructor(
    private readonly authKey: string,
    private readonly templates: Record<OtpPurpose, string>,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async send(phone: string, purpose: OtpPurpose) {
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', this.templates[purpose]);
    url.searchParams.set('mobile', msg91Mobile(phone));
    const payload = await this.call(url, { method: 'POST', body: '{}' });
    if (String(payload.type ?? '').toLowerCase() !== 'success') throw new Error('otp_provider_unavailable');
    const reference = payload.request_id ?? payload.requestId;
    return typeof reference === 'string' ? { providerReference: reference.slice(0, 120) } : {};
  }

  async verify(phone: string, code: string) {
    const url = new URL('https://control.msg91.com/api/v5/otp/verify');
    url.searchParams.set('mobile', msg91Mobile(phone));
    url.searchParams.set('otp', code);
    const payload = await this.call(url, { method: 'GET' });
    return String(payload.message ?? '').trim().toLowerCase() === 'otp verified success' ||
      String(payload.type ?? '').toLowerCase() === 'success';
  }

  private async call(url: URL, init: { method: 'POST' | 'GET'; body?: string }): Promise<Msg91Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: init.method,
        headers: { authkey: this.authKey, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('otp_provider_unavailable');
    }
    if (!response.ok) throw new Error('otp_provider_unavailable');
    try {
      const payload = await response.json() as Msg91Response;
      if (!payload || typeof payload !== 'object') throw new Error('invalid_response');
      return payload;
    } catch {
      throw new Error('otp_provider_unavailable');
    }
  }
}

function msg91Mobile(phone: string) {
  if (!/^\+91[6-9]\d{9}$/.test(phone)) throw new Error('invalid_phone');
  return phone.slice(1);
}

export function getOtpProvider(): OtpDeliveryProvider {
  if (!isOtpConfigured()) throw new ProviderNotConfiguredError('otp');
  return new Msg91OtpProvider(config.MSG91_AUTH_KEY!, {
    farmer_registration: config.MSG91_REGISTRATION_TEMPLATE_ID!,
    farmer_login: config.MSG91_LOGIN_TEMPLATE_ID!,
  });
}
