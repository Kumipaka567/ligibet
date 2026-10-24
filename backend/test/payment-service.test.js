const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentService } = require('../payment-service');
const { createPaymentGateways, error } = require('../payment-gateways');

function fixture() {
  const stores = { deposits: new Map(), transactions: new Map(), users: new Map([[7, { id: 7, username: 'player', balance: 50 }]]), receipts: new Map(), settings: new Map(), logs: new Map() };
  const controls = { failTransaction: false, failAudit: false, submitError: null, unavailable: null };
  const calls = { initiate: [], check: [], events: [] };
  const results = new Map();
  let clock = Date.now();
  let nextId = 1;
  let queue = Promise.resolve();
  function matches(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return value.some(branch => matches(row, branch));
      const actual = row[key];
      if (value === null) return actual == null;
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.entries(value).every(([operator, operand]) => {
          if (operator === '$in') return operand.includes(actual ?? null);
          if (operator === '$ne') return actual !== operand;
          if (operator === '$gte') return actual >= operand;
          if (operator === '$lte') return actual <= operand;
          if (operator === '$type') return typeof actual === operand;
          throw new Error('Unsupported test query operator ' + operator);
        });
      }
      return actual === value;
    });
  }
  const query = execute => ({
    session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; },
    lean: async () => structuredClone(execute()),
    then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); }
  });
  const update = (row, changes, inserting = false) => {
    Object.assign(row, changes.$set || {}, inserting ? changes.$setOnInsert || {} : {});
    for (const [key, amount] of Object.entries(changes.$inc || {})) row[key] = (row[key] || 0) + amount;
    return row;
  };
  function model(name) {
    const rows = stores[name];
    return {
      init: async () => {},
      find: filter => query(() => [...rows.values()].filter(row => matches(row, filter))),
      findOne: filter => query(() => structuredClone([...rows.values()].find(row => matches(row, filter)) || null)),
      findById: id => query(() => structuredClone(rows.get(id) || null)),
      findByIdAndUpdate(id, changes, options) { return this.findOneAndUpdate({ _id: id }, changes, options); },
      findOneAndUpdate: (filter, changes, options = {}) => query(() => {
        if (name === 'transactions' && controls.failTransaction) throw new Error('Transaction ledger unavailable');
        let row = [...rows.values()].find(row => matches(row, filter));
        let inserting = false;
        if (!row && options.upsert) { row = { ...filter }; rows.set(filter._id ?? filter.id, row); inserting = true; }
        return row ? structuredClone(update(row, changes, inserting)) : null;
      }),
      updateOne: async (filter, changes) => {
        const row = [...rows.values()].find(row => matches(row, filter));
        if (row) update(row, changes);
      },
      create: async input => {
        if (name === 'transactions' && controls.failTransaction) throw new Error('Transaction ledger unavailable');
        if (name === 'logs' && controls.failAudit) throw new Error('Audit unavailable');
        const create = data => {
          const row = { created_at: new Date(clock), ...structuredClone(data), id: nextId++ };
          rows.set(row.id, structuredClone(row));
          Object.defineProperty(row, 'save', { enumerable: false, value: async () => { rows.set(row.id, structuredClone({ ...row })); } });
          return row;
        };
        return Array.isArray(input) ? input.map(create) : create(input);
      },
      startSession: async () => ({
        withTransaction: callback => {
          const job = queue.then(async () => {
            const before = structuredClone(stores);
            try { return await callback(); }
            catch (cause) {
              for (const [key, rows] of Object.entries(stores)) { rows.clear(); for (const [id, row] of before[key]) rows.set(id, row); }
              throw cause;
            }
          });
          queue = job.catch(() => {});
          return job;
        }, endSession: async () => {}
      })
    };
  }
  const models = { Deposit: model('deposits'), Transaction: model('transactions'), User: model('users'), PaymentGatewaySetting: model('settings'), PaymentReceipt: model('receipts'), AdminLog: model('logs') };
  const parser = createPaymentGateways({ env: {}, http: {} });
  const gateways = {
    available: () => ['payhero', 'nexuspay'].map(id => ({ id, name: id, configured: controls.unavailable !== id })),
    configuration: provider => {
      if (!['payhero', 'nexuspay'].includes(provider)) throw error('Invalid gateway', 400, true);
      if (controls.unavailable === provider) throw error('Not configured', 503, true);
    },
    initiate: async (provider, deposit) => {
      calls.initiate.push({ provider, deposit: { ...deposit } });
      if (controls.submitError) throw controls.submitError;
      return { checkoutRequestId: `${provider}-${deposit.id}`, providerReference: `provider-${deposit.id}` };
    },
    check: async (provider, deposit) => { calls.check.push({ provider, id: deposit.id }); return results.get(deposit.id) || { status: 'pending' }; },
    verified: parser.verified,
    parsePayHero: parser.parsePayHero
  };
  const env = { PAYHERO_CALLBACK_TOKEN: 'callback-secret' };
  const service = createPaymentService({ models, gateways, env, now: () => clock, getMinimumDeposit: () => 1,
    emitRealtimeMutation: event => calls.events.push(event), adminNamespace: { emit() {} }, logger: { warn() {} } });
  const user = { id: 7, username: 'player' };
  const paid = (receipt = 'RBK71G1234') => ({ status: 'completed', amount: 199, phone: '254712345678', receipt });
  const start = () => service.initiate(user, 199, '0712345678');
  const latest = () => [...stores.deposits.values()].at(-1);
  const routes = new Map();
  const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (paths, ...handlers) => {
    for (const route of [].concat(paths)) routes.set(method + ' ' + route, handlers);
  }]));
  service.mount(app, {
    authenticateToken: (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Login required' }),
    authenticateAdminToken: (req, res, next) => ['admin', 'superadmin'].includes(req.user?.role) ? next() : res.status(403).json({ error: 'Admin required' })
  });
  async function request(method, route, body = {}, account = user) {
    const req = { body, user: account, headers: {}, query: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    const handlers = routes.get(method + ' ' + route);
    const dispatch = index => handlers[index](req, res, () => dispatch(index + 1));
    await dispatch(0);
    return res;
  }
  return { service, stores, models, controls, calls, results, env, user, start, latest, paid, request, tick: ms => { clock += ms; } };
}

test('only admins switch the global gateway, and customer gateway fields cannot select a provider', async () => {
  const f = fixture();
  assert.equal((await f.service.settings()).activeGateway, 'payhero');
  assert.equal((await f.request('put', '/api/admin/payment-gateway', { gateway: 'nexuspay' })).statusCode, 403);
  await f.request('post', '/api/mpesa/stk-push', { amount: 199, phone: '0712345678', gateway: 'nexuspay', provider: 'nexuspay' });
  assert.equal(f.calls.initiate[0].provider, 'payhero');
  const response = await f.request('put', '/api/admin/payment-gateway', { gateway: 'nexuspay' }, { id: 1, role: 'admin' });
  assert.equal(response.body.activeGateway, 'nexuspay');
  await f.start();
  assert.equal(f.calls.initiate.at(-1).provider, 'nexuspay');
  assert.equal(f.stores.settings.size, 1);
  assert.equal(f.stores.logs.size, 1);
});

test('a switch cannot interrupt an older payment; both providers confirm through their saved identity', async () => {
  const f = fixture();
  await f.start();
  const payhero = f.latest();
  await f.service.switchGateway('nexuspay', 1);
  await f.start();
  const nexus = f.latest();
  f.results.set(payhero.id, f.paid('RBK71G1111'));
  f.results.set(nexus.id, f.paid('RBK71G2222'));
  await f.service.refresh(payhero);
  await f.service.refresh(nexus);
  assert.deepEqual(f.calls.check.map(call => call.provider), ['payhero', 'nexuspay']);
  assert.equal(f.stores.users.get(7).balance, 448);
});

test('duplicate confirmations credit once, reuse one transaction row, and emit only one wallet event', async () => {
  const f = fixture();
  await f.start();
  const id = f.latest().id;
  await Promise.all([f.service.settle(id, f.paid()), f.service.settle(id, f.paid()), f.service.settle(id, { status: 'failed' })]);
  assert.equal(f.stores.users.get(7).balance, 249);
  assert.equal(f.stores.transactions.size, 1);
  assert.equal(f.stores.receipts.size, 1);
  assert.equal(f.calls.events.filter(event => event.action === 'mpesa_deposit_completed').length, 1);
  assert.equal(f.stores.deposits.get(id).status, 'completed');
});

test('receipt reuse and mismatched amount or phone never credit a wallet', async () => {
  const f = fixture();
  await f.start();
  const first = f.latest().id;
  for (const patch of [{ amount: 200 }, { phone: '254711112222' }, { receipt: '' }]) await assert.rejects(f.service.settle(first, { ...f.paid(), ...patch }));
  assert.equal(f.stores.users.get(7).balance, 50);
  await f.service.settle(first, f.paid());
  await f.start();
  const second = f.latest().id;
  await assert.rejects(f.service.settle(second, f.paid()), { status: 409 });
  assert.equal(f.stores.users.get(7).balance, 249);
  assert.equal(f.stores.deposits.get(second).status, 'pending');
});

test('settlement rollback prevents partial wallet credits and remains retryable', async () => {
  const f = fixture();
  await f.start();
  const id = f.latest().id;
  f.controls.failTransaction = true;
  await assert.rejects(f.service.settle(id, f.paid()));
  assert.equal(f.stores.users.get(7).balance, 50);
  assert.equal(f.stores.deposits.get(id).status, 'pending');
  assert.equal(f.stores.receipts.size, 0);
  f.controls.failTransaction = false;
  await f.service.settle(id, f.paid());
  assert.equal(f.stores.users.get(7).balance, 249);
});

test('receipt ownership survives a history reset that reuses a numeric deposit id', async () => {
  const f = fixture();
  await f.start();
  const original = { ...f.latest() };
  await f.service.settle(original.id, f.paid());
  f.stores.deposits.get(original.id).status = 'pending';
  await assert.rejects(f.service.settle(original.id, f.paid()), { status: 409 });
  f.stores.deposits.set(original.id, { ...original, external_reference: 'new-payment-after-reset', status: 'pending' });
  await assert.rejects(f.service.settle(original.id, f.paid()), { status: 409 });
  assert.equal(f.stores.users.get(7).balance, 249);
});

test('unavailable configuration and failed audit writes leave the selected gateway unchanged', async () => {
  const f = fixture();
  f.controls.unavailable = 'nexuspay';
  await assert.rejects(f.service.switchGateway('nexuspay', 1));
  assert.equal((await f.service.settings()).activeGateway, 'payhero');
  f.controls.unavailable = null;
  f.controls.failAudit = true;
  await assert.rejects(f.service.switchGateway('nexuspay', 1));
  assert.equal((await f.service.settings()).activeGateway, 'payhero');
  f.controls.unavailable = 'payhero';
  await assert.rejects(f.start());
  assert.equal(f.stores.deposits.size, 0);
  assert.equal(f.calls.initiate.length, 0);
});

test('no prompt is sent if the initial transaction cannot be recorded', async () => {
  const f = fixture();
  f.controls.failTransaction = true;
  await assert.rejects(f.start());
  assert.equal(f.stores.deposits.size, 0);
  assert.equal(f.calls.initiate.length, 0);
});

test('ambiguous initiation is not retried through another gateway', async () => {
  const f = fixture();
  f.controls.submitError = error('Uncertain request', 502, false);
  await assert.rejects(f.start());
  assert.equal(f.latest().initiation_status, 'unknown');
  await f.service.switchGateway('nexuspay', 1);
  await assert.rejects(f.start(), { status: 409 });
  assert.equal(f.calls.initiate.length, 1);
});

test('closing the prompt and passing 60 seconds do not incorrectly fail a real pending payment', async () => {
  const f = fixture();
  await f.service.switchGateway('nexuspay', 1);
  const started = await f.start();
  const id = f.latest().id;
  await f.request('post', '/api/mpesa/cancel-pending', { checkoutRequestId: started.checkoutRequestId });
  assert.equal(f.stores.deposits.get(id).status, 'pending');
  f.tick(65000);
  await f.service.reconcilePending();
  assert.equal(f.stores.deposits.get(id).status, 'pending');
  f.tick(5000);
  f.results.set(id, f.paid());
  await f.service.reconcilePending();
  assert.equal(f.stores.users.get(7).balance, 249);
});

test('status requests cannot access another customer and forged PayHero callbacks cannot credit Nexus payments', async () => {
  const f = fixture();
  await f.service.switchGateway('nexuspay', 1);
  const started = await f.start();
  const response = await f.request('post', '/api/mpesa/stk-status', { checkoutRequestId: started.checkoutRequestId }, { id: 8 });
  assert.equal(response.statusCode, 404);
  await assert.rejects(f.service.callback({ body: {}, headers: {}, query: {} }), { status: 401 });
  await f.service.callback({ headers: { authorization: 'Bearer callback-secret' }, query: {}, body: {
    response: { ExternalReference: f.latest().external_reference, Status: 'Success', Amount: 199, MpesaReceiptNumber: 'RBK71G1234' }
  } });
  assert.equal(f.stores.users.get(7).balance, 50);
});

test('unsigned PayHero callbacks are hints and require server-side verification', async () => {
  const f = fixture();
  delete f.env.PAYHERO_CALLBACK_TOKEN;
  await f.start();
  await f.service.callback({ headers: {}, query: {}, body: { ExternalReference: f.latest().external_reference, Status: 'Success', Amount: 199, MpesaReceiptNumber: 'RBK71G1234' } });
  assert.equal(f.stores.users.get(7).balance, 50);
  assert.equal(f.calls.check.length, 1);
});
