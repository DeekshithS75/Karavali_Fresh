import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreFarmerSession, revokeFarmerSession, type FarmerSessionState } from './session-lifecycle';
import { createFarmerSessionStorage, type SessionTokens } from './session-storage';
import { appendRegistrationDocument } from './document-upload';
import { getApiBase } from '../api-base';

const API_BASE = getApiBase();

type ApiErrorCode = 'unavailable' | 'apiUrlMissing' | 'urlNotAllowed' | 'network' | 'unauthorized' | 'rejected' | 'exists' | 'documentRequired' | 'invalidDocument' | 'documentMismatch' | 'documentUnreadable' | 'documentFieldsMissing' | 'verificationNotConfigured' | 'verificationProviderFailure' | 'verificationInProgress' | 'rateLimited' | 'ocrUnavailable' | 'farmerNotFound' | 'profileNotFound' | 'verificationExpired' | 'configurationIncomplete' | 'privacyNoticeOutdated' | 'validationFailed' | 'produceRequestRejected' | 'producePhotoCount' | 'producePhotoTooLarge' | 'produceImageInvalid' | 'produceStorageUnavailable' | 'produceStorageUploadFailed' | 'producePriceInvalid' | 'produceNotFound' | 'produceDeleteCleanupFailed' | 'producePriceAlreadySet' | 'marketPriceUnavailable' | 'marketPriceNotConfigured' | 'marketPriceInvalidKey' | 'marketPriceRateLimited' | 'marketCommodityUnrecognized' | 'marketOriginInvalid';
export type FarmerDocumentField = 'name' | 'age' | 'gender' | 'aadhaar' | 'address' | 'date_of_birth';

const farmerDocumentFields: FarmerDocumentField[] = ['name', 'age', 'gender', 'aadhaar', 'address', 'date_of_birth'];

