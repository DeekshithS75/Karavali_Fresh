import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.TOKEN_HMAC_SECRET = 'fictional-market-price-test-secret'.padEnd(48, 'x');

const [provider, comparison, { default: app }, models, { hmac }] = await Promise.all([
  import('../src/providers/market-prices.js'),
  import('../src/services/market-comparison.js'),
  import('../src/app.js'),
  import('../src/models/index.js'),
  import('../src/crypto.js'),
]);

const ownerId = 'fictional-owner-id';
const otherId = 'fictional-other-owner-id';
const token = 'fictional-market-session-token-123456789012345678';
const produceId = '65eecb934100000000000001';
const today = '2026-10-18';
const fictionalRow = (overrides: Record<string, unknown> = {}) => ({
  state: 'Karnataka', district: 'Udupi', market: 'Fictional Local Mandi', commodity: 'Tomato',
  variety: 'Fictional Round', grade: 'Fictional A', arrival_date: '18/10/2026',
  min_price: '2200', max_price: '2800', modal_price: '2500', ...overrides,
});
const parsedRecord = (row = fictionalRow()) => {
  const record = provider.parseDataGovRecord(row);
  assert.ok(record);
  return record;
};
const dataset = (records: ReturnType<typeof parsedRecord>[], overrides: Record<string, unknown> = {}) => ({
  records, fetchedAt: `${today}T12:00:00.000Z`, truncated: false, stage: 'origin_district' as const,
  originDistrict: 'Udupi', commodity: 'Tomato', freshnessDays: 7, ...overrides,
});

test('parses official API field names and normalizes the source date', () => {
  const parsed = provider.parseDataGovResponse({ total: 1, count: 1, limit: 20, offset: 0, records: [fictionalRow()] });
  assert.equal(parsed.records[0]?.arrivalDate, today);
  assert.equal(parsed.records[0]?.modalPrice, 2500);
  assert.equal(parsed.records[0]?.commodity, 'Tomato');
});

test('rejects invalid upstream shapes and records', () => {
  assert.throws(() => provider.parseDataGovResponse({ total: 1, count: 1, limit: 20, offset: 0, data: [fictionalRow()] }), /response_invalid/);
  assert.throws(() => provider.parseDataGovResponse({ total: 1, count: 1, limit: 20, offset: 0, records: [{ title: 'Tomato', price: 30 }] }), /response_invalid/);
});

test('sends only bounded Karnataka, district, and exact commodity filters', async () => {
  const requested: URL[] = [];
  await provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-data-gov-key', async (input) => {
    requested.push(new URL(String(input)));
    return Response.json({ total: 0, count: 0, limit: 20, offset: 0, records: [] });
  });
  assert.equal(requested[0]?.pathname, `/resource/${provider.DATA_GOV_MANDI_RESOURCE_ID}`);
  assert.equal(requested[0]?.searchParams.get('format'), 'json');
  assert.equal(requested[0]?.searchParams.get('limit'), '20');
  assert.equal(requested[0]?.searchParams.get('offset'), '0');
  assert.equal(requested[0]?.searchParams.get('filters[state]'), 'Karnataka');
  assert.equal(requested[0]?.searchParams.get('filters[district]'), 'Udupi');
  assert.equal(requested[0]?.searchParams.get('filters[commodity]'), 'Tomato');
});

test('falls through absent local and coastal rows to bounded Karnataka-wide exact-commodity results', async () => {
  provider.marketPriceProvider.clearCache();
  const requested: URL[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input)); requested.push(url);
    const district = url.searchParams.get('filters[district]');
    const offset = Number(url.searchParams.get('offset'));
    if (district) return Response.json({ total: 0, count: 0, limit: 20, offset, records: [] });
    return Response.json({ total: 1, count: 1, limit: 20, offset, records: [fictionalRow({ district: 'Bengaluru South', market: 'Ramanagara APMC' })] });
  };
  const result = await provider.getRelevantRecords(['Tomato'], 'Dakshina Kannada', 'fictional-key', fetchMock, true, today);
  assert.equal(result.stage, 'karnataka_wide');
  assert.equal(result.records[0]?.district, 'Bengaluru South');
  assert.equal(result.records[0]?.market, 'Ramanagara APMC');
  assert.ok(requested.some((url) => url.searchParams.get('filters[district]') === 'Dakshina Kannada'));
  assert.ok(requested.some((url) => url.searchParams.get('filters[district]') === 'Udupi'));
  assert.ok(requested.some((url) => url.searchParams.get('filters[district') === null));
  assert.ok(requested.every((url) => url.searchParams.get('filters[state]') === 'Karnataka' && url.searchParams.get('filters[commodity]') === 'Tomato'));
  provider.marketPriceProvider.clearCache();
});

