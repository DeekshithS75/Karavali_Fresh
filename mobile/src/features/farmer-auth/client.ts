import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreFarmerSession, revokeFarmerSession, type FarmerSessionState } from './session-lifecycle';
import { createFarmerSessionStorage, type SessionTokens } from './session-storage';
import { appendRegistrationDocument } from './document-upload';

const API_BASE = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '');

type ApiErrorCode = 'unavailable' | 'apiUrlMissing' | 'urlNotAllowed' | 'network' | 'unauthorized' | 'rejected' | 'exists' | 'documentRequired' | 'invalidDocument' | 'documentMismatch' | 'documentUnreadable' | 'documentFieldsMissing' | 'verificationNotConfigured' | 'verificationProviderFailure' | 'rateLimited' | 'ocrUnavailable' | 'farmerNotFound' | 'profileNotFound' | 'verificationExpired' | 'configurationIncomplete' | 'privacyNoticeOutdated' | 'validationFailed' | 'producePhotoCount' | 'producePhotoTooLarge' | 'produceImageInvalid' | 'produceStorageUnavailable';
export type FarmerDocumentField = 'name' | 'age' | 'gender' | 'aadhaar' | 'address' | 'date_of_birth';

const farmerDocumentFields: FarmerDocumentField[] = ['name', 'age', 'gender', 'aadhaar', 'address', 'date_of_birth'];

