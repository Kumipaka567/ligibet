const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentGateways, phoneNumber } = require('../payment-gateways');
const deposit = { id: 7, amount: 100, payer_phone: '254712345678', external_reference: 'INTERNAL-7', account_reference: 'LIGI-7', mpesa_checkout_request_id: 'ws_CO_test' };
const env = { NEXUSPAY_API_KEY: 'test-secret', PAYHERO_AUTH_TOKEN: 'test-token', PAYHERO_CHANNEL_ID: '1', PAYHERO_CALLBACK_URL: 'https://example.test/callback' };

test('Nexus Pay submits the documented request and optional settlement routing without a customer callback URL', async () => {
  const requests = [];
  const gateways = createPaymentGateways({ env: { ...env, NEXUSPAY_SETTLEMENT_ACCOUNT_ID: '4', NEXUSPAY_TENANT_CODE: 'tnnt_test' }, http: {
    post: async (...args) => { requests.push(args); return { data: { checkoutRequestId: 'ws_CO_test', responseCode: '0', transactionId: 42 } }; }
  } });
  assert.deepEqual(await gateways.initiate('nexuspay', deposit, 'Customer'), { checkoutRequestId: 'ws_CO_test', providerReference: '42' });
  assert.equal(requests[0][0], 'https://makamescopay.com/api/payments/stkpush');
  assert.deepEqual(requests[0][1], { phoneNumber: '254712345678', amount: 100, accountReference: 'LIGI-7', transactionDesc: 'M-Pesa deposit', settlementAccountId: 4, tenantCode: 'tnnt_test' });
  assert.equal(requests[0][2].headers['X-API-Key'], 'test-secret');
  assert.equal(requests[0][2].headers.Authorization, undefined);
});

test('Nexus Pay confirms matching checkout, amount, phone and receipt, and rejects mismatches', async () => {
  let body = { checkoutRequestId: 'ws_CO_test', status: 'completed', amount: '100.00', phoneNumber: '254712345678', mpesaReceiptNumber: 'RBK71G1234' };
  const calls = [];
  const gateways = createPaymentGateways({ env, http: { get: async (...args) => { calls.push(args); return { data: body }; } } });
  const result = await gateways.check('nexuspay', deposit);
  assert.equal(result.status, 'completed');
  assert.equal(result.receipt, 'RBK71G1234');
  assert.equal(calls[0][0], 'https://makamescopay.com/api/payments/status/ws_CO_test');
  assert.equal(calls[0][1].headers['X-API-Key'], 'test-secret');
  const original = { ...body };
  for (const patch of [{ checkoutRequestId: 'another-payment' }, { amount: '99.00' }, { amount: '100junk' }, { phoneNumber: '254711112222' }, { phoneNumber: undefined }, { mpesaReceiptNumber: '' }, { status: 'success' }]) {
    body = { ...original, ...patch };
    await assert.rejects(gateways.check('nexuspay', deposit));
  }
  for (const status of ['pending', 'failed', 'cancelled']) {
    body = { checkoutRequestId: 'ws_CO_test', status };
    assert.equal((await gateways.check('nexuspay', deposit)).status, status);
  }
});

test('PayHero keeps its request format and matches payments only by their stored references', async () => {
  let rows = [{ transaction_type: 'inbound_payment', amount: 100, description: '712345678', provider_reference: 'RBK71G1234' }];
  let sent;
  const gateways = createPaymentGateways({ env, http: {
    post: async (...args) => { sent = args; return { data: { CheckoutRequestID: 'ws_CO_test', status: true } }; },
    get: async () => ({ data: { response: rows } })
  } });
  await gateways.initiate('payhero', deposit, 'Customer');
  assert.equal(sent[0], 'https://backend.payhero.co.ke/api/v2/payments');
  assert.equal(sent[1].external_reference, 'INTERNAL-7');
  assert.equal(sent[1].phone_number, '254712345678');
  assert.equal(sent[2].headers.Authorization, 'Basic test-token');
  assert.equal((await gateways.check('payhero', deposit)).status, 'pending');
  rows = [{ ...rows[0], external_reference: 'INTERNAL-7' }];
  assert.equal((await gateways.check('payhero', deposit)).status, 'completed');
});

test('unconfigured gateways cannot send requests and transport timeouts are distinguished from rejections', async () => {
  let calls = 0;
  const unconfigured = createPaymentGateways({ env: {}, http: { post: async () => { calls++; } } });
  await assert.rejects(unconfigured.initiate('nexuspay', deposit), { status: 503, definitive: true });
  assert.equal(calls, 0);
  assert.equal(unconfigured.available().find(item => item.id === 'nexuspay').configured, false);
  const timeout = createPaymentGateways({ env, http: { post: async () => { throw new Error('timeout with test-secret'); } } });
  await assert.rejects(timeout.initiate('nexuspay', deposit), cause => cause.definitive === false && !cause.message.includes('test-secret'));
  const rejected = createPaymentGateways({ env, http: { post: async () => ({ data: { responseCode: '1' } }) } });
  await assert.rejects(rejected.initiate('nexuspay', deposit), { definitive: true });
  assert.equal(phoneNumber('0712 345 678'), '254712345678');
  assert.equal(phoneNumber('+254712345678'), '254712345678');
  assert.throws(() => phoneNumber('199'));
});
