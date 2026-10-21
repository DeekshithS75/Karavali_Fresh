import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { getDistrictReference, haversineKm, KARNATAKA_DISTRICT_REFERENCES, MARKET_DISTANCE_SOURCE, normalizeDistrict } from '../services/market-districts.js';
import { normalizeCommodityName, resolveOfficialCommodity } from './market-commodities.js';
export { normalizeCommodityName, resolveOfficialCommodity } from './market-commodities.js';

export const DATA_GOV_MANDI_RESOURCE_ID = '9ef84268-d588-465a-a308-a864a43d0070';
const API_ENDPOINT = `https://api.data.gov.in/resource/${DATA_GOV_MANDI_RESOURCE_ID}`;
const API_CACHE_TTL_MS = 30 * 60 * 1000;
const PAGE_LIMIT = 20;
const MAX_PAGES_PER_FILTER = 5;
const DEFAULT_FRESHNESS_DAYS = config.MARKET_PRICE_FRESHNESS_DAYS;
export const DEFAULT_MARKET_ORIGIN_DISTRICT = 'Dakshina Kannada';
const COASTAL_DISTRICTS = ['Dakshina Kannada', 'Udupi', 'Uttara Kannada'] as const;

export type MarketPriceRecord = {
  state: string; district: string; market: string; commodity: string; variety: string; grade: string;
  arrivalDate: string; minPrice: number; maxPrice: number; modalPrice: number;
};
export type ProducePriceUnit = 'kg' | 'quintal' | 'bunch' | 'pieces';
export type MarketSearchStage = 'origin_district' | 'coastal_district' | 'karnataka_wide';
type DataGovPage = { total: number; count: number; limit: number; offset: number; records: Array<Record<string, unknown>> };
type PageResult = { total: number; count: number; limit: number; offset: number; records: MarketPriceRecord[] };
type CachedQuery = { expiresAt: number; fetchedAt: string; records: MarketPriceRecord[]; truncated: boolean };
export type RelevantMarketRecords = {
  records: MarketPriceRecord[];
  fetchedAt: string;
  truncated: boolean;
  stage: MarketSearchStage;
  originDistrict: string;
  commodity: string;
  freshnessDays: number;
};

export class MarketPriceProviderError extends Error {
  constructor(readonly code: 'not_configured' | 'unavailable' | 'response_invalid' | 'invalid_api_key' | 'rate_limited' | 'commodity_unrecognized' | 'origin_invalid') { super(code); }
}

const clean = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const numeric = (value: unknown) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const sourceDate = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let year: number; let month: number; let day: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) [year, month, day] = text.split('-').map(Number) as [number, number, number];
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) [day, month, year] = text.split('/').map(Number) as [number, number, number];
  else return null;
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== `${year!.toString().padStart(4, '0')}-${month!.toString().padStart(2, '0')}-${day!.toString().padStart(2, '0')}`
    ? null : parsed.toISOString().slice(0, 10);
};

export function parseDataGovRecord(raw: Record<string, unknown>): MarketPriceRecord | null {
  const state = clean(raw.state); const district = clean(raw.district); const market = clean(raw.market);
  const commodity = clean(raw.commodity); const arrivalDate = sourceDate(raw.arrival_date);
  const minPrice = numeric(raw.min_price); const maxPrice = numeric(raw.max_price); const modalPrice = numeric(raw.modal_price);
  if (!state || !district || !market || !commodity || !arrivalDate || minPrice === null || maxPrice === null
    || modalPrice === null || minPrice <= 0 || minPrice > maxPrice || modalPrice <= 0 || modalPrice < minPrice || modalPrice > maxPrice) return null;
  return { state, district, market, commodity, variety: clean(raw.variety), grade: clean(raw.grade), arrivalDate, minPrice, maxPrice, modalPrice };
}

export function parseDataGovResponse(value: unknown, expectedOffset = 0, expectedLimit = PAGE_LIMIT): PageResult {
  if (!value || typeof value !== 'object' || !Array.isArray((value as DataGovPage).records)) throw new MarketPriceProviderError('response_invalid');
  const data = value as DataGovPage;
  const total = Number(data.total); const count = Number(data.count); const limit = Number(data.limit); const offset = Number(data.offset);
  if (![total, count, limit, offset].every(Number.isSafeInteger) || total < 0 || count < 0 || count !== data.records.length
    || limit !== expectedLimit || offset !== expectedOffset || total < offset + count || count > limit) throw new MarketPriceProviderError('response_invalid');
  const records = data.records.map(parseDataGovRecord);
  if (data.records.length > 0 && records.every((record) => record === null)) throw new MarketPriceProviderError('response_invalid');
  return { total, count, limit, offset, records: records.filter((record): record is MarketPriceRecord => record !== null) };
}

export function matchesProduceCommodity(record: MarketPriceRecord, names: string[]): boolean {
  const requested = resolveOfficialCommodity(names);
  return requested !== null && normalizeCommodityName(record.commodity) === normalizeCommodityName(requested);
}