export class FarmerAuthError extends Error {
  constructor(readonly code: ApiErrorCode, readonly fields: FarmerDocumentField[] = [], readonly suggestedFullName: string | null = null) { super(code); }
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
    const body = await response.json().catch(() => ({})) as { error?: string; issues?: string[]; fields?: string[]; missingFields?: string[]; suggestedFullName?: string };
    if ([400, 404, 409, 422, 429, 503].includes(response.status)) {
      const mismatchedFields = body.fields?.filter((field): field is FarmerDocumentField => farmerDocumentFields.includes(field as FarmerDocumentField)) ?? [];
      const missingFields = body.missingFields?.filter((field): field is FarmerDocumentField => farmerDocumentFields.includes(field as FarmerDocumentField)) ?? [];
      if (body.error === 'document_mismatch') {
        const suggestedFullName = mismatchedFields.includes('name') && typeof body.suggestedFullName === 'string'
          ? body.suggestedFullName.trim().slice(0, 120) || null
          : null;
        throw new FarmerAuthError('documentMismatch', mismatchedFields, suggestedFullName);
      }
      if (body.error === 'document_unreadable') throw new FarmerAuthError(body.issues?.includes('required_fields_missing') || missingFields.length ? 'documentFieldsMissing' : 'documentUnreadable', missingFields);
      if (body.error === 'document_required') throw new FarmerAuthError('documentRequired');
      if (body.error === 'invalid_document') throw new FarmerAuthError('invalidDocument');
      if (body.error === 'phone_verification_provider_not_configured') throw new FarmerAuthError('verificationNotConfigured');
      if (['verification_provider_unavailable', 'verification_provider_response_invalid', 'verification_request_unavailable', 'verification_credits_exhausted', 'verification_line_not_configured'].includes(body.error ?? '')) throw new FarmerAuthError('verificationProviderFailure');
      if (body.error === 'verification_expired') throw new FarmerAuthError('verificationExpired');
      if (body.error === 'rate_limit_exceeded' || body.error === 'verification_resend_too_soon') throw new FarmerAuthError('rateLimited');
      if (body.error === 'ocr_engine_not_configured') throw new FarmerAuthError('ocrUnavailable');
      if (body.error === 'farmer_not_found') throw new FarmerAuthError(path === '/api/farmer/profile' ? 'profileNotFound' : 'farmerNotFound');
      if (body.error === 'registration_encryption_not_configured' || body.error === 'session_signing_not_configured') throw new FarmerAuthError('configurationIncomplete');
      if (body.error === 'privacy_notice_version_mismatch') throw new FarmerAuthError('privacyNoticeOutdated');
      if (body.error === 'validation_failed') throw new FarmerAuthError('validationFailed');
      if (body.error === 'produce_photo_count_invalid' || body.error === 'too_many_produce_images') throw new FarmerAuthError('producePhotoCount');
      if (body.error === 'produce_image_too_large') throw new FarmerAuthError('producePhotoTooLarge');
      if (body.error === 'invalid_produce_image' || body.error === 'invalid_produce_upload') throw new FarmerAuthError('produceImageInvalid');
      if (body.error === 'produce_image_storage_not_configured' || body.error === 'produce_image_storage_failed') throw new FarmerAuthError('produceStorageUnavailable');
    }
    throw new FarmerAuthError(response.status === 404 || response.status === 503 ? 'unavailable' : response.status === 409 ? 'exists' : 'rejected');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const sessionStorage = createFarmerSessionStorage(Platform.OS === 'web'
  ? AsyncStorage
  : {
    getItem: (key: string) => SecureStore.getItemAsync(key),
    setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
    removeItem: (key: string) => SecureStore.deleteItemAsync(key),
  });

const readTokens = () => sessionStorage.read();

export async function hasStoredFarmerSession() {
  return (await readTokens()) !== null;
}

const saveTokens = (tokens: SessionTokens) => sessionStorage.save(tokens);
const clearTokens = () => sessionStorage.clear();

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

export type FarmerProfile = { fullName: string };

export type FarmerProduce = {
  id: string;
  name: string;
  quantity: number;
  unit: 'kg' | 'quintal' | 'bunch' | 'pieces';
  status: 'awaiting_price';
  photos: { url: string; mimeType: string; size: number; headers: { Authorization: string } }[];
  createdAt: string;
  updatedAt: string;
};

export async function getFarmerProduce(signal?: AbortSignal): Promise<FarmerProduce[]> {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const result = await request<{ items: (Omit<FarmerProduce, 'photos'> & { photos: Omit<FarmerProduce['photos'][number], 'headers'>[] })[] }>('/api/farmer/produce', {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal,
  });
  if (!Array.isArray(result.items)) throw new FarmerAuthError('rejected');
  return result.items.map((item) => ({
    ...item,
    photos: item.photos.map((photo) => ({ ...photo, url: apiUrl(photo.url), headers: { Authorization: `Bearer ${tokens.accessToken}` } })),
  }));
}

export async function createFarmerProduce(input: { name: string; quantity: string; unit: FarmerProduce['unit']; photos: { uri: string; mimeType?: string; fileSize?: number }[] }, submissionId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const body = new FormData();
  body.append('name', input.name.trim());
  body.append('quantity', input.quantity);
  body.append('unit', input.unit);
  for (const [index, photo] of input.photos.entries()) {
    const mimeType = photo.mimeType && ['image/jpeg', 'image/png', 'image/webp'].includes(photo.mimeType) ? photo.mimeType : 'image/jpeg';
    if (Platform.OS === 'web') {
      const response = await fetch(photo.uri);
      if (!response.ok) throw new FarmerAuthError('invalidDocument');
      const blob = await response.blob();
      if (blob.size > 8 * 1024 * 1024 || blob.type !== mimeType) throw new FarmerAuthError('invalidDocument');
      body.append('photos', blob, `produce-${index + 1}.${mimeType.split('/')[1]}`);
    } else {
      body.append('photos', { uri: photo.uri, name: `produce-${index + 1}.${mimeType.split('/')[1]}`, type: mimeType } as never);
    }
  }
  const result = await request<{ item: FarmerProduce }>('/api/farmer/produce', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Idempotency-Key': submissionId },
    body,
  });
  return result.item;
}

export async function getFarmerProfile(signal?: AbortSignal): Promise<FarmerProfile> {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const result = await request<{ profile: FarmerProfile }>('/api/farmer/profile', {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    signal,
  });
  if (!result?.profile || typeof result.profile.fullName !== 'string' || !result.profile.fullName.trim()) {
    throw new FarmerAuthError('rejected');
  }
  return { fullName: result.profile.fullName };
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
  try { await appendRegistrationDocument(body, imageUri, imageType, Platform.OS === 'web' ? 'web' : 'native'); }
  catch { throw new FarmerAuthError('invalidDocument'); }
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