export class FarmerAuthError extends Error {
  constructor(readonly code: ApiErrorCode, readonly fields: FarmerDocumentField[] = [], readonly suggestedFullName: string | null = null, readonly validationFields: string[] = [], readonly serverError: string | null = null, readonly validationDetails: string[] = []) { super(code); }
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
    const body = await response.json().catch(() => ({})) as { error?: string; issues?: string[]; fields?: (string | { field?: string; message?: string })[]; missingFields?: string[]; suggestedFullName?: string };
    if (body.error === 'produce_image_cleanup_failed') throw new FarmerAuthError('produceDeleteCleanupFailed');
    if (typeof body.error === 'string' && body.error.startsWith('produce_request_')) {
      throw new FarmerAuthError('produceRequestRejected', [], null, [], body.error);
    }
    // Keep the response code for produce writes even when the server returns
    // an unexpected status (for example a proxy or database 500/503).
    if (path === '/api/farmer/produce') {
      const serverCode = typeof body.error === 'string' && /^[a-z0-9_]{1,80}$/.test(body.error)
        ? body.error
        : `http_${response.status}`;
      if (body.error === 'produce_image_storage_not_configured') throw new FarmerAuthError('produceStorageUnavailable');
      if (body.error === 'produce_image_storage_failed') throw new FarmerAuthError('produceStorageUploadFailed');
      if (body.error === 'produce_image_cleanup_failed') throw new FarmerAuthError('produceDeleteCleanupFailed');
      if (body.error === 'validation_failed') {
        const details = body.fields?.slice(0, 8).map((item) => {
          const field = typeof item === 'string' ? item : item.field ?? 'request';
          const message = typeof item === 'string' ? '' : item.message?.replace(/[\r\n]/g, ' ').slice(0, 120) ?? '';
          return `${field}${message ? `: ${message}` : ''}`;
        }) ?? [];
        throw new FarmerAuthError('validationFailed', [], null, [], serverCode, details);
      }
      throw new FarmerAuthError('produceRequestRejected', [], null, [], serverCode);
    }
    if ([400, 404, 409, 422, 429, 502, 503].includes(response.status)) {
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
      if (body.error === 'verification_start_in_progress') throw new FarmerAuthError('verificationInProgress');
      if (['verification_provider_unavailable', 'verification_provider_response_invalid', 'verification_request_unavailable', 'verification_credits_exhausted', 'verification_line_not_configured'].includes(body.error ?? '')) throw new FarmerAuthError('verificationProviderFailure');
      if (body.error === 'verification_expired') throw new FarmerAuthError('verificationExpired');
      if (body.error === 'rate_limit_exceeded' || body.error === 'verification_resend_too_soon') throw new FarmerAuthError('rateLimited');
      if (body.error === 'ocr_engine_not_configured') throw new FarmerAuthError('ocrUnavailable');
      if (body.error === 'farmer_not_found') throw new FarmerAuthError(path === '/api/farmer/profile' ? 'profileNotFound' : 'farmerNotFound');
      if (body.error === 'registration_encryption_not_configured' || body.error === 'session_signing_not_configured') throw new FarmerAuthError('configurationIncomplete');
      if (body.error === 'privacy_notice_version_mismatch') throw new FarmerAuthError('privacyNoticeOutdated');
      if (body.error === 'validation_failed') {
        const validationFields = body.fields?.map((field) => typeof field === 'string' ? field : field.field ?? '')
          .filter((field) => /^[a-zA-Z][a-zA-Z.]*$/.test(field)).slice(0, 8) ?? [];
        const validationDetails = body.fields?.slice(0, 8).map((item) => {
          const field = typeof item === 'string' ? item : item.field ?? 'request';
          const message = typeof item === 'string' ? '' : item.message?.replace(/[\r\n]/g, ' ').slice(0, 120) ?? '';
          return `${/^[a-zA-Z][a-zA-Z.]*$/.test(field) ? field : 'request'}${message ? `: ${message}` : ''}`;
        }) ?? [];
        throw new FarmerAuthError('validationFailed', [], null, validationFields, body.error, validationDetails);
      }
      if (body.error === 'produce_photo_count_invalid' || body.error === 'too_many_produce_images') throw new FarmerAuthError('producePhotoCount');
      if (body.error === 'produce_image_too_large') throw new FarmerAuthError('producePhotoTooLarge');
      if (body.error === 'invalid_produce_image' || body.error === 'invalid_produce_upload') throw new FarmerAuthError('produceImageInvalid');
      if (body.error === 'produce_image_storage_not_configured') throw new FarmerAuthError('produceStorageUnavailable');
      if (body.error === 'produce_image_storage_failed') throw new FarmerAuthError('produceStorageUploadFailed');
      if (body.error === 'produce_price_invalid') throw new FarmerAuthError('producePriceInvalid');
      if (body.error === 'produce_not_found') throw new FarmerAuthError('produceNotFound');
      if (body.error === 'produce_price_already_set') throw new FarmerAuthError('producePriceAlreadySet');
      if (body.error === 'market_price_provider_not_configured') throw new FarmerAuthError('marketPriceNotConfigured');
      if (body.error === 'market_price_api_key_invalid') throw new FarmerAuthError('marketPriceInvalidKey');
      if (body.error === 'market_price_rate_limited') throw new FarmerAuthError('marketPriceRateLimited');
      if (body.error === 'market_commodity_unrecognized') throw new FarmerAuthError('marketCommodityUnrecognized');
      if (body.error === 'market_origin_invalid') throw new FarmerAuthError('marketOriginInvalid');
      if (['market_price_response_invalid', 'market_price_provider_unavailable'].includes(body.error ?? '')) throw new FarmerAuthError('marketPriceUnavailable');
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

export type FarmerProfile = { fullName: string; preferredLanguage?: 'en' | 'kn' | 'tcy' };

export type FarmerProduce = {
  id: string;
  name: string;
  sourceLanguage: 'en' | 'kn' | 'tcy';
  nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
  quantity: number;
  unit: 'kg' | 'quintal' | 'bunch' | 'pieces';
  pricePerUnit: number | null;
  priceUnit: FarmerProduce['unit'] | null;
  status: 'awaiting_price' | 'priced_unpublished' | 'published';
  location?: { status: 'captured'; latitude: number; longitude: number; accuracyMeters: number; capturedAt: string } | { status: 'unavailable' };
  photos: { url: string; mimeType: string; size: number; headers: { Authorization: string } }[];
  createdAt: string;
  updatedAt: string;
};

export type FarmerProduceRequest = {
  id: string; listingId: string; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; buyerName?: string; requestedQuantity: number; unit: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled'; createdAt: string; decidedAt: string | null; callStatus?: 'not_started' | 'queued' | 'initiated' | 'failed' | 'completed' | 'unavailable'; callConfirmed?: boolean; callFailureCode?: string | null;
  ownPhoneShared?: boolean; sharedPhone?: string | null;
};

export type FarmerNotification = { id: string; event: string; readAt: string | null; createdAt: string; request: FarmerProduceRequest | null };

export async function getFarmerProduce(signal?: AbortSignal, refreshKey?: string): Promise<FarmerProduce[]> {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const refreshQuery = refreshKey === undefined ? '' : `?refresh=${encodeURIComponent(refreshKey)}`;
  const result = await request<{ items: (Omit<FarmerProduce, 'photos'> & { photos: Omit<FarmerProduce['photos'][number], 'headers'>[] })[] }>(`/api/farmer/produce${refreshQuery}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal,
  });
  if (!Array.isArray(result.items)) throw new FarmerAuthError('rejected');
  return result.items.map((item) => ({
    ...item,
    photos: item.photos.map((photo) => ({ ...photo, url: apiUrl(photo.url), headers: { Authorization: `Bearer ${tokens.accessToken}` } })),
  }));
}

export type FarmerMarketComparison = {
  status: 'available' | 'stale' | 'missing';
  fetchedAt: string;
  sourceUnit: 'INR/quintal';
  originDistrict: string;
  searchStage: 'origin_district' | 'coastal_district' | 'karnataka_wide';
  freshnessDays: number;
  selectionComplete: boolean;
  selectionMethod: 'district_match_only' | 'district_reference_approximation' | 'incomplete';
  truncated: boolean;
  distanceAttribution: string;
  source: { name: string; url: string; attribution: string };
  items: {
    state: string; district: string; market: string; commodity: string; variety: string | null; grade: string | null;
    sourceDate: string; stale: boolean; minPrice: number | null; maxPrice: number | null; modalPrice: number | null;
    priceUnit: string | null; sourceUnit: string; unitCompatible: boolean;
    farmerPrice: number | null; differencePercent: number | null;
    distanceKm: number | null; distanceMethod: 'same_district' | 'district_reference_approximation' | 'unavailable';
    fallbackLevel: 'origin_district' | 'coastal_district' | 'other_karnataka';
    askingPriceVsModal: 'below' | 'above' | 'equal' | 'unavailable'; unchangedOnConsecutiveReport: boolean | null;
  }[];
};

function marketQuery(values: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, value);
  return params.toString();
}

export async function getFarmerMarketComparison(produceId: string, signal?: AbortSignal): Promise<FarmerMarketComparison> {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const result = await request<{ comparison: FarmerMarketComparison }>(`/api/farmer/produce/${encodeURIComponent(produceId)}/market-comparison`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal,
  });
  if (!result?.comparison || !Array.isArray(result.comparison.items)) throw new FarmerAuthError('rejected');
  return result.comparison;
}

export async function getFarmerMarketQuote(input: {
  commodity: string; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; unit: FarmerProduce['unit']; askingPrice?: string;
}, signal?: AbortSignal): Promise<FarmerMarketComparison> {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const query = marketQuery({
    commodity: input.commodity, nameEn: input.nameTranslations?.en, nameKn: input.nameTranslations?.kn,
    nameTcy: input.nameTranslations?.tcy, unit: input.unit, askingPrice: input.askingPrice,
  });
  const result = await request<{ comparison: FarmerMarketComparison }>(`/api/farmer/market-quote?${query}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal,
  });
  if (!result?.comparison || !Array.isArray(result.comparison.items)) throw new FarmerAuthError('rejected');
  return result.comparison;
}

export async function createFarmerProduce(input: { name: string; sourceLanguage: 'en' | 'kn' | 'tcy'; nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; quantity: string; unit: FarmerProduce['unit']; pricePerUnit?: string; priceUnit?: FarmerProduce['unit']; location?: NonNullable<FarmerProduce['location']>; photos: { uri: string; mimeType?: string; fileSize?: number }[] }, submissionId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const body = new FormData();
  body.append('name', input.name.trim());
  body.append('sourceLanguage', input.sourceLanguage);
  if (input.nameTranslations) body.append('nameTranslations', JSON.stringify(input.nameTranslations));
  body.append('quantity', input.quantity);
  body.append('unit', input.unit);
  if (input.pricePerUnit) body.append('pricePerUnit', input.pricePerUnit);
  if (input.priceUnit) body.append('priceUnit', input.priceUnit);
  if (input.location) body.append('location', JSON.stringify(input.location));
  for (const [index, photo] of input.photos.entries()) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (Platform.OS === 'web') {
      const mimeType = photo.mimeType && allowedMimeTypes.includes(photo.mimeType) ? photo.mimeType : 'image/jpeg';
      const response = await fetch(photo.uri);
      if (!response.ok) throw new FarmerAuthError('invalidDocument');
      const blob = await response.blob();
      if (blob.size > 8 * 1024 * 1024 || blob.type !== mimeType) throw new FarmerAuthError('invalidDocument');
      body.append('photos', blob, `produce-${index + 1}.${mimeType.split('/')[1]}`);
    } else {
      // Stream the picker URI through Expo's Blob-compatible File instead of
      // relying on React Native's legacy { uri, name, type } multipart part.
      let file: File;
      let fileSize: number;
      let fileType: string;
      try {
        file = new File(photo.uri);
        fileSize = file.size;
        fileType = file.type;
      } catch {
        throw new FarmerAuthError('produceImageInvalid');
      }
      const mimeType = photo.mimeType && allowedMimeTypes.includes(photo.mimeType) ? photo.mimeType : fileType;
      if (!fileSize || fileSize > 8 * 1024 * 1024 || !allowedMimeTypes.includes(mimeType)) {
        throw new FarmerAuthError(fileSize > 8 * 1024 * 1024 ? 'producePhotoTooLarge' : 'produceImageInvalid');
      }
      body.append('photos', file, `produce-${index + 1}.${mimeType.split('/')[1]}`);
    }
  }
  const result = await request<{ item: FarmerProduce }>('/api/farmer/produce', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Idempotency-Key': submissionId },
    body,
  });
  return result.item;
}

