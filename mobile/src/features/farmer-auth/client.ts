import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreFarmerSession, revokeFarmerSession, type FarmerSessionState } from './session-lifecycle';

const SESSION_KEY = 'karavali-fresh.farmer.session.v1';
const API_BASE = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '');

type SessionTokens = { accessToken: string; refreshToken?: string };
type ApiErrorCode = 'unavailable' | 'apiUrlMissing' | 'urlNotAllowed' | 'testModeDisabled' | 'network' | 'unauthorized' | 'rejected' | 'exists' | 'documentMismatch' | 'documentUnreadable' | 'verificationNotConfigured' | 'verificationProviderFailure' | 'rateLimited' | 'ocrUnavailable' | 'farmerNotFound' | 'verificationExpired' | 'configurationIncomplete';
export class FarmerAuthError extends Error {
  constructor(readonly code: ApiErrorCode) { super(code); }
}

function apiUrl(path: string) {
  if (!API_BASE) throw new FarmerAuthError('apiUrlMissing');
  let parsed: URL;
  try { parsed = new URL(API_BASE); } catch { throw new FarmerAuthError('urlNotAllowed'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const privateLanHost = /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host);
  const isAllowedDevHttp = __DEV__ && parsed.protocol === 'http:' && (localHost || privateLanHost);
  if (parsed.protocol !== 'https:' && !isAllowedDevHttp) throw new FarmerAuthError('urlNotAllowed');
  return `${API_BASE}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = apiUrl(path);
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof FarmerAuthError) throw error;
    throw new FarmerAuthError('network');
  }
  if (!response.ok) {
    if (response.status === 401) throw new FarmerAuthError('unauthorized');
    if ([422, 429, 503, 404].includes(response.status)) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (body.error === 'document_mismatch') throw new FarmerAuthError('documentMismatch');
      if (body.error === 'document_unreadable') throw new FarmerAuthError('documentUnreadable');
      if (body.error === 'phone_verification_provider_not_configured') throw new FarmerAuthError('verificationNotConfigured');
      if (['verification_provider_unavailable', 'verification_provider_response_invalid', 'verification_request_unavailable', 'verification_credits_exhausted', 'verification_line_not_configured'].includes(body.error ?? '')) throw new FarmerAuthError('verificationProviderFailure');
      if (body.error === 'verification_expired') throw new FarmerAuthError('verificationExpired');
      if (body.error === 'rate_limit_exceeded' || body.error === 'verification_resend_too_soon') throw new FarmerAuthError('rateLimited');
      if (body.error === 'ocr_engine_not_configured') throw new FarmerAuthError('ocrUnavailable');
      if (body.error === 'farmer_not_found') throw new FarmerAuthError('farmerNotFound');
    }
    throw new FarmerAuthError(response.status === 404 || response.status === 503 ? 'unavailable' : response.status === 409 ? 'exists' : 'rejected');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function readTokens(): Promise<SessionTokens | null> {
  const stored = Platform.OS === 'web'
    ? await AsyncStorage.getItem(SESSION_KEY)
    : await SecureStore.getItemAsync(SESSION_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as SessionTokens;
    if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) return parsed;
    if (Platform.OS === 'web') await AsyncStorage.removeItem(SESSION_KEY);
    else await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  } catch {
    if (Platform.OS === 'web') await AsyncStorage.removeItem(SESSION_KEY);
    else await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function hasStoredFarmerSession() {
  return (await readTokens()) !== null;
}

async function saveTokens(tokens: SessionTokens) {
  const serialized = JSON.stringify(tokens);
  if (Platform.OS === 'web') await AsyncStorage.setItem(SESSION_KEY, serialized);
  else await SecureStore.setItemAsync(SESSION_KEY, serialized);
}

async function clearTokens() {
  if (Platform.OS === 'web') await AsyncStorage.removeItem(SESSION_KEY);
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export type FarmerCapabilities = {
  registrationEnabled: boolean;
  phoneVerificationEnabled: boolean;
  documentComparisonEnabled: boolean;
  ocrEngineConfigured: boolean;
  phoneVerificationConfigured: boolean;
  sessionSigningConfigured?: boolean;
  registrationEncryptionConfigured?: boolean;
  missingConfiguration: string[];
  ocrEngineName: string;
  privacyNoticeVersion: string | null;
  privacyNotice: Partial<Record<'en' | 'kn' | 'tcy', string>>;
};
export type FarmerRegistration = { fullName: string; age: string; gender: string; phone: string; aadhaar: string; address: string };
export type FarmerOcrTestInput = { fullName: string; dateOfBirth: string; gender: 'male' | 'female' | 'other'; address: string };
export type FarmerOcrTestResult = {
  status: 'match' | 'mismatch' | 'unreadable';
  extracted: { fullName: string | null; dateOfBirth: string | null; gender: 'male' | 'female' | 'other' | null; address: string | null };
  comparisons: Record<'fullName' | 'dateOfBirth' | 'gender' | 'address', 'match' | 'mismatch' | 'unreadable'>;
  issues?: string[];
};

/** Uses the existing registration URL in explicitly enabled development OCR-test mode. No auth token is sent. */
export async function runFarmerOcrTest(data: FarmerOcrTestInput, imageUri: string, imageType: string, imageName: string): Promise<FarmerOcrTestResult> {
  const body = new FormData();
  body.append('mode', 'ocr-test');
  body.append('fullName', data.fullName.trim());
  body.append('dateOfBirth', data.dateOfBirth);
  body.append('gender', data.gender);
  body.append('address', data.address.trim());
  if (Platform.OS === 'web') {
    let imageResponse: Response;
    try { imageResponse = await fetch(imageUri); } catch { throw new FarmerAuthError('rejected'); }
    if (!imageResponse.ok) throw new FarmerAuthError('rejected');
    body.append('document', await imageResponse.blob(), imageName || 'ocr-test-image');
  } else {
    body.append('document', { uri: imageUri, name: imageName || 'ocr-test-image', type: imageType } as never);
  }
  let response: Response;
  try { response = await fetch(apiUrl('/api/farmer/registrations'), { method: 'POST', body }); }
  catch (error) { if (error instanceof FarmerAuthError) throw error; throw new FarmerAuthError('network'); }
  const payload = await response.json().catch(() => null) as FarmerOcrTestResult | { error?: string } | null;
  if (payload && 'status' in payload && ['match', 'mismatch', 'unreadable'].includes(payload.status)) return payload as FarmerOcrTestResult;
  if (payload && 'error' in payload) {
    if (payload.error === 'route_not_found') throw new FarmerAuthError('testModeDisabled');
    if (payload.error === 'ocr_engine_not_configured' || payload.error === 'ocr_engine_unavailable') throw new FarmerAuthError('ocrUnavailable');
    if (payload.error === 'document_required' || payload.error === 'invalid_document') throw new FarmerAuthError('rejected');
  }
  throw new FarmerAuthError('rejected');
}

export async function getFarmerCapabilities() {
  return request<FarmerCapabilities>('/api/farmer/auth/capabilities');
}

export async function lookupFarmerAccount(phone: string) {
  return request<{ accountStatus: 'registered' | 'pending' | 'new'; verificationId?: string }>('/api/farmer/auth/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: `+91${phone.replace(/\D/g, '').slice(-10)}` }),
  });
}

export async function getFarmerSessionState(): Promise<FarmerSessionState> {
  const state = await restoreFarmerSession(
    readTokens,
    async (accessToken) => {
      const result = await request<{ valid: boolean }>('/api/farmer/auth/session', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return result.valid;
    },
    clearTokens,
    (error) => error instanceof FarmerAuthError && error.code === 'unauthorized',
    (error) => error instanceof FarmerAuthError && ['apiUrlMissing', 'urlNotAllowed'].includes(error.code),
  );
  return state;
}

export async function hasValidFarmerSession(): Promise<boolean> {
  return (await getFarmerSessionState()) === 'valid';
}

export async function submitFarmerRegistration(data: FarmerRegistration, imageUri: string, imageType: string, privacyNoticeVersion: string) {
  const body = new FormData();
  body.append('fullName', data.fullName);
  body.append('age', data.age);
  body.append('gender', data.gender);
  body.append('phone', `+91${data.phone.replace(/\D/g, '').slice(-10)}`);
  body.append('aadhaar', data.aadhaar);
  body.append('address', data.address);
  body.append('consent', 'true');
  body.append('phoneVerificationConsent', 'true');
  body.append('privacyNoticeVersion', privacyNoticeVersion);
  body.append('document', { uri: imageUri, name: 'identity-document', type: imageType } as never);
  const result = await request<{
    status: 'pending' | 'failed';
    documentComparison: 'pending' | 'passed' | 'failed';
    verificationId: string;
  }>('/api/farmer/registrations', { method: 'POST', body });
  if (!result.verificationId || !['pending', 'failed'].includes(result.status) ||
      !['pending', 'passed', 'failed'].includes(result.documentComparison)) {
    throw new FarmerAuthError('rejected');
  }
  return result;
}

export async function getVerificationStatus(verificationId: string) {
  return request<{
    status: 'pending' | 'failed';
    documentComparison: 'pending' | 'passed' | 'failed';
    phoneVerificationConsentRequired: boolean;
  }>(
    `/api/farmer/registrations/${encodeURIComponent(verificationId)}/verification`
  );
}

export type FarmerPhoneVerification = { challengeId: string; callNumber: string; instruction: string; expiresAt: string; status: 'pending' };
export type FarmerPhoneVerificationStatus = { status: 'pending' | 'verified' | 'expired' | 'cancelled'; expiresAt: string };

export async function consentForRegistrationPhoneVerification(verificationId: string) {
  return request<{ consented: true }>(`/api/farmer/registrations/${encodeURIComponent(verificationId)}/phone-verification-consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneVerificationConsent: 'true' }),
  });
}