export function marketRecordKey(record: MarketPriceRecord): string {
  return createHash('sha256').update([record.state, record.district, record.market, record.commodity, record.variety, record.grade]
    .map((part) => normalizeCommodityName(part)).join('|')).digest('hex');
}

export function pricesUnchangedFromPreviousDay(record: MarketPriceRecord, prior: MarketPriceRecord | null): boolean | null {
  if (!prior) return null;
  const previous = new Date(`${record.arrivalDate}T00:00:00.000Z`); previous.setUTCDate(previous.getUTCDate() - 1);
  if (prior.arrivalDate !== previous.toISOString().slice(0, 10)) return null;
  return record.minPrice === prior.minPrice && record.maxPrice === prior.maxPrice && record.modalPrice === prior.modalPrice;
}

const cache = new Map<string, CachedQuery>();
const inFlight = new Map<string, Promise<CachedQuery>>();
const cacheKey = (district: string | null, commodity: string) => `Karnataka|${district ?? '*'}|${normalizeCommodityName(commodity)}|limit=${PAGE_LIMIT}|format=json`;

export async function requestDataGovPage(
  offset: number, district: string | null, commodity: string, apiKey: string, fetchImpl: typeof fetch = fetch,
): Promise<PageResult> {
  const url = new URL(API_ENDPOINT);
  url.searchParams.set('api-key', apiKey); url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(PAGE_LIMIT)); url.searchParams.set('offset', String(offset));
  url.searchParams.set('filters[state]', 'Karnataka');
  if (district) url.searchParams.set('filters[district]', district);
  url.searchParams.set('filters[commodity]', commodity);
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      break;
    } catch (error) {
      const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'UnknownError';
      const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null;
      const rawCauseCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      const causeCode = typeof rawCauseCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(rawCauseCode) ? rawCauseCode : undefined;
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(causeCode ?? '');
      process.stderr.write(`${JSON.stringify({ event: 'market_price_upstream_failure', kind: 'network', errorName, ...(causeCode ? { causeCode } : {}), attempt: attempt + 1 })}\n`);
      if (attempt === 0 && retryable) continue;
      throw new MarketPriceProviderError('unavailable');
    }
  }
  if (!response) throw new MarketPriceProviderError('unavailable');
  if (response.status === 401 || response.status === 403) throw new MarketPriceProviderError('invalid_api_key');
  if (response.status === 429) throw new MarketPriceProviderError('rate_limited');
  if (!response.ok) {
    process.stderr.write(`${JSON.stringify({ event: 'market_price_upstream_failure', kind: 'http', status: response.status })}\n`);
    throw new MarketPriceProviderError('unavailable');
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new MarketPriceProviderError('response_invalid'); }
  return parseDataGovResponse(body, offset);
}

function matchesRequestedFilters(record: MarketPriceRecord, district: string | null, commodity: string): boolean {
  return record.state.trim().toLocaleLowerCase('en-IN') === 'karnataka'
    && (!district || normalizeDistrict(record.district) === normalizeDistrict(district))
    && normalizeCommodityName(record.commodity) === normalizeCommodityName(commodity);
}

async function fetchQuery(district: string | null, commodity: string, apiKey: string, fetchImpl: typeof fetch): Promise<CachedQuery> {
  const records: MarketPriceRecord[] = [];
  let total = 0; let truncated = false;
  for (let page = 0; page < MAX_PAGES_PER_FILTER; page += 1) {
    const offset = page * PAGE_LIMIT;
    const result = await requestDataGovPage(offset, district, commodity, apiKey, fetchImpl);
    total = result.total;
    records.push(...result.records.filter((record) => matchesRequestedFilters(record, district, commodity)));
    if (offset + result.count >= total || result.count === 0) break;
    if (page === MAX_PAGES_PER_FILTER - 1) truncated = true;
  }
  return { records, fetchedAt: new Date().toISOString(), expiresAt: Date.now() + API_CACHE_TTL_MS, truncated };
}

