import { config } from '../config.js';

export type ExotelInitialStatus = 'queued' | 'initiated' | 'completed' | 'failed';
export type ExotelFailureCode = 'failed' | 'busy' | 'no-answer';

export class ExotelCallError extends Error {
  constructor(
    readonly code: 'provider_rejected' | 'provider_authentication_failed' | 'provider_request_invalid' | 'provider_rate_limited' | 'provider_unavailable' | 'response_invalid',
    readonly ambiguous: boolean,
    readonly diagnostic: { stage: string; httpStatus?: number; providerCode?: string; providerMessage?: string } = { stage: 'provider_request' },
  ) { super(code); }
}

function xmlValue(xml: string, name: string) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

function parseProviderBody(body: string, contentType: string): { data?: Record<string, unknown>; providerCode?: string; providerMessage?: string } {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    const exception = (record.RestException && typeof record.RestException === 'object' ? record.RestException : record) as Record<string, unknown>;
    return { data: record, providerCode: typeof exception.Code === 'string' || typeof exception.Code === 'number' ? String(exception.Code) : undefined, providerMessage: typeof exception.Message === 'string' ? exception.Message : undefined };
  } catch {
    if (!contentType.toLowerCase().includes('xml') && !body.trimStart().startsWith('<')) return {};
    const sid = xmlValue(body, 'Sid');
    const status = xmlValue(body, 'Status');
    const code = xmlValue(body, 'Code');
    const message = xmlValue(body, 'Message');
    return { data: sid || status ? { Call: { Sid: sid, Status: status } } : undefined, providerCode: code, providerMessage: message };
  }
}

function safeProviderText(value: string | undefined, secrets: string[]) {
  if (!value) return undefined;
  let safe = value.replace(/<[^>]*>/g, ' ').replace(/[+]?\d[\d\s().-]{5,}\d/g, '[redacted]');
  for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/[\r\n\t]+/g, ' ').slice(0, 240).trim() || undefined;
}

export function isExotelCallConfigured() {
  if (!config.EXOTEL_ACCOUNT_SID || !config.EXOTEL_API_KEY || !config.EXOTEL_API_TOKEN || !config.EXOTEL_CALLER_ID || !config.EXOTEL_STATUS_CALLBACK_URL) return false;
  return config.EXOTEL_STATUS_CALLBACK_URL.startsWith('https://');
}

export async function createExotelBridgedCall(input: {
  consumerPhone: string; farmerPhone: string; callAttemptId: string; callbackToken: string;
}): Promise<{ providerReference: string; status: ExotelInitialStatus; failureCode?: ExotelFailureCode }> {
  if (!isExotelCallConfigured()) throw new ExotelCallError('provider_unavailable', false);
  const host = config.EXOTEL_REGION === 'mumbai' ? 'api.in.exotel.com' : 'api.exotel.com';
  // Exotel's legacy Connect endpoint supports JSON responses with the .json suffix.
  const endpoint = `https://${host}/v1/Accounts/${encodeURIComponent(config.EXOTEL_ACCOUNT_SID!)}/Calls/connect.json`;
  const callbackBase = config.EXOTEL_STATUS_CALLBACK_URL!.replace(/\/$/, '');
  const callbackUrl = `${callbackBase}/api/provider/exotel/calls/${encodeURIComponent(input.callbackToken)}`;
  const parameters = new URLSearchParams({
    // Connect Two Numbers calls From first. The farmer explicitly starts this
    // action, so call the farmer first and bridge the buyer after they answer.
    From: input.farmerPhone,
    To: input.consumerPhone,
    CallerId: config.EXOTEL_CALLER_ID!,
    CallType: 'trans',
    StatusCallback: callbackUrl,
    StatusCallbackContentType: 'application/json',
    CustomField: input.callAttemptId,
  });
  // Exotel expects array members as indexed form fields, not a comma-delimited string.
  parameters.append('StatusCallbackEvents[0]', 'terminal');
  parameters.append('StatusCallbackEvents[1]', 'answered');
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.EXOTEL_API_KEY}:${config.EXOTEL_API_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      },
      body: parameters,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    // The provider may have accepted the request before the network failed.
    // Keep this attempt active so retries cannot create a duplicate call.
    throw new ExotelCallError('provider_unavailable', true, { stage: 'provider_network' });
  }
  const body = await response.text().catch(() => '');
  const parsed = parseProviderBody(body, response.headers.get('content-type') ?? '');
  const diagnostic = {
    stage: response.ok ? 'provider_response' : 'provider_rejection',
    httpStatus: response.status,
    providerCode: safeProviderText(parsed.providerCode, []),
    providerMessage: safeProviderText(parsed.providerMessage, [config.EXOTEL_ACCOUNT_SID!, config.EXOTEL_API_KEY!, config.EXOTEL_API_TOKEN!, config.EXOTEL_CALLER_ID!, input.consumerPhone, input.farmerPhone, input.callbackToken]),
  };
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'provider_authentication_failed'
      : response.status === 429 ? 'provider_rate_limited'
        : response.status >= 400 && response.status < 500 ? 'provider_request_invalid' : 'provider_rejected';
    throw new ExotelCallError(code, response.status >= 500, diagnostic);
  }
  const data = parsed.data as { Call?: { Sid?: unknown; Status?: unknown } } | undefined;
  const sid = data?.Call?.Sid;
  const status = data?.Call?.Status;
  if (typeof sid !== 'string' || !/^[\w-]{6,160}$/.test(sid) || typeof status !== 'string') {
    throw new ExotelCallError('response_invalid', true, { ...diagnostic, stage: 'response_parse' });
  }
  if (status === 'queued') return { providerReference: sid, status: 'queued' };
  if (status === 'in-progress') return { providerReference: sid, status: 'initiated' };
  if (status === 'completed') return { providerReference: sid, status: 'completed' };
  if (status === 'failed' || status === 'busy' || status === 'no-answer') return { providerReference: sid, status: 'failed', failureCode: status };
  throw new ExotelCallError('response_invalid', true, { ...diagnostic, stage: 'response_parse' });
}