test('uses cache for repeated exact filters and paginates only when source total requires it', async () => {
  provider.marketPriceProvider.clearCache();
  const requested: URL[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input)); requested.push(url);
    const offset = Number(url.searchParams.get('offset'));
    const records = offset === 0 ? Array.from({ length: 20 }, (_, index) => fictionalRow({ market: `Fictional ${index}` })) : [fictionalRow({ market: 'Fictional final row' })];
    return Response.json({ total: 21, count: records.length, limit: 20, offset, records });
  };
  const result = await provider.getRelevantRecords(['Tomato'], 'Udupi', 'fictional-key', fetchMock, true, today);
  assert.equal(result.records.length, 21);
  assert.equal(requested.filter((url) => url.searchParams.get('filters[district]') === 'Udupi').length, 2);
  await provider.getRelevantRecords(['Tomato'], 'Udupi', 'fictional-key', fetchMock, false, today);
  assert.equal(requested.filter((url) => url.searchParams.get('filters[district]') === 'Udupi').length, 2);
  provider.marketPriceProvider.clearCache();
});

test('a recent selected-district report takes priority without querying other districts', async () => {
  provider.marketPriceProvider.clearCache();
  const requested: URL[] = [];
  const result = await provider.getRelevantRecords(['Tomato'], 'Udupi', 'fictional-key', async (input) => {
    requested.push(new URL(String(input)));
    return Response.json({ total: 1, count: 1, limit: 20, offset: 0, records: [fictionalRow()] });
  }, true, today);
  assert.equal(result.stage, 'origin_district');
  assert.equal(result.records[0]?.district, 'Udupi');
  assert.equal(requested.length, 1);
  provider.marketPriceProvider.clearCache();
});

test('a nearby coastal report is used when the selected district has no recent row', async () => {
  provider.marketPriceProvider.clearCache();
  const requested: URL[] = [];
  const result = await provider.getRelevantRecords(['Tomato'], 'Dakshina Kannada', 'fictional-key', async (input) => {
    const url = new URL(String(input)); requested.push(url);
    const district = url.searchParams.get('filters[district]');
    const offset = Number(url.searchParams.get('offset'));
    if (district === 'Udupi') return Response.json({ total: 1, count: 1, limit: 20, offset, records: [fictionalRow()] });
    return Response.json({ total: 0, count: 0, limit: 20, offset, records: [] });
  }, true, today);
  assert.equal(result.stage, 'coastal_district');
  assert.equal(result.records[0]?.district, 'Udupi');
  assert.ok(requested.some((url) => url.searchParams.get('filters[district]') === 'Dakshina Kannada'));
  assert.ok(requested.some((url) => url.searchParams.get('filters[district]') === 'Udupi'));
  provider.marketPriceProvider.clearCache();
});

test('commodity matching uses exact reviewed aliases, not substring matching', () => {
  assert.equal(provider.matchesProduceCommodity(parsedRecord(), ['Tomato']), true);
  assert.equal(provider.matchesProduceCommodity(parsedRecord(fictionalRow({ commodity: 'Cherry Tomato' })), ['Tomato']), false);
  assert.equal(provider.matchesProduceCommodity(parsedRecord(fictionalRow({ commodity: 'Brinjal' })), ['Eggplant']), true);
  assert.deepEqual([
    provider.resolveOfficialCommodity(['ಟೊಮೇಟೊ']),
    provider.resolveOfficialCommodity(['ಬದನೆಕಾಯಿ']),
    provider.resolveOfficialCommodity(['ಬೆಂಡೆಕಾಯಿ']),
    provider.resolveOfficialCommodity(['ಹೀರೆಕಾಯಿ']),
    provider.resolveOfficialCommodity(['ಹಸಿಮೆಣಸಿನಕಾಯಿ']),
  ], ['Tomato', 'Brinjal', 'Ladies Finger', 'Ridgeguard(Tori)', 'Green Chilli']);
  assert.equal(provider.resolveOfficialCommodity(['Tomato', 'ಬದನೆಕಾಯಿ']), null);
  assert.equal(provider.resolveOfficialCommodity(['Unknown fictional crop']), null);
  assert.equal(provider.matchesProduceCommodity(parsedRecord(fictionalRow({ commodity: 'Ginger(Green)' })), ['ಹಸಿಮೆಣಸಿನಕಾಯಿ']), false);
  assert.equal(provider.parseDataGovRecord(fictionalRow({ min_price: '-4' })), null);
  assert.equal(provider.parseDataGovRecord(fictionalRow({ modal_price: '9000' })), null);
});

