import assert from 'node:assert/strict';
import test from 'node:test';
import { Msg91OtpProvider } from '../src/providers/otp.js';

const phone = '+919876543210';

test('MSG91 send uses the purpose template, international number and server auth header', async () => {
  let observed: { url: URL; init?: RequestInit } | undefined;
  const provider = new Msg91OtpProvider('test-auth-key', {
    farmer_registration: 'registration-template', farmer_login: 'login-template',
  }, async (input, init) => {
    observed = { url: new URL(String(input)), init };
    return Response.json({ type: 'success', request_id: 'provider-reference' });
  });
  const result = await provider.send(phone, 'farmer_registration');
  assert.equal((observed?.url?.origin ?? '') + (observed?.url?.pathname ?? ''), 'https://control.msg91.com/api/v5/otp');
  assert.equal(observed?.url.searchParams.get('template_id'), 'registration-template');
  assert.equal(observed?.url.searchParams.get('mobile'), '919876543210');
  assert.equal(new Headers(observed?.init?.headers).get('authkey'), 'test-auth-key');
  assert.equal(observed?.init?.method, 'POST');
  assert.equal(result.providerReference, 'provider-reference');
});

test('MSG91 verify accepts only a provider success result and passes OTP via query', async () => {
  let observed: { url: URL; init?: RequestInit } | undefined;
  const provider = new Msg91OtpProvider('secret', { farmer_registration: 'r', farmer_login: 'l' }, async (input, init) => {
    observed = { url: new URL(String(input)), init };
    return Response.json({ message: 'OTP verified success', type: 'success' });
  });
  assert.equal(await provider.verify(phone, '123456'), true);
  assert.equal(observed?.url.pathname, '/api/v5/otp/verify');
  assert.equal(observed?.url.searchParams.get('mobile'), '919876543210');
  assert.equal(observed?.url.searchParams.get('otp'), '123456');
  assert.equal(observed?.init?.method, 'GET');
  const rejected = new Msg91OtpProvider('secret', { farmer_registration: 'r', farmer_login: 'l' }, async () => Response.json({ type: 'error', message: 'invalid otp' }));
  assert.equal(await rejected.verify(phone, '000000'), false);
});

test('MSG91 provider fails closed on non-success send responses, HTTP failures and invalid phone format', async () => {
  const rejected = new Msg91OtpProvider('secret', { farmer_registration: 'r', farmer_login: 'l' }, async () => Response.json({ type: 'error' }));
  await assert.rejects(rejected.send(phone, 'farmer_login'), /otp_provider_unavailable/);
  const unavailable = new Msg91OtpProvider('secret', { farmer_registration: 'r', farmer_login: 'l' }, async () => new Response('', { status: 401 }));
  await assert.rejects(unavailable.send(phone, 'farmer_login'), /otp_provider_unavailable/);
  await assert.rejects(rejected.send('9876543210', 'farmer_login'), /invalid_phone/);
});
