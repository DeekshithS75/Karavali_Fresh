import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.EXOTEL_ACCOUNT_SID = 'test-account';
process.env.EXOTEL_API_KEY = 'test-key';
process.env.EXOTEL_API_TOKEN = 'test-token';
process.env.EXOTEL_CALLER_ID = '+911234567890';
process.env.EXOTEL_REGION = 'mumbai';
process.env.EXOTEL_STATUS_CALLBACK_URL = 'https://calls.example.test';

const [{ createExotelBridgedCall, ExotelCallError, isExotelCallConfigured }, { config }] = await Promise.all([
  import('../src/providers/calls.js'), import('../src/config.js'),
]);

test('Exotel calls the Farmer first then bridges the Buyer using Basic auth and a secured status callback', async (context: TestContext) => {
  let requestUrl = '';
  let requestBody = '';
  let authorization = '';
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    authorization = (init?.headers as Record<string, string>).Authorization ?? '';
    return new Response(JSON.stringify({ Call: { Sid: 'CA123456789', Status: 'queued' } }), { status: 200 });
  });
  const result = await createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' });
  assert.equal(requestUrl, 'https://api.in.exotel.com/v1/Accounts/test-account/Calls/connect.json');
  assert.equal(authorization, 'Basic ' + Buffer.from('test-key:test-token').toString('base64'));
  assert.equal(requestUrl.includes('private-callback-token'), false);
  assert.equal(requestBody.includes('private-callback-token'), true);
  const parameters = new URLSearchParams(requestBody);
  assert.equal(parameters.get('From'), '+919876543211');
  assert.equal(parameters.get('To'), '+919876543210');
  assert.equal(parameters.get('CallerId'), '+911234567890');
  assert.equal(parameters.get('CallType'), 'trans');
  assert.equal(parameters.get('StatusCallbackContentType'), 'application/json');
  assert.deepEqual([parameters.get('StatusCallbackEvents[0]'), parameters.get('StatusCallbackEvents[1]')], ['terminal', 'answered']);
  assert.equal(parameters.get('CustomField'), 'attempt-id-123');
  assert.match(parameters.get('StatusCallback') ?? '', /https:\/\/calls\.example\.test\/api\/provider\/exotel\/calls\/private-callback-token/);
  assert.equal(result.providerReference, 'CA123456789');
  assert.equal(result.status, 'queued');
});

test('Exotel busy and no-answer results stay call failures with their reason', async (context: TestContext) => {
  for (const status of ['busy', 'no-answer', 'failed']) {
    context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ Call: { Sid: 'CA123456789', Status: status } }), { status: 200 }));
    const result = await createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, status);
    context.mock.restoreAll();
  }
});

test('Exotel network failures are marked ambiguous so automatic retries cannot place duplicate calls', async (context: TestContext) => {
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('socket closed'); });
  await assert.rejects(createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' }), (error) => error instanceof ExotelCallError && error.ambiguous);
});

test('Exotel authentication rejection records sanitized diagnostics without exposing them in the error message', async (context: TestContext) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ RestException: { Status: 401, Code: 'AUTH_FAILED', Message: 'private provider detail +919876543210' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(
    createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' }),
    (error) => error instanceof ExotelCallError && error.code === 'provider_authentication_failed' && !error.ambiguous
      && error.diagnostic.httpStatus === 401 && error.diagnostic.providerCode === 'AUTH_FAILED'
      && !JSON.stringify(error.diagnostic).includes('+919876543210') && !error.message.includes('private provider detail')
      && error.diagnostic.providerMessage?.includes('private provider detail'),
  );
});

test('Connect accepts a successful XML response from Exotel without treating submission as an answered call', async (context: TestContext) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('<TwilioResponse><Call><Sid>CA123456789</Sid><Status>queued</Status></Call></TwilioResponse>', { status: 200, headers: { 'content-type': 'application/xml' } }));
  const result = await createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' });
  assert.deepEqual(result, { providerReference: 'CA123456789', status: 'queued' });
});

test('Connect classifies invalid request responses with safe provider diagnostics', async (context: TestContext) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('<TwilioResponse><RestException><Status>400</Status><Code>BAD_CALLER_ID</Code><Message>Invalid caller id</Message></RestException></TwilioResponse>', { status: 400, headers: { 'content-type': 'application/xml' } }));
  await assert.rejects(
    createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' }),
    (error) => error instanceof ExotelCallError && error.code === 'provider_request_invalid' && error.diagnostic.httpStatus === 400 && error.diagnostic.providerCode === 'BAD_CALLER_ID' && error.diagnostic.providerMessage === 'Invalid caller id',
  );
});

test('malformed successful provider response stays ambiguous to prevent duplicate retry calls', async (context: TestContext) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('<not-valid-provider-call>', { status: 200, headers: { 'content-type': 'application/xml' } }));
  await assert.rejects(createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' }), (error) => error instanceof ExotelCallError && error.code === 'response_invalid' && error.ambiguous && error.diagnostic.stage === 'response_parse');
});

test('missing Exotel credentials fail configuration validation without exposing values', () => {
  const original = config.EXOTEL_API_TOKEN;
  config.EXOTEL_API_TOKEN = undefined;
  try {
    assert.equal(isExotelCallConfigured(), false);
  } finally {
    config.EXOTEL_API_TOKEN = original;
  }
});

test('Singapore configuration selects the regional Connect host', async (context: TestContext) => {
  const original = config.EXOTEL_REGION;
  config.EXOTEL_REGION = 'singapore';
  let requestUrl = '';
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ Call: { Sid: 'CA123456789', Status: 'queued' } }), { status: 200 });
  });
  try {
    await createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' });
    assert.match(requestUrl, /^https:\/\/api\.exotel\.com\//);
  } finally {
    config.EXOTEL_REGION = original;
  }
});
