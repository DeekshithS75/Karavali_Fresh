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

test('parses official API record fields and normalizes the source observation date', () => {
  const parsed = provider.parseDataGovResponse({ total: 1, count: 1, limit: 20, offset: 0, records: [fictionalRow()] });
  assert.equal(parsed.records[0]?.arrivalDate, '2026-10-18');
  assert.equal(parsed.records[0]?.modalPrice, 2500);
  assert.equal(parsed.records[0]?.commodity, 'Tomato');
});

test('rejects an incompatible API shape instead of returning fabricated records', () => {
  assert.throws(() => provider.parseDataGovResponse({ total: 1, count: 1, limit: 20, offset: 0, data: [fictionalRow()] }), /response_invalid/);
  assert.throws(() => provider.parseDataGovResponse({ total: 1, count: 1, limit: 20, offset: 0, records: [{ title: 'Tomato', price: 30 }] }), /response_invalid/);
});

test('requests only Karnataka, one district, and the exact commodity with a bounded page size', async () => {
  const requested: URL[] = [];
  const result = await provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-data-gov-key', async (input) => {
    requested.push(new URL(String(input)));
    return Response.json({ total: 1, count: 1, limit: 20, offset: 0, records: [fictionalRow()] });
  });
  assert.equal(requested[0]?.pathname, `/resource/${provider.DATA_GOV_MANDI_RESOURCE_ID}`);
  assert.equal(requested[0]?.searchParams.get('api-key'), 'fictional-data-gov-key');
  assert.equal(requested[0]?.searchParams.get('format'), 'json');
  assert.equal(requested[0]?.searchParams.get('limit'), '20');
  assert.equal(requested[0]?.searchParams.get('offset'), '0');
  assert.equal(requested[0]?.searchParams.get('filters[state]'), 'Karnataka');
  assert.equal(requested[0]?.searchParams.get('filters[district]'), 'Udupi');
  assert.equal(requested[0]?.searchParams.get('filters[commodity]'), 'Tomato');
  assert.equal(result.records.length, 1);
});

test('paginates only while the filtered API total requires another page and caches each query', async () => {
  provider.marketPriceProvider.clearCache();
  const requested: URL[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input)); requested.push(url);
    const district = url.searchParams.get('filters[district]');
    if (district === 'Dakshina Kannada') return Response.json({ total: 0, count: 0, limit: 20, offset: Number(url.searchParams.get('offset')), records: [] });
    const offset = Number(url.searchParams.get('offset'));
    const records = offset === 0 ? Array.from({ length: 20 }, (_, index) => fictionalRow({ market: `Fictional Market ${index}`, arrival_date: '18/10/2026' })) : [fictionalRow({ market: 'Fictional Last Market' })];
    return Response.json({ total: 21, count: records.length, limit: 20, offset, records });
  };
  const first = await provider.getRelevantRecords(['Tomato'], 'fictional-key', fetchMock);
  assert.equal(first.records.length, 21);
  assert.equal(requested.length, 3);
  assert.deepEqual(requested.map((url) => [url.searchParams.get('filters[state]'), url.searchParams.get('filters[district]'), url.searchParams.get('filters[commodity]'), url.searchParams.get('offset')]), [
    ['Karnataka', 'Dakshina Kannada', 'Tomato', '0'],
    ['Karnataka', 'Udupi', 'Tomato', '0'],
    ['Karnataka', 'Udupi', 'Tomato', '20'],
  ]);
  await provider.getRelevantRecords(['Tomato'], 'fictional-key', fetchMock);
  assert.equal(requested.length, 3);
  provider.marketPriceProvider.clearCache();
});

