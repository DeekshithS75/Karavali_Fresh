import { config } from '../config.js';
import { ProviderNotConfiguredError } from './errors.js';

export type PhoneVerificationStatus = 'pending' | 'verified' | 'expired';
export type PhoneVerificationPurpose = 'farmer_login' | 'farmer_registration' | 'consumer_login' | 'consumer_registration';

export type NaCallerStartResult = {
  requestId: string;
  phone: string;
  callNumber: string;
  instruction: string;
  status: 'pending';
  expiresAt: Date;
};

export type NaCallerStatusResult = {
  requestId: string;
  phone: string;
  reference: string;
  status: PhoneVerificationStatus;
  verified: boolean;
  expiresAt: Date;
};

export interface PhoneVerificationProvider {
  start(phone: string, reference: string): Promise<NaCallerStartResult>;
  status(requestId: string): Promise<NaCallerStatusResult>;
}

export class NaCallerError extends Error {
  constructor(readonly code: 'invalid_phone' | 'credits_exhausted' | 'rate_limited' | 'line_not_configured' | 'request_not_found' | 'unavailable' | 'invalid_response') {
    super(code);
  }
}

type Fetcher = typeof fetch;
type ProviderPayload = Record<string, unknown>;
const API_BASE = 'https://api.nacaller.com/api/verify';

export class NaCallerMissOtpProvider implements PhoneVerificationProvider {
  constructor(private readonly apiKey: string, private readonly fetcher: Fetcher = fetch) {}

  async start(phone: string, reference: string): Promise<NaCallerStartResult> {
    const e164 = normalizeIndianPhone(phone);
    if (!e164 || reference.length > 120) throw new NaCallerError('invalid_phone');
    const payload = await this.call(`${API_BASE}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: e164, reference }),
    });
    const requestId = requiredText(payload.requestId, 160);
    const returnedPhone = normalizeProviderPhone(payload.phone);
    const callNumber = requiredText(payload.callNumber, 80);
    const instruction = requiredText(payload.instruction, 500);
    const expiresAt = parseDate(payload.expiresAt);
    if (!requestId || returnedPhone !== e164.slice(3) || !callNumber || !/^[+\d ()-]+$/.test(callNumber) || !instruction || !expiresAt || payload.status !== 'pending') {
      throw new NaCallerError('invalid_response');
    }
    return { requestId, phone: returnedPhone, callNumber, instruction, status: 'pending', expiresAt };
  }

  async status(requestId: string): Promise<NaCallerStatusResult> {
    if (!requestId || requestId.length > 160 || !/^[\w-]+$/.test(requestId)) throw new NaCallerError('request_not_found');
    const payload = await this.call(`${API_BASE}/status/${encodeURIComponent(requestId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const returnedId = requiredText(payload.requestId, 160);
    const phone = normalizeProviderPhone(payload.phone);
    const reference = requiredText(payload.reference, 120);
    const status = payload.status;
    const verified = payload.verified;
    const expiresAt = parseDate(payload.expiresAt);
    if (returnedId !== requestId || !phone || !reference || !expiresAt ||
        !['pending', 'verified', 'expired'].includes(String(status)) ||
        typeof verified !== 'boolean' || verified !== (status === 'verified')) {
      throw new NaCallerError('invalid_response');
    }
    return { requestId, phone, reference, status: status as PhoneVerificationStatus, verified, expiresAt };
  }

  private async call(url: string, init: RequestInit): Promise<ProviderPayload> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new NaCallerError('unavailable');
    }
    let payload: ProviderPayload;
    try {
      payload = await response.json() as ProviderPayload;
    } catch {
      throw new NaCallerError('invalid_response');
    }
    if (!response.ok) {
      if (response.status === 400) throw new NaCallerError('invalid_phone');
      if (response.status === 401) throw new NaCallerError('unavailable');
      if (response.status === 402) throw new NaCallerError('credits_exhausted');
      if (response.status === 404) throw new NaCallerError('request_not_found');
      if (response.status === 429) throw new NaCallerError('rate_limited');
      if (response.status === 503) throw new NaCallerError('line_not_configured');
      throw new NaCallerError('unavailable');
    }
    return payload;
  }
}

export function normalizeIndianPhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

function normalizeProviderPhone(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

function requiredText(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null;
}

function parseDate(value: unknown) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function isNaCallerConfigured() {
  return Boolean(config.NACALLER_KEY && config.NACALLER_KEY.length >= 16 && !config.NACALLER_KEY.startsWith('replace-'));
}

export function getPhoneVerificationProvider(): PhoneVerificationProvider {
  if (!isNaCallerConfigured()) throw new ProviderNotConfiguredError('otp');
  return new NaCallerMissOtpProvider(config.NACALLER_KEY!);
}
