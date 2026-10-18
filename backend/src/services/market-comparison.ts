import {
  isCoastalKarnatakaRecord,
  marketRecordKey,
  matchesProduceCommodity,
  pricesUnchangedFromPreviousDay,
  sortCoastalMarkets,
  type MarketPriceRecord,
} from '../providers/market-prices.js';

export type FarmerProduceForMarket = {
  name: string;
  nameTranslations?: Partial<Record<'en' | 'kn' | 'tcy', string>>;
  unit: 'kg' | 'quintal' | 'bunch' | 'pieces';
  pricePerUnit: number | null;
};

export type PreviousMarketObservation = MarketPriceRecord;

export function previousArrivalDate(date: string): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - 1);
  return result.toISOString().slice(0, 10);
}

export function convertSourceQuintalPrice(price: number, unit: FarmerProduceForMarket['unit']): number | null {
  if (unit === 'quintal') return price;
  if (unit === 'kg') return price / 100;
  return null;
}

function ageInDays(arrivalDate: string, now: Date): number {
  const source = new Date(`${arrivalDate}T00:00:00.000Z`).valueOf();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - source) / 86_400_000);
}

export function buildFarmerMarketComparison(
  produce: FarmerProduceForMarket,
  datasetRecords: MarketPriceRecord[],
  fetchedAt: string,
  previousByKeyAndDate: Map<string, MarketPriceRecord>,
  now = new Date(),
) {
  const names = [produce.name, ...Object.values(produce.nameTranslations ?? {})].filter((value): value is string => Boolean(value?.trim()));
  const matching = sortCoastalMarkets(datasetRecords.filter((record) => isCoastalKarnatakaRecord(record) && matchesProduceCommodity(record, names)));
  // Keep only the latest observation for an individual market/commodity/variety/grade.
  const latestByMarketRecord = new Map<string, MarketPriceRecord>();
  for (const record of matching) {
    const key = marketRecordKey(record);
    const current = latestByMarketRecord.get(key);
    if (!current || record.arrivalDate > current.arrivalDate) latestByMarketRecord.set(key, record);
  }
  const rows = [...latestByMarketRecord.values()].map((record) => {
    const recordKey = marketRecordKey(record);
    const previous = previousByKeyAndDate.get(`${recordKey}|${previousArrivalDate(record.arrivalDate)}`) ?? null;
    const unchangedOnConsecutiveReport = pricesUnchangedFromPreviousDay(record, previous);
    const daysOld = ageInDays(record.arrivalDate, now);
    const compatible = convertSourceQuintalPrice(record.modalPrice, produce.unit) !== null;
    const min = convertSourceQuintalPrice(record.minPrice, produce.unit);
    const max = convertSourceQuintalPrice(record.maxPrice, produce.unit);
    const modal = convertSourceQuintalPrice(record.modalPrice, produce.unit);
    return {
      state: record.state,
      district: record.district,
      market: record.market,
      commodity: record.commodity,
      variety: record.variety || null,
      grade: record.grade || null,
      sourceDate: record.arrivalDate,
      stale: daysOld > 7,
      minPrice: compatible ? min : null,
      maxPrice: compatible ? max : null,
      modalPrice: compatible ? modal : null,
      priceUnit: compatible ? `INR/${produce.unit}` : null,
      sourceUnit: 'INR/quintal',
      unitCompatible: compatible,
      askingPriceVsModal: !compatible || produce.pricePerUnit === null
        ? 'unavailable'
        : produce.pricePerUnit < modal! ? 'below' : produce.pricePerUnit > modal! ? 'above' : 'equal',
      unchangedOnConsecutiveReport,
    };
  });
  const status = rows.length === 0 ? 'missing' : rows.every((row) => row.stale) ? 'stale' : 'available';
  return {
    status,
    fetchedAt,
    sourceUnit: 'INR/quintal',
    source: {
      name: 'data.gov.in / AGMARKNET',
      url: 'https://www.data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi',
      attribution: 'Indicative mandi wholesale observations. They are not guaranteed farm-gate prices.',
    },
    items: rows,
  };
}