test('coastal filtering keeps only Karnataka coastal-district records present in the response', () => {
  const records = [
    parsedRecord(fictionalRow({ district: 'Dakshina Kannada', market: 'Mangalore Sample APMC' })),
    parsedRecord(fictionalRow({ district: 'Udupi', market: 'Udupi Sample APMC' })),
    parsedRecord(fictionalRow({ district: 'Uttara Kannada', market: 'Karwar Sample APMC' })),
    parsedRecord(fictionalRow({ district: 'Mysuru', market: 'Mysuru Sample APMC' })),
    parsedRecord(fictionalRow({ state: 'Kerala', district: 'Udupi', market: 'Wrong State Sample' })),
  ];
  assert.deepEqual(records.filter(provider.isCoastalKarnatakaRecord).map(({ market }) => market), [
    'Mangalore Sample APMC', 'Udupi Sample APMC',
  ]);
});

test('commodity comparison is exact after Unicode and punctuation normalization, not substring fuzzy matching', () => {
  assert.equal(provider.matchesProduceCommodity(parsedRecord(fictionalRow({ commodity: 'Tomato' })), ['Tomatoes']), false);
  assert.equal(provider.matchesProduceCommodity(parsedRecord(fictionalRow({ commodity: 'Tomato' })), ['टमाटर', 'Tomato']), true);
  assert.equal(provider.matchesProduceCommodity(parsedRecord(fictionalRow({ commodity: 'Cherry Tomato' })), ['Tomato']), false);
});

test('converts quintal to kilogram only; bunch and piece units remain incompatible', () => {
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'kg'), 25);
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'quintal'), 2500);
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'bunch'), null);
  assert.equal(comparison.convertSourceQuintalPrice(2500, 'pieces'), null);
});

test('reports missing data, marks old observations stale, and never treats a missing report as stable', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const produce = { name: 'Tomato', unit: 'kg' as const, pricePerUnit: 30 };
  assert.equal(comparison.buildFarmerMarketComparison(produce, [], now.toISOString(), new Map(), now).status, 'missing');
  const stale = parsedRecord(fictionalRow({ arrival_date: '01/10/2026' }));
  const result = comparison.buildFarmerMarketComparison(produce, [stale], now.toISOString(), new Map(), now);
  assert.equal(result.status, 'stale');
  assert.equal(result.items[0]?.stale, true);
  assert.equal(result.items[0]?.unchangedOnConsecutiveReport, null);
});

test('reports stable prices only for matching consecutive daily observations', () => {
  const current = parsedRecord();
  const prior = { ...current, arrivalDate: '2026-10-17' };
  const key = provider.marketRecordKey(current);
  const result = comparison.buildFarmerMarketComparison(
    { name: 'Tomato', unit: 'kg', pricePerUnit: 30 }, [current], '2026-10-18T12:00:00.000Z',
    new Map([[`${key}|2026-10-17`, prior]]), new Date('2026-10-18T12:00:00.000Z'),
  );
  assert.equal(result.items[0]?.unchangedOnConsecutiveReport, true);
  const changed = comparison.buildFarmerMarketComparison(
    { name: 'Tomato', unit: 'kg', pricePerUnit: 30 }, [current], '2026-10-18T12:00:00.000Z',
    new Map([[`${key}|2026-10-16`, { ...prior, arrivalDate: '2026-10-16' }]]), new Date('2026-10-18T12:00:00.000Z'),
  );
  assert.equal(changed.items[0]?.unchangedOnConsecutiveReport, null);
});

test('handles upstream HTTP and network failures without producing sample prices', async () => {
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => new Response('', { status: 503 })), /unavailable/);
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => new Response('', { status: 403 })), /invalid_api_key/);
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => new Response('', { status: 429 })), /rate_limited/);
  await assert.rejects(provider.requestDataGovPage(0, 'Udupi', 'Tomato', 'fictional-key', async () => { throw new Error('network down'); }), /unavailable/);
});