async function cachedQuery(district: string | null, commodity: string, apiKey: string, fetchImpl: typeof fetch, forceRefresh: boolean) {
  const key = cacheKey(district, commodity);
  const existing = cache.get(key);
  if (!forceRefresh && existing && existing.expiresAt > Date.now()) return existing;
  let pending = inFlight.get(key);
  if (!pending) { pending = fetchQuery(district, commodity, apiKey, fetchImpl); inFlight.set(key, pending); }
  try { const result = await pending; cache.set(key, result); return result; }
  finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
export function isRecentObservation(record: MarketPriceRecord, freshnessDays = DEFAULT_FRESHNESS_DAYS, today = todayUtc()): boolean {
  const dayAge = Math.floor((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${record.arrivalDate}T00:00:00.000Z`)) / 86_400_000);
  return dayAge >= 0 && dayAge <= freshnessDays;
}

function coastalDistrictsNear(originDistrict: string): string[] {
  const origin = getDistrictReference(originDistrict);
  return COASTAL_DISTRICTS.filter((district) => normalizeDistrict(district) !== normalizeDistrict(originDistrict))
    .sort((a, b) => {
      const aReference = getDistrictReference(a); const bReference = getDistrictReference(b);
      if (!origin || !aReference || !bReference) return a.localeCompare(b);
      return haversineKm(origin, aReference) - haversineKm(origin, bReference);
    });
}

function uniqueRecords(records: MarketPriceRecord[]): MarketPriceRecord[] {
  const byKey = new Map<string, MarketPriceRecord>();
  for (const record of records) {
    const key = `${marketRecordKey(record)}|${record.arrivalDate}`;
    if (!byKey.has(key)) byKey.set(key, record);
  }
  return [...byKey.values()];
}

async function fetchRelevantRecords(names: string[], originDistrict: string, apiKey: string, fetchImpl: typeof fetch, forceRefresh: boolean, today = todayUtc()): Promise<RelevantMarketRecords> {
  const origin = KARNATAKA_DISTRICT_REFERENCES.find((item) => item.district === normalizeDistrict(originDistrict));
  if (!origin) throw new MarketPriceProviderError('origin_invalid');
  const commodity = resolveOfficialCommodity(names);
  if (!commodity) throw new MarketPriceProviderError('commodity_unrecognized');
  let queried: CachedQuery[] = [];
  const local = await cachedQuery(origin.district, commodity, apiKey, fetchImpl, forceRefresh);
  queried.push(local);
  let records = uniqueRecords(local.records);
  if (records.some((record) => isRecentObservation(record, DEFAULT_FRESHNESS_DAYS, today))) {
    return result(records.filter((record) => isRecentObservation(record, DEFAULT_FRESHNESS_DAYS, today)), 'origin_district', origin.district, commodity, queried);
  }

  const coastal = await Promise.all(coastalDistrictsNear(origin.district).map((district) => cachedQuery(district, commodity, apiKey, fetchImpl, forceRefresh)));
  queried = [...queried, ...coastal];
  records = uniqueRecords([...records, ...coastal.flatMap((query) => query.records)]);
  const coastalRecords = records.filter((record) => COASTAL_DISTRICTS.some((district) => normalizeDistrict(record.district) === normalizeDistrict(district))
    && isRecentObservation(record, DEFAULT_FRESHNESS_DAYS, today));
  if (coastalRecords.length) return result(coastalRecords, 'coastal_district', origin.district, commodity, queried);

  const statewide = await cachedQuery(null, commodity, apiKey, fetchImpl, forceRefresh);
  queried.push(statewide);
  records = uniqueRecords([...records, ...statewide.records]);
  const fresh = records.filter((record) => isRecentObservation(record, DEFAULT_FRESHNESS_DAYS, today));
  return result(fresh.length ? fresh : records, 'karnataka_wide', origin.district, commodity, queried);
}

function result(records: MarketPriceRecord[], stage: MarketSearchStage, originDistrict: string, commodity: string, queries: CachedQuery[]): RelevantMarketRecords {
  return {
    records: uniqueRecords(records), fetchedAt: queries.map((query) => query.fetchedAt).sort().at(-1) ?? new Date().toISOString(),
    truncated: queries.some((query) => query.truncated), stage, originDistrict, commodity, freshnessDays: DEFAULT_FRESHNESS_DAYS,
  };
}

export async function getRelevantRecords(
  names: string[], originDistrict: string, apiKey: string, fetchImpl: typeof fetch = fetch, forceRefresh = false, today?: string,
): Promise<RelevantMarketRecords> {
  return fetchRelevantRecords(names, originDistrict, apiKey, fetchImpl, forceRefresh, today);
}

export const marketPriceProvider = {
  async getRelevantRecords(names: string[], forceRefresh = false) {
    if (!config.DATA_GOV_IN_API_KEY?.trim()) throw new MarketPriceProviderError('not_configured');
    return getRelevantRecords(names, DEFAULT_MARKET_ORIGIN_DISTRICT, config.DATA_GOV_IN_API_KEY.trim(), fetch, forceRefresh);
  },
  clearCache() { cache.clear(); inFlight.clear(); },
};

export const MARKET_PRICE_SOURCE = {
  title: 'Current Daily Price of Various Commodities from Various Markets (Mandi)',
  url: 'https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi',
  apiUrl: API_ENDPOINT,
  attribution: 'Source: data.gov.in / AGMARKNET. Mandi observations are indicative wholesale prices, not guaranteed farm-gate prices.',
  distanceAttribution: MARKET_DISTANCE_SOURCE,
  sourceUnit: 'INR/quintal' as const,
  staleAfterDays: DEFAULT_FRESHNESS_DAYS,
};

export const MARKET_PRICE_LIMITS = { pageLimit: PAGE_LIMIT, maxPagesPerFilter: MAX_PAGES_PER_FILTER } as const;
