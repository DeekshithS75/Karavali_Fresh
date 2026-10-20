import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.EXOTEL_ACCOUNT_SID = 'test-account';
process.env.EXOTEL_API_KEY = 'test-key';
process.env.EXOTEL_API_TOKEN = 'test-token';
process.env.EXOTEL_CALLER_ID = '+911234567890';
process.env.EXOTEL_REGION = 'mumbai';
process.env.EXOTEL_STATUS_CALLBACK_URL = 'https://calls.example.test';

const { createExotelBridgedCall, ExotelCallError } = await import('../src/providers/calls.js');

test('Exotel bridges Consumer first to Farmer with the business caller ID and secured status callback', async (context: TestContext) => {
  let requestUrl = '';
  let requestBody = '';
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ Call: { Sid: 'CA123456789', Status: 'queued' } }), { status: 200 });
  });
  const result = await createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' });
  assert.equal(requestUrl, 'https://api.in.exotel.com/v1/Accounts/test-account/Calls/connect');
  const parameters = new URLSearchParams(requestBody);
  assert.equal(parameters.get('From'), '+919876543210');
  assert.equal(parameters.get('To'), '+919876543211');
  assert.equal(parameters.get('CallerId'), '+911234567890');
  assert.equal(parameters.get('CustomField'), 'attempt-id-123');
  assert.match(parameters.get('StatusCallback') ?? '', /https:\/\/calls\.example\.test\/api\/provider\/exotel\/calls\/private-callback-token/);
  assert.equal(result.providerReference, 'CA123456789');
  assert.equal(result.status, 'queued');
});

test('Exotel network failures are marked ambiguous so automatic retries cannot place duplicate calls', async (context: TestContext) => {
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('socket closed'); });
  await assert.rejects(createExotelBridgedCall({ consumerPhone: '+919876543210', farmerPhone: '+919876543211', callAttemptId: 'attempt-id-123', callbackToken: 'private-callback-token' }), (error) => error instanceof ExotelCallError && error.ambiguous);
});
