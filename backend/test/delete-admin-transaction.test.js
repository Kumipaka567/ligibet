const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDeleteAdminTransaction } = require('../delete-admin-transaction');

function fixture(status = 'completed') {
  const tx = { id: 12, user_id: 7, type: 'deposit', status, amount: 500, admin_deleted_at: null };
  const player = { balance: 650 }, deposit = { status: 'completed', amount: 500, transaction_id: 12 };
  const events = [], logs = [];
  const handler = createDeleteAdminTransaction({ Transaction: { findOneAndUpdate(filter, update) {
    assert.equal(filter.status, 'completed');
    assert.deepEqual(filter.type.$in, ['deposit', 'withdrawal']);
    assert.equal(filter.admin_deleted_at, null);
    return { lean: async () => {
      if (filter.id !== tx.id || tx.status !== filter.status || tx.admin_deleted_at || filter.user_id?.$nin.includes(tx.user_id)) return null;
      Object.assign(tx, update.$set);
      return tx;
    } };
  } }, AdminLog: { create: async log => logs.push(log) } }, { emit: (name, payload) => events.push({ name, payload }) });
  async function call(role = 'superadmin', id = 12, blockedClientIds = []) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ user: { id: 1, role }, params: { id }, blockedClientIds }, res);
    return res;
  }
  return { call, tx, player, deposit, events, logs };
}

test('deleting a completed transaction retains accounting amounts, status, balance and deposit records', async () => {
  const f = fixture();
  assert.equal((await f.call()).statusCode, 200);
  assert.ok(f.tx.admin_deleted_at instanceof Date);
  assert.equal(f.tx.admin_deleted_by, 1);
  assert.equal(f.tx.status, 'completed');
  assert.equal(f.tx.amount, 500);
  assert.deepEqual(f.player, { balance: 650 });
  assert.deepEqual(f.deposit, { status: 'completed', amount: 500, transaction_id: 12 });
  assert.equal(f.logs[0].action, 'DELETE_COMPLETED_TRANSACTION');
  assert.equal(f.events[0].name, 'transactions_updated');
  assert.equal(f.events[0].payload.transactionId, 12);
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.logs.length, 1);
});

test('ordinary admins, players, unfinished transactions, invalid IDs and blocked clients cannot be deleted', async () => {
  for (const role of ['admin', 'user', undefined]) assert.equal((await fixture().call(role === undefined ? 'unknown' : role)).statusCode, 403);
  for (const status of ['pending', 'failed']) {
    const f = fixture(status);
    assert.equal((await f.call()).statusCode, 409);
    assert.equal(f.tx.admin_deleted_at, null);
  }
  assert.equal((await fixture().call('superadmin', 'invalid')).statusCode, 400);
  assert.equal((await fixture().call('superadmin', 12, [7])).statusCode, 409);
});

test('delete route requires the real superadmin guard and both admin list queries exclude deleted records', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /app\.delete\('\/api\/admin\/transactions\/:id', authenticateSuperAdminToken,/);
  const queries = [];
  const query = { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [] };
  const handlers = new Map();
  const context = { app: { get: (route, auth, handler) => handlers.set(route, handler) }, authenticateAdminToken() {},
    Transaction: { find(filter) { queries.push(filter); return query; } }, User: { find: () => query },
    AdminLog: { find: () => query }, adminClientScope: () => ({}), getDashboardTotals: async () => ({ totalDeposits: 500 }),
    onlinePlayers: { summary: () => ({}) } };
  for (const [start, end] of [
    ["app.get('/api/admin/overview'", '// Admin List Users'],
    ["app.get('/api/admin/transactions'", "app.delete('/api/admin/transactions"]
  ]) {
    const from = source.indexOf(start);
    // Evaluate just the registered route, excluding any following declarations.
    const to = source.indexOf('\n});', from) + 4;
    vm.runInNewContext(source.slice(from, to), context);
  }
  return Promise.all([...handlers.values()].map(handler => handler({ query: {}, blockedClientIds: [] }, {
    json() {}, status() { return this; }
  }))).then(() => {
    assert.equal(queries.length, 2);
    for (const filter of queries) assert.equal(filter.admin_deleted_at, null);
  });
});
