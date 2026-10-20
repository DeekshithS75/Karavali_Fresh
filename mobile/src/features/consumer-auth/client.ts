import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreFarmerSession, type FarmerSessionState } from '@/features/farmer-auth/session-lifecycle';
import { CONSUMER_SESSION_KEY, createSessionStorage, type SessionTokens } from '@/features/farmer-auth/session-storage';
import { getApiBase } from '@/features/api-base';

const API_BASE = getApiBase();
const storage = createSessionStorage(CONSUMER_SESSION_KEY, Platform.OS === 'web' ? AsyncStorage : {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
});

export class ConsumerAuthError extends Error {
  constructor(readonly code: 'apiUrlMissing' | 'urlNotAllowed' | 'network' | 'unauthorized' | 'rejected' | 'emailRegistered' | 'invalidCredentials' | 'configurationIncomplete' | 'rateLimited' | 'validationFailed', readonly serverError: string | null = null) { super(code); }
}

export type ConsumerListing = {
  id: string;
  name: string;
  sourceLanguage: 'en' | 'kn' | 'tcy';
  nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
  quantity: number;
  unit: 'kg' | 'quintal' | 'bunch' | 'pieces';
  pricePerUnit: number;
  priceUnit: 'kg' | 'quintal' | 'bunch' | 'pieces';
  distanceBand: 'within_2_km' | 'within_10_km' | 'nearby_region' | null;
  photoUrl: string | null;
  farmerName: string | null;
  marketComparison: ConsumerMarketComparison | null;
  existingRequest?: { id: string; status: 'pending' | 'accepted' } | null;
};

export type ConsumerMarketComparison = {
  status: 'available' | 'missing' | 'stale';
  items: { modalPrice: number | null; priceUnit: string | null; sourceDate: string; district: string; market: string; stale: boolean }[];
};

export type ConsumerListingDetail = Omit<ConsumerListing, 'photoUrl' | 'distanceBand'> & { photoUrls: string[]; existingRequest: { id: string; status: 'pending' | 'accepted' } | null };

export type ConsumerListingQuery = {
  search?: string;
  page?: number;
  limit?: number;
  sort?: 'newest' | 'nearby';
  location?: { latitude: number; longitude: number; accuracyMeters: number };
  distanceKm?: number;
};

export type ConsumerProduceRequest = {
  id: string; listingId: string; listingName: string; listingNameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>; pricePerUnit: number; priceUnit: string;
  requestedQuantity: number; unit: string; status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  createdAt: string; decidedAt: string | null; callStatus?: 'queued' | 'initiated' | 'failed' | 'completed' | 'unavailable'; callConfirmed?: boolean;
};

export type ConsumerNotification = {
  id: string; event: string; readAt: string | null; createdAt: string; request: ConsumerProduceRequest | null;
};

function apiUrl(path: string) {
  if (!API_BASE) throw new ConsumerAuthError('apiUrlMissing');
  let parsed: URL;
  try { parsed = new URL(API_BASE); } catch { throw new ConsumerAuthError('urlNotAllowed'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const lan = /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host);
  if (parsed.protocol !== 'https:' && !(__DEV__ && parsed.protocol === 'http:' && (local || lan))) throw new ConsumerAuthError('urlNotAllowed');
  return `${API_BASE}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(apiUrl(path), init); }
  catch (error) { if (error instanceof ConsumerAuthError) throw error; throw new ConsumerAuthError('network'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) throw new ConsumerAuthError('unauthorized');
    if (body.error === 'consumer_email_registered') throw new ConsumerAuthError('emailRegistered');
    if (body.error === 'consumer_credentials_invalid') throw new ConsumerAuthError('invalidCredentials');
    if (body.error === 'session_signing_not_configured') throw new ConsumerAuthError('configurationIncomplete');
    if (body.error === 'rate_limit_exceeded') throw new ConsumerAuthError('rateLimited');
    if (body.error === 'validation_failed') throw new ConsumerAuthError('validationFailed');
    if (typeof body.error === 'string') throw new ConsumerAuthError('rejected', body.error);
    throw new ConsumerAuthError('rejected');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

type ConsumerSessionReply = SessionTokens & { expiresAt: string; consumer: { id: string; fullName: string; preferredLanguage?: 'en' | 'kn' | 'tcy' } };
export type ConsumerChallenge = { challengeId: string; callNumber: string; instruction: string; expiresAt: string; status: 'pending' };
export async function startConsumerPhoneVerification(phone: string, purpose: 'login' | 'registration', fullName?: string) {
  return request<ConsumerChallenge>('/api/consumer/auth/phone-verification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, purpose, phoneVerificationConsent: true, ...(fullName ? { fullName } : {}) }) });
}
export async function completeConsumerPhoneVerification(challengeId: string, fullName?: string, preferredLanguage?: 'en' | 'kn' | 'tcy') {
  const result = await request<ConsumerSessionReply>(`/api/consumer/auth/phone-verification/${encodeURIComponent(challengeId)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(fullName ? { fullName } : {}), ...(preferredLanguage ? { preferredLanguage } : {}) }) });
  await storage.save(result);
  return result.consumer;
}
export const getConsumerPhoneVerificationStatus = (challengeId: string) => request<{ status: 'pending' | 'verified' | 'expired' | 'cancelled'; expiresAt: string }>(`/api/consumer/auth/phone-verification/${encodeURIComponent(challengeId)}/status`);