test('uses district reference points to sort and label approximate fallback distance', () => {
  const records = [
    parsedRecord(fictionalRow({ district: 'Mysuru', market: 'Farther Example' })),
    parsedRecord(fictionalRow({ district: 'Dakshina Kannada', market: 'Coastal Example' })),
  ];
  const result = comparison.buildFarmerMarketComparison({ name: 'Tomato', unit: 'kg', pricePerUnit: null }, dataset(records, { stage: 'karnataka_wide' }), new Map(), new Date(`${today}T12:00:00.000Z`));
  assert.equal(result.items[0]?.market, 'Coastal Example');
  assert.equal(result.items[0]?.fallbackLevel, 'coastal_district');
  assert.equal(result.items[0]?.distanceMethod, 'district_reference_approximation');
  assert.equal(result.items[1]?.distanceMethod, 'district_reference_approximation');
  assert.ok((result.items[1]?.distanceKm ?? 0) > 0);
});

test('marks distance selection incomplete when a returned district lacks a verified reference point', () => {
  const unknown = parsedRecord(fictionalRow({ district: 'Fictional District Without a Map Reference' }));
  const result = comparison.buildFarmerMarketComparison({ name: 'Tomato', unit: 'kg', pricePerUnit: null }, dataset([unknown], { stage: 'karnataka_wide' }), new Map(), new Date(`${today}T12:00:00.000Z`));
  assert.equal(result.selectionComplete, false);
  assert.equal(result.items[0]?.distanceMethod, 'unavailable');
});

test('reports capped pagination as truncated', async () => {
  provider.marketPriceProvider.clearCache();
  const result = await provider.getRelevantRecords(['Tomato'], 'Udupi', 'fictional-key', async (input) => {
    const offset = Number(new URL(String(input)).searchParams.get('offset'));
    const records = Array.from({ length: 20 }, (_, index) => fictionalRow({ market: `Fictional market ${offset + index}` }));
    return Response.json({ total: 101, count: 20, limit: 20, offset, records });
  }, true, today);
  assert.equal(result.records.length, 100);
  assert.equal(result.truncated, true);
  provider.marketPriceProvider.clearCache();
});

test('converts quintal source prices to kg only and leaves piece-based units incomparable', () => {
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'kg'), 25);
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'quintal'), 2500);
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'bunch'), null);
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'pieces'), null);
});

test('marks stale or missing observations explicitly and does not imply unchanged prices without a prior daily report', () => {
  const now = new Date(`${today}T12:00:00.000Z`);
  assert.equal(comparison.buildFarmerMarketComparison({ name: 'Tomato', unit: 'kg', pricePerUnit: 30 }, dataset([]), new Map(), now).status, 'missing');
  const stale = parsedRecord(fictionalRow({ arrival_date: '01/10/2026' }));
  const result = comparison.buildFarmerMarketComparison({ name: 'Tomato', unit: 'kg', pricePerUnit: 30 }, dataset([stale]), new Map(), now);
  assert.equal(result.status, 'stale');
  assert.equal(result.items[0]?.stale, true);
  assert.equal(result.items[0]?.unchangedOnConsecutiveReport, null);
});

test('does not report stable prices when yesterday had no observation', () => {
  const current = parsedRecord();
  const result = comparison.buildFarmerMarketComparison({ name: 'Tomato', unit: 'kg', pricePerUnit: 30 }, dataset([current]), new Map(), new Date(`${today}T12:00:00.000Z`));
  assert.equal(result.items[0]?.unchangedOnConsecutiveReport, null);
});