async function withServer(context: TestContext) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return (authorization = `Bearer ${token}`) => fetch(`http://127.0.0.1:${address.port}/api/farmer/produce/${produceId}/market-comparison`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
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

test('protected market comparison requires an authenticated Farmer session', async (context) => {
  const get = await withServer(context);
  const response = await get('');
  assert.equal(response.status, 401);
});

test('market comparison queries only the produce owned by the authenticated Farmer', async (context) => {
  authenticateAsOwner(context);
  context.mock.method(models.ProduceModel, 'findOne', (query: unknown) => {
    assert.equal(String((query as { farmerId: unknown }).farmerId), ownerId);
    assert.equal(String((query as { _id: unknown })._id), produceId);
    return { lean: () => ({ exec: async () => ({ _id: produceId, name: 'Fictional Herb', unit: 'bunch', pricePerUnit: 40 }) }) } as never;
  });
  context.mock.method(provider.marketPriceProvider, 'getCoastalRecords', async () => ({ records: [], fetchedAt: '2026-10-18T12:00:00.000Z' }));
  const get = await withServer(context);
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json() as { comparison: { status: string; items: unknown[] } };
  assert.equal(body.comparison.status, 'missing');
  assert.deepEqual(body.comparison.items, []);
});

test('returns converted unit prices and persists the source observation history', async (context) => {
  authenticateAsOwner(context);
  context.mock.method(models.ProduceModel, 'findOne', () => ({ lean: () => ({ exec: async () => ({
    _id: produceId, name: 'Tomato', nameTranslations: { kn: 'Tomato' }, unit: 'kg', pricePerUnit: 30,
  }) }) }) as never);
  context.mock.method(provider.marketPriceProvider, 'getCoastalRecords', async () => ({
    records: [parsedRecord()], fetchedAt: '2026-10-18T12:00:00.000Z',
  }));
  context.mock.method(models.MarketPriceObservationModel, 'find', (query: unknown) => {
    assert.ok(Array.isArray((query as { $or: unknown[] }).$or));
    return { lean: () => ({ exec: async () => [] }) } as never;
  });
  context.mock.method(models.MarketPriceObservationModel, 'bulkWrite', async (operations: Array<{ updateOne: { filter: { recordKey: string; arrivalDate: string }; update: { $set: { modalPrice: number } }; upsert: boolean } }>) => {
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.updateOne.upsert, true);
    assert.equal(operations[0]?.updateOne.filter.arrivalDate, '2026-10-18');
    assert.equal(operations[0]?.updateOne.update.$set.modalPrice, 2500);
    return { acknowledged: true } as never;
  });
  const get = await withServer(context);
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json() as { comparison: { status: string; fetchedAt: string; items: Array<{ market: string; minPrice: number; maxPrice: number; modalPrice: number; priceUnit: string; sourceDate: string; askingPriceVsModal: string }> } };
  assert.equal(body.comparison.status, 'available');
  assert.equal(body.comparison.fetchedAt, '2026-10-18T12:00:00.000Z');
  assert.equal(body.comparison.items[0]?.market, 'Fictional Local Mandi');
  assert.equal(body.comparison.items[0]?.minPrice, 22);
  assert.equal(body.comparison.items[0]?.maxPrice, 28);
  assert.equal(body.comparison.items[0]?.modalPrice, 25);
  assert.equal(body.comparison.items[0]?.priceUnit, 'INR/kg');
  assert.equal(body.comparison.items[0]?.sourceDate, '2026-10-18');
  assert.equal(body.comparison.items[0]?.askingPriceVsModal, 'above');
});

test('a different Farmer cannot compare another Farmer listing', async (context) => {
  authenticateAsOwner(context);
  let providerCalled = false;
  context.mock.method(models.ProduceModel, 'findOne', (query: unknown) => {
    assert.equal(String((query as { farmerId: unknown }).farmerId), ownerId);
    assert.notEqual(String((query as { farmerId: unknown }).farmerId), otherId);
    return { lean: () => ({ exec: async () => null }) } as never;
  });
  context.mock.method(provider.marketPriceProvider, 'getCoastalRecords', async () => { providerCalled = true; return { records: [], fetchedAt: new Date().toISOString() }; });
  const get = await withServer(context);
  const response = await get();
  assert.equal(response.status, 404);
  assert.equal(providerCalled, false);
});
