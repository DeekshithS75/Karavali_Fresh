import { config } from '../config.js';

export type ExotelInitialStatus = 'queued' | 'initiated' | 'completed' | 'failed';
export type ExotelFailureCode = 'failed' | 'busy' | 'no-answer';

export class ExotelCallError extends Error {
  constructor(readonly code: 'provider_rejected' | 'provider_unavailable' | 'response_invalid', readonly ambiguous: boolean) { super(code); }
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
  const endpoint = `https://${host}/v1/Accounts/${encodeURIComponent(config.EXOTEL_ACCOUNT_SID!)}/Calls/connect`;
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
    StatusCallbackEvents: 'terminal,answered',
    StatusCallbackContentType: 'application/json',
    CustomField: input.callAttemptId,
  });
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
    throw new ExotelCallError('provider_unavailable', true);
  }
  if (!response.ok) throw new ExotelCallError('provider_rejected', response.status >= 500);
  let data: { Call?: { Sid?: unknown; Status?: unknown } };
  try { data = await response.json() as typeof data; }
  catch { throw new ExotelCallError('response_invalid', true); }
  const sid = data.Call?.Sid;
  const status = data.Call?.Status;
  if (typeof sid !== 'string' || !/^[\w-]{6,160}$/.test(sid) || typeof status !== 'string') {
    throw new ExotelCallError('response_invalid', true);
  }
  if (status === 'queued') return { providerReference: sid, status: 'queued' };
  if (status === 'in-progress') return { providerReference: sid, status: 'initiated' };
  if (status === 'completed') return { providerReference: sid, status: 'completed' };
  if (status === 'failed' || status === 'busy' || status === 'no-answer') return { providerReference: sid, status: 'failed', failureCode: status };
  throw new ExotelCallError('response_invalid', true);
}
