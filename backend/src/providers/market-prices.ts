import { createHash } from 'node:crypto';
import { config } from '../config.js';

export const DATA_GOV_MANDI_RESOURCE_ID = '9ef84268-d588-465a-a308-a864a43d0070';
const API_ENDPOINT = `https://api.data.gov.in/resource/${DATA_GOV_MANDI_RESOURCE_ID}`;
const API_CACHE_TTL_MS = 30 * 60 * 1000;
const PAGE_LIMIT = 20;
const MAX_PAGES_PER_FILTER = 5;
const STALE_AFTER_DAYS = 7;
const DISTRICTS = ['Dakshina Kannada', 'Udupi'] as const;

export type MarketPriceRecord = {
  state: string; district: string; market: string; commodity: string; variety: string; grade: string;
  arrivalDate: string; minPrice: number; maxPrice: number; modalPrice: number;
};
type DataGovPage = { total: number; count: number; limit: number; offset: number; records: Array<Record<string, unknown>> };
type PageResult = { total: number; count: number; limit: number; offset: number; records: MarketPriceRecord[] };
type CachedQuery = { expiresAt: number; fetchedAt: string; records: MarketPriceRecord[] };

export class MarketPriceProviderError extends Error {
  constructor(readonly code: 'not_configured' | 'unavailable' | 'response_invalid' | 'invalid_api_key' | 'rate_limited') { super(code); }
}

const coastalDistricts = new Set(DISTRICTS.map((district) => district.toLocaleLowerCase('en-IN')));
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
    || modalPrice === null || minPrice > maxPrice || modalPrice <= 0) return null;
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

export function isCoastalKarnatakaRecord(record: MarketPriceRecord): boolean {
  return record.state.normalize('NFKC').trim().toLocaleLowerCase('en-IN') === 'karnataka'
    && coastalDistricts.has(record.district.normalize('NFKC').trim().toLocaleLowerCase('en-IN'));
}

export function normalizeCommodityName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-IN').replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function matchesProduceCommodity(record: MarketPriceRecord, names: string[]): boolean {
  const commodity = normalizeCommodityName(record.commodity);
  return commodity.length > 0 && names.some((name) => normalizeCommodityName(name) === commodity);
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

const coastalOrder = new Map([['dakshina kannada', 0], ['udupi', 1]]);
export function sortCoastalMarkets(records: MarketPriceRecord[]): MarketPriceRecord[] {
  return [...records].sort((a, b) => (coastalOrder.get(a.district.toLocaleLowerCase('en-IN')) ?? 9)
    - (coastalOrder.get(b.district.toLocaleLowerCase('en-IN')) ?? 9) || b.arrivalDate.localeCompare(a.arrivalDate)
    || a.market.localeCompare(b.market));
}

const cache = new Map<string, CachedQuery>();
const inFlight = new Map<string, Promise<CachedQuery>>();
const cacheKey = (district: string, commodity: string) => `Karnataka|${district}|${normalizeCommodityName(commodity)}|limit=${PAGE_LIMIT}|format=json`;

export async function requestDataGovPage(
  offset: number, district: string, commodity: string, apiKey: string, fetchImpl: typeof fetch = fetch,
): Promise<PageResult> {
  const url = new URL(API_ENDPOINT);
  url.searchParams.set('api-key', apiKey); url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(PAGE_LIMIT)); url.searchParams.set('offset', String(offset));
  url.searchParams.set('filters[state]', 'Karnataka'); url.searchParams.set('filters[district]', district);
  url.searchParams.set('filters[commodity]', commodity);
  let response: Response;
  try { response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new MarketPriceProviderError('unavailable'); }
  if (response.status === 401 || response.status === 403) throw new MarketPriceProviderError('invalid_api_key');
  if (response.status === 429) throw new MarketPriceProviderError('rate_limited');
  if (!response.ok) throw new MarketPriceProviderError('unavailable');
  let body: unknown;
  try { body = await response.json(); } catch { throw new MarketPriceProviderError('response_invalid'); }
  return parseDataGovResponse(body, offset);
}

function exactEnglishCommodityNames(names: string[]): string[] {
  return [...new Set(names.map((name) => clean(name)).filter((name) => name.length > 0 && name.length <= 80 && /^[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N} ()&/'’.-]*$/u.test(name)))].slice(0, 3);
}

async function fetchQuery(district: string, commodity: string, apiKey: string, fetchImpl: typeof fetch): Promise<CachedQuery> {
  const records: MarketPriceRecord[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES_PER_FILTER; page += 1) {
    const offset = page * PAGE_LIMIT;
    const result = await requestDataGovPage(offset, district, commodity, apiKey, fetchImpl);
    total = result.total;
    // Guard against APIs that accept but ignore one or more filters.
    records.push(...result.records.filter((record) => isCoastalKarnatakaRecord(record)
      && record.district.toLocaleLowerCase('en-IN') === district.toLocaleLowerCase('en-IN')
      && normalizeCommodityName(record.commodity) === normalizeCommodityName(commodity)));
    if (offset + result.count >= total || result.count === 0) break;
    if (page === MAX_PAGES_PER_FILTER - 1) throw new MarketPriceProviderError('response_invalid');
  }
  return { records, fetchedAt: new Date().toISOString(), expiresAt: Date.now() + API_CACHE_TTL_MS };
}

async function cachedQuery(district: string, commodity: string, apiKey: string, fetchImpl: typeof fetch, forceRefresh: boolean) {
  const key = cacheKey(district, commodity);
  const existing = cache.get(key);
  if (!forceRefresh && existing && existing.expiresAt > Date.now()) return existing;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchQuery(district, commodity, apiKey, fetchImpl);
    inFlight.set(key, pending);
  }
  try { const result = await pending; cache.set(key, result); return result; }
  finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
}

export async function getRelevantRecords(names: string[], apiKey: string, fetchImpl: typeof fetch = fetch, forceRefresh = false) {
  const commodities = exactEnglishCommodityNames(names);
  if (!commodities.length) return { records: [] as MarketPriceRecord[], fetchedAt: new Date().toISOString() };
  const queries = await Promise.all(DISTRICTS.flatMap((district) => commodities.map((commodity) =>
    cachedQuery(district, commodity, apiKey, fetchImpl, forceRefresh))));
  return {
    records: sortCoastalMarkets(queries.flatMap((query) => query.records)),
    fetchedAt: queries.map((query) => query.fetchedAt).sort()[0]!,
  };
}

export const marketPriceProvider = {
  async getCoastalRecords(names: string[], forceRefresh = false) {
    if (!config.DATA_GOV_IN_API_KEY?.trim()) throw new MarketPriceProviderError('not_configured');
    return getRelevantRecords(names, config.DATA_GOV_IN_API_KEY.trim(), fetch, forceRefresh);
  },
  clearCache() { cache.clear(); inFlight.clear(); },
};

export const MARKET_PRICE_SOURCE = {
  title: 'Current Daily Price of Various Commodities from Various Markets (Mandi)',
  url: 'https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi',
  apiUrl: API_ENDPOINT,
  attribution: 'Source: data.gov.in / AGMARKNET. Mandi observations are indicative wholesale prices, not guaranteed farm-gate prices.',
  sourceUnit: 'INR/quintal' as const,
  staleAfterDays: STALE_AFTER_DAYS,
};
