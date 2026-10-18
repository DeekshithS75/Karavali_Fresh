import {
  isRecentObservation,
  marketRecordKey,
  matchesProduceCommodity,
  pricesUnchangedFromPreviousDay,
  type MarketPriceRecord,
  type ProducePriceUnit,
  type RelevantMarketRecords,
} from '../providers/market-prices.js';
import { getDistrictReference, haversineKm, MARKET_DISTANCE_SOURCE, normalizeDistrict } from './market-districts.js';

export type FarmerProduceForMarket = {
  name: string;
  nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
  unit: ProducePriceUnit;
  pricePerUnit: number | null;
};

export function previousArrivalDate(date: string): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - 1);
  return result.toISOString().slice(0, 10);
}

export function convertSourceQuintalPrice(price: number, unit: ProducePriceUnit): number | null {
  if (unit === 'quintal') return price;
  if (unit === 'kg') return price / 100;
  return null;
}

export function buildFarmerMarketComparison(
  produce: FarmerProduceForMarket,
  dataset: RelevantMarketRecords,
  previousByKeyAndDate: Map<string, MarketPriceRecord>,
  now = new Date(),
) {
  const names = [produce.name, ...Object.values(produce.nameTranslations ?? {})].filter((value): value is string => Boolean(value?.trim()));
  const matching = dataset.records.filter((record) => matchesProduceCommodity(record, names));
  const origin = getDistrictReference(dataset.originDistrict);
  const candidates = matching.map((record) => {
    const originSame = normalizeDistrict(record.district) === normalizeDistrict(dataset.originDistrict);
    const reference = getDistrictReference(record.district);
    const recent = isRecentObservation(record, dataset.freshnessDays, now.toISOString().slice(0, 10));
    const localCoast = ['dakshina kannada', 'udupi', 'uttara kannada'].includes(normalizeDistrict(record.district).toLocaleLowerCase('en-IN'));
    const distanceKm = originSame || !origin || !reference ? null : haversineKm(origin, reference);
    return {
      record,
      recent,
      distanceKm,
      distanceMethod: originSame ? 'same_district' as const : distanceKm === null ? 'unavailable' as const : 'district_reference_approximation' as const,
      fallbackLevel: originSame ? 'origin_district' as const : localCoast ? 'coastal_district' as const : 'other_karnataka' as const,
      rankDistance: originSame ? 0 : distanceKm ?? Number.POSITIVE_INFINITY,
    };
  });
  const freshCandidates = candidates.filter((candidate) => candidate.recent);
  const selectedCandidates = (freshCandidates.length ? freshCandidates : candidates)
    .sort((a, b) => a.rankDistance - b.rankDistance || b.record.arrivalDate.localeCompare(a.record.arrivalDate) || a.record.market.localeCompare(b.record.market));
  const visibleCandidates = selectedCandidates.slice(0, 5);
  const rows = visibleCandidates.map(({ record, recent, distanceKm, distanceMethod, fallbackLevel }) => {
    const recordKey = marketRecordKey(record);
    const previous = previousByKeyAndDate.get(`${recordKey}|${previousArrivalDate(record.arrivalDate)}`) ?? null;
    const unchangedOnConsecutiveReport = pricesUnchangedFromPreviousDay(record, previous);
    const min = convertSourceQuintalPrice(record.minPrice, produce.unit);
    const max = convertSourceQuintalPrice(record.maxPrice, produce.unit);
    const modal = convertSourceQuintalPrice(record.modalPrice, produce.unit);
    const compatible = modal !== null && min !== null && max !== null;
    const differencePercent = compatible && produce.pricePerUnit !== null
      ? ((produce.pricePerUnit - modal!) / modal!) * 100 : null;
    return {
      state: record.state, district: record.district, market: record.market, commodity: record.commodity,
      variety: record.variety || null, grade: record.grade || null,
      sourceDate: record.arrivalDate, stale: !recent,
      minPrice: compatible ? min : null, maxPrice: compatible ? max : null, modalPrice: compatible ? modal : null,
      priceUnit: compatible ? `INR/${produce.unit}` : null, sourceUnit: 'INR/quintal', unitCompatible: compatible,
      farmerPrice: compatible ? produce.pricePerUnit : null,
      differencePercent: Number.isFinite(differencePercent) ? differencePercent : null,
      askingPriceVsModal: !compatible || produce.pricePerUnit === null ? 'unavailable' as const
        : produce.pricePerUnit < modal! ? 'below' as const : produce.pricePerUnit > modal! ? 'above' as const : 'equal' as const,
      distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
      distanceMethod, fallbackLevel, unchangedOnConsecutiveReport,
    };
  });
  const stale = rows.length > 0 && rows.every((row) => row.stale);
  const hasUnlocatedCandidates = selectedCandidates.some((candidate) => candidate.distanceMethod === 'unavailable');
  const selectionMethod = dataset.truncated || hasUnlocatedCandidates
    ? 'incomplete' as const
    : dataset.stage === 'origin_district' ? 'district_match_only' as const
      : 'district_reference_approximation' as const;
  const status = rows.length === 0 ? 'missing' as const : stale ? 'stale' as const : 'available' as const;
  return {
    status,
    fetchedAt: dataset.fetchedAt,
    originDistrict: dataset.originDistrict,
    searchStage: dataset.stage,
    freshnessDays: dataset.freshnessDays,
    selectionComplete: selectionMethod !== 'incomplete',
    selectionMethod,
    truncated: dataset.truncated,
    sourceUnit: 'INR/quintal' as const,
    distanceAttribution: MARKET_DISTANCE_SOURCE,
    source: {
      name: 'data.gov.in / AGMARKNET',
      url: 'https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi',
      attribution: 'Indicative mandi wholesale observations. They are not guaranteed farm-gate prices.',
    },
    items: rows,
  };
}