export async function startFarmerRegistrationPhoneVerification(verificationId: string) {
  return request<FarmerPhoneVerification>(`/api/farmer/registrations/${encodeURIComponent(verificationId)}/phone-verification`, { method: 'POST' });
}

export async function startFarmerPhoneVerification(phone: string) {
  return request<FarmerPhoneVerification>('/api/farmer/auth/phone-verification', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: `+91${phone.replace(/\D/g, '').slice(-10)}`, phoneVerificationConsent: 'true' }),
  });
}

export async function getFarmerPhoneVerificationStatus(challengeId: string) {
  return request<FarmerPhoneVerificationStatus>(`/api/farmer/auth/phone-verification/${encodeURIComponent(challengeId)}/status`);
}

export async function cancelFarmerPhoneVerification(challengeId: string) {
  return request<{ status: 'cancelled' }>(`/api/farmer/auth/phone-verification/${encodeURIComponent(challengeId)}/cancel`, { method: 'POST' });
}

export async function completeFarmerPhoneVerification(challengeId: string) {
  const tokens = await request<SessionTokens>(`/api/farmer/auth/phone-verification/${encodeURIComponent(challengeId)}/complete`, { method: 'POST' });
  if (!tokens.accessToken) throw new FarmerAuthError('rejected');
  await saveTokens(tokens);
}

export async function logoutFarmer() {
  await revokeFarmerSession(readTokens, async (accessToken) => {
    try {
      await request('/api/farmer/auth/logout', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      if (!(error instanceof FarmerAuthError) || error.code !== 'unauthorized') throw error;
    }
  }, clearTokens);
}
