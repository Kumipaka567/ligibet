const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPayHeroBalanceFetcher } = require('../payhero-balance');

const wallet = (patch = {}) => ({
  wallet_type: 'service_wallet', available_balance: '466.80',
  account_id: 12571, currency: 'KES', ...patch
});
const env = { PAYHERO_AUTH_TOKEN: 'render-token' };
const makeFetcher = (data) => createPayHeroBalanceFetcher({
  env,
  httpClient: { get: async () => ({ data }) },
  now: () => new Date('2026-10-05T12:00:00.000Z')
});

test('queries service tokens with the configured server credentials and preserves account identity', async () => {
  const fetch = createPayHeroBalanceFetcher({
    env: { ...env, PAYHERO_BASE_URL: 'https://provider.example/api/v2/' },
    httpClient: { get: async (url, options) => {
      assert.equal(url, 'https://provider.example/api/v2/wallets');
      assert.deepEqual(options.params, { wallet_type: 'service_wallet' });
      assert.equal(options.headers.Authorization, 'Basic render-token');
      return { data: wallet() };
    } },
    now: () => new Date('2026-10-05T12:00:00.000Z')
  });
  assert.deepEqual(await fetch(), {
    configured: true, balance: 466.8, currency: 'KES', walletType: 'service_wallet',
    accountId: 12571, updatedAt: '2026-10-05T12:00:00.000Z'
  });
});

test('uses API username/password when a token is absent', async () => {
  const fetch = createPayHeroBalanceFetcher({
    env: { PAYHERO_API_USERNAME: ' new-user ', PAYHERO_API_PASSWORD: ' new-password ' },
    httpClient: { get: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('new-user:new-password').toString('base64'));
      return { data: wallet() };
    } }
  });
  assert.equal((await fetch()).balance, 466.8);
});

test('selects the explicit service wallet from supported wrappers rather than the first wallet', async () => {
  for (const data of [
    [{ wallet_type: 'payment_wallet', available_balance: 99000 }, wallet()],
    { response: [wallet()] }, { data: wallet() }, { data: { wallets: [wallet()] } }
  ]) assert.equal((await makeFetcher(data)()).balance, 466.8);
});

test('preserves a real zero and a negative available balance', async () => {
  assert.equal((await makeFetcher(wallet({ available_balance: '0.00' }))()).balance, 0);
  assert.equal((await makeFetcher(wallet({ available_balance: -1.5 }))()).balance, -1.5);
});

test('rejects missing, wrong or ambiguous wallets instead of inventing zero', async () => {
  for (const data of [
    {}, [], { available_balance: 100 },
    [{ wallet_type: 'payment_wallet', available_balance: 99000 }],
    [wallet(), wallet({ account_id: 999 })]
  ]) {
    const result = await makeFetcher(data)();
    assert.equal(result.balance, null);
    assert.ok(result.error);
    assert.equal(result.updatedAt, undefined);
  }
});

test('only accepts a complete finite available_balance, never total balance or malformed numbers', async () => {
  for (const value of [undefined, null, '', ' ', '466.80 tokens', Infinity, NaN, true, {}, '1,000.00']) {
    const result = await makeFetcher(wallet({ available_balance: value, balance: 99999 }))();
    assert.equal(result.balance, null);
  }
});

test('reads the provider on every refresh and never returns old data after failure', async () => {
  let calls = 0;
  const fetch = createPayHeroBalanceFetcher({ env, httpClient: { get: async () => {
    calls++;
    if (calls === 3) throw new Error('private upstream detail');
    return { data: wallet({ available_balance: calls === 1 ? 466.8 : 465.8 }) };
  } } });
  assert.equal((await fetch()).balance, 466.8);
  assert.equal((await fetch()).balance, 465.8);
  const failed = await fetch();
  assert.equal(failed.balance, null);
  assert.equal(failed.updatedAt, undefined);
  assert.ok(!JSON.stringify(failed).includes('private upstream detail'));
  assert.equal(calls, 3);
});

test('reports rejected credentials without exposing request details', async () => {
  const fetch = createPayHeroBalanceFetcher({ env, httpClient: { get: async () => {
    throw Object.assign(new Error('render-token'), { response: { status: 401 } });
  } } });
  const result = await fetch();
  assert.equal(result.balance, null);
  assert.match(result.error, /credentials/);
  assert.ok(!JSON.stringify(result).includes('render-token'));
});

test('reports unconfigured credentials without contacting PayHero', async () => {
  const fetch = createPayHeroBalanceFetcher({ env: {}, httpClient: { get: () => assert.fail('No credentials') } });
  assert.equal((await fetch()).configured, false);
});