export async function updateFarmerProducePrice(produceId: string, pricePerUnit: string): Promise<FarmerProduce> {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  const result = await request<{ item: Omit<FarmerProduce, 'photos'> & { photos: Omit<FarmerProduce['photos'][number], 'headers'>[] } }>(`/api/farmer/produce/${encodeURIComponent(produceId)}/price`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pricePerUnit }),
  });
  return {
    ...result.item,
    photos: result.item.photos.map((photo) => ({ ...photo, url: apiUrl(photo.url), headers: { Authorization: `Bearer ${tokens.accessToken}` } })),
  };
}

export async function setFarmerProducePublished(produceId: string, published: boolean) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ status: 'published' | 'priced_unpublished' }>(`/api/farmer/produce/${encodeURIComponent(produceId)}/publication`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ published }),
  });
}

export async function deleteFarmerProduce(produceId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  await request<void>(`/api/farmer/produce/${encodeURIComponent(produceId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
}

export async function getFarmerRequests() {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ items: FarmerProduceRequest[] }>('/api/farmer/requests', { headers: { Authorization: 'Bearer ' + tokens.accessToken } });
}

export async function shareFarmerRequestPhone(requestId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ shared: true }>(`/api/farmer/requests/${encodeURIComponent(requestId)}/share-phone`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } });
}

export async function decideFarmerProduceRequest(requestId: string, decision: 'accepted' | 'rejected') {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ status: string }>('/api/farmer/requests/' + encodeURIComponent(requestId) + '/decision', {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + tokens.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
}

export async function startFarmerRequestCall(requestId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ sessionId: string; status: 'ringing' | 'connected' }>(`/api/farmer/requests/${encodeURIComponent(requestId)}/call`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } });
}

export async function retryFarmerRequestCall(requestId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ sessionId: string; status: 'ringing' | 'connected' }>(`/api/farmer/requests/${encodeURIComponent(requestId)}/call/retry`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } });
}

export async function joinFarmerInAppCall(sessionId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ serverUrl: string; participantToken: string; status: string }>(`/api/farmer/calls/${encodeURIComponent(sessionId)}/join`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } });
}

export async function endFarmerInAppCall(sessionId: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ status: 'ended' }>(`/api/farmer/calls/${encodeURIComponent(sessionId)}/end`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } });
}

export async function getFarmerNotifications(page = 1) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ items: FarmerNotification[]; unreadCount: number; page: number; hasMore: boolean }>(`/api/farmer/notifications?page=${page}`, { headers: { Authorization: 'Bearer ' + tokens.accessToken } });
}

export async function markFarmerNotificationRead(id: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ read: true }>('/api/farmer/notifications/' + encodeURIComponent(id) + '/read', { method: 'PATCH', headers: { Authorization: 'Bearer ' + tokens.accessToken } });
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
  return { fullName: result.profile.fullName, preferredLanguage: result.profile.preferredLanguage };
}

export async function setFarmerPreferredLanguage(language: 'en' | 'kn' | 'tcy') {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  return request<{ language: 'en' | 'kn' | 'tcy' }>('/api/farmer/profile/language', { method: 'PATCH', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) });
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
  const pushToken = await sessionStorage.readPushToken();
  await revokeFarmerSession(readTokens, async (accessToken) => {
    try {
      await request('/api/farmer/auth/logout', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(pushToken ? { token: pushToken } : {}) }),
      });
    } catch (error) {
      if (!(error instanceof FarmerAuthError) || error.code !== 'unauthorized') throw error;
    }
  }, async () => { await Promise.all([clearTokens(), sessionStorage.clearPushToken()]); });
}

export async function registerFarmerPushToken(token: string) {
  const tokens = await readTokens();
  if (!tokens) throw new FarmerAuthError('unauthorized');
  await request('/api/farmer/push-tokens', { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  await sessionStorage.savePushToken(token);
}