async function validateSession(accessToken: string) {
  const result = await request<{ valid: boolean; role: string }>('/api/consumer/auth/session', { headers: { Authorization: `Bearer ${accessToken}` } });
  return result.valid && result.role === 'consumer';
}

export function getConsumerSessionState(): Promise<FarmerSessionState> {
  return restoreFarmerSession(storage.read, validateSession, storage.clear, (error) => error instanceof ConsumerAuthError && error.code === 'unauthorized', (error) => error instanceof ConsumerAuthError && (error.code === 'apiUrlMissing' || error.code === 'urlNotAllowed' || error.code === 'configurationIncomplete'));
}

export async function getConsumerProfile() {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return request<{ valid: true; role: 'consumer'; consumerId: string; fullName: string; preferredLanguage?: 'en' | 'kn' | 'tcy' }>('/api/consumer/auth/session', { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
}

export async function setConsumerPreferredLanguage(language: 'en' | 'kn' | 'tcy') {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return request<{ language: 'en' | 'kn' | 'tcy' }>('/api/consumer/profile/language', { method: 'PATCH', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) });
}

export async function logoutConsumer() {
  const tokens = await storage.read();
  try {
    if (tokens) {
      const pushToken = await storage.readPushToken();
      if (pushToken) await request<void>('/api/consumer/push-tokens', { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pushToken }) }).catch(() => undefined);
      await request<void>('/api/consumer/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(pushToken ? { token: pushToken } : {}) }) });
    }
  } finally { await Promise.all([storage.clear(), storage.clearPushToken()]); }
}

export async function registerConsumerPushToken(token: string) {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  await request<void>('/api/consumer/push-tokens', { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  await storage.savePushToken(token);
}

export async function getConsumerListings(query: ConsumerListingQuery = {}, signal?: AbortSignal) {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  const params = new URLSearchParams({ search: query.search ?? '', page: String(query.page ?? 1), limit: String(query.limit ?? 12), sort: query.sort ?? 'newest' });
  if (query.location) {
    params.set('latitude', String(query.location.latitude));
    params.set('longitude', String(query.location.longitude));
    params.set('accuracyMeters', String(query.location.accuracyMeters));
  }
  if (query.distanceKm !== undefined) params.set('distanceKm', String(query.distanceKm));
  const result = await request<{ items: ConsumerListing[]; page: number; hasMore: boolean }>(`/api/consumer/produce?${params.toString()}`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal });
  return { ...result, items: result.items.map((item) => ({ ...item, photoUrl: item.photoUrl ? apiUrl(item.photoUrl) : null })) };
}

export async function getConsumerListingDetail(id: string) {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  const result = await request<{ item: ConsumerListingDetail }>(`/api/consumer/produce/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  return { ...result.item, photoUrls: result.item.photoUrls.map(apiUrl) };
}

export async function getConsumerPhotoHeaders() {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

export function createConsumerRequestKey() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (digit) => {
    const random = Math.floor(Math.random() * 16);
    return (digit === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export async function requestConsumerProduce(produceId: string, requestedQuantity: number, requestKey: string) {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return request<{ request: ConsumerProduceRequest }>('/api/consumer/produce/' + encodeURIComponent(produceId) + '/requests', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tokens.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestedQuantity, requestKey, callConsent: true }),
  });
}

export async function getConsumerRequests() {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return request<{ items: ConsumerProduceRequest[] }>('/api/consumer/requests', { headers: { Authorization: 'Bearer ' + tokens.accessToken } });
}

export async function getConsumerNotifications(page = 1) {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return request<{ items: ConsumerNotification[]; unreadCount: number; page: number; hasMore: boolean }>(`/api/consumer/notifications?page=${page}`, { headers: { Authorization: 'Bearer ' + tokens.accessToken } });
}

export async function markConsumerNotificationRead(id: string) {
  const tokens = await storage.read();
  if (!tokens) throw new ConsumerAuthError('unauthorized');
  return request<{ read: true }>('/api/consumer/notifications/' + encodeURIComponent(id) + '/read', { method: 'PATCH', headers: { Authorization: 'Bearer ' + tokens.accessToken } });
}