test('handles upstream HTTP and network failures without inventing values', async () => {
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => new Response('', { status: 503 })), /unavailable/);
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => new Response('', { status: 403 })), /invalid_api_key/);
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => new Response('', { status: 429 })), /rate_limited/);
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => { throw new Error('network down'); }), /unavailable/);
});

async function withServer(context: TestContext, route = `/api/farmer/produce/${produceId}/market-comparison`) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return (authorization = `Bearer ${token}`, path = route) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: authorization ? { Authorization: authorization } : {} });
}

function authenticateAsOwner(context: TestContext) {
  context.mock.method(models.SessionModel, 'findOne', async (query: unknown) => {
    assert.equal((query as { tokenHash: string }).tokenHash, hmac(token));
    return { farmerId: ownerId, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } as never;
  });
  context.mock.method(models.FarmerModel, 'findById', async () => ({
    _id: ownerId, accountStatus: 'active', phoneVerificationStatus: 'verified', documentComparisonStatus: 'passed',
  }) as never);
}

test('protected market comparison requires a valid Farmer session', async (context) => {
  const get = await withServer(context);
  assert.equal((await get('')).status, 401);
});

test('a Farmer can compare only their own produce listing', async (context) => {
  authenticateAsOwner(context);
  context.mock.method(models.ProduceModel, 'findOne', (query: unknown) => {
    assert.equal(String((query as { farmerId: unknown }).farmerId), ownerId);
    assert.equal(String((query as { _id: unknown })._id), produceId);
    return { lean: () => ({ exec: async () => ({ _id: produceId, name: 'Fictional Herb', unit: 'bunch', pricePerUnit: 40 }) }) } as never;
  });
  context.mock.method(provider.marketPriceProvider, 'getRelevantRecords', async () => dataset([]));
  const get = await withServer(context);
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json() as { comparison: { status: string; items: unknown[] } };
  assert.equal(body.comparison.status, 'missing');
  assert.deepEqual(body.comparison.items, []);
});

test('market quote endpoint is protected and returns the source rows before an asking price exists', async (context) => {
  authenticateAsOwner(context);
  context.mock.method(models.MarketPriceObservationModel, 'find', () => ({ lean: () => ({ exec: async () => [] }) }) as never);
  context.mock.method(models.MarketPriceObservationModel, 'bulkWrite', async () => ({ acknowledged: true }) as never);
  context.mock.method(provider.marketPriceProvider, 'getRelevantRecords', async (names: string[]) => {
    assert.deepEqual(names, ['Tomato', 'ಟೊಮೇಟೊ']);
    return dataset([parsedRecord()]);
  });
  const path = '/api/farmer/market-quote?commodity=Tomato&nameKn=ಟೊಮೇಟೊ&unit=kg';
  const get = await withServer(context, path);
  assert.equal((await get('')).status, 401);
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json() as { comparison: { items: Array<{ market: string; modalPrice: number; sourceDate: string; farmerPrice: number | null }> } };
  assert.equal(body.comparison.items[0]?.market, 'Fictional Local Mandi');
  assert.equal(body.comparison.items[0]?.modalPrice, 25);
  assert.equal(body.comparison.items[0]?.sourceDate, today);
  assert.equal(body.comparison.items[0]?.farmerPrice, null);
});

test('market quote reports a missing API key as explicit provider configuration failure', async (context) => {
  authenticateAsOwner(context);
  context.mock.method(provider.marketPriceProvider, 'getRelevantRecords', async () => { throw new provider.MarketPriceProviderError('not_configured'); });
  const get = await withServer(context, '/api/farmer/market-quote?commodity=Tomato&unit=kg');
  const response = await get();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'market_price_provider_not_configured' });
});

test('another Farmer cannot retrieve a different Farmer listing', async (context) => {
  authenticateAsOwner(context);
  context.mock.method(models.ProduceModel, 'findOne', (query: unknown) => {
    assert.equal(String((query as { farmerId: unknown }).farmerId), ownerId);
    assert.notEqual(String((query as { farmerId: unknown }).farmerId), otherId);
    return { lean: () => ({ exec: async () => null }) } as never;
  });
  const get = await withServer(context);
  assert.equal((await get()).status, 404);
});
