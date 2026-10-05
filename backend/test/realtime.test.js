const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeEmitter, adminSocketAccessError, revokeAdminSockets } = require('../realtime');
const { userSearchConditions } = require('../user-search');

function recorder() {
  const events = [];
  return {
    events,
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } },
    admin: { emit(event, payload) { events.push({ room: '/admin', event, payload }); } }
  };
}

test('committed balances reach player sessions and admin once per event', () => {
  const r = recorder();
  createRealtimeEmitter(r.io, r.admin)({ action: 'admin_wallet_credit', userId: 7, balance: '1250.50' });
  for (const event of ['balance_update', 'balance_updated', 'balance', 'wallet_updated']) {
    const events = r.events.filter(e => e.room === 'user_7' && e.event === event);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.balance, 1250.5);
  }
  assert.equal(r.events.filter(e => e.room === '/admin' && e.event === 'wallet_updated').length, 1);
  assert.ok(r.events.some(e => e.room === '/admin' && e.event === 'dashboard_stats_updated'));
});

test('deposit state invalidation never invents a zero balance', () => {
  for (const balance of [undefined, null, '', ' ', false, Infinity, NaN]) {
    const r = recorder();
    createRealtimeEmitter(r.io, r.admin)({ action: 'mpesa_deposit_pending', userId: 7, balance, deposits: true });
    assert.equal(r.events.filter(e => e.event === 'wallet_updated' || e.event === 'balance_update').length, 0);
    assert.ok(r.events.some(e => e.room === '/admin' && e.event === 'deposits_updated'));
  }
});

test('zero balances remain valid and transaction invalidations are deduplicated', () => {
  const r = recorder();
  const tx = { id: 12, user_id: 7, amount: 200 };
  createRealtimeEmitter(r.io, r.admin)({ action: 'withdrawal_completed', userId: 7, balance: 0, transaction: tx, withdrawals: true });
  assert.equal(r.events.find(e => e.room === '/admin' && e.event === 'wallet_updated').payload.balance, 0);
  assert.equal(r.events.filter(e => e.room === 'user_7' && e.event === 'transactions_updated').length, 1);
  assert.equal(r.events.find(e => e.event === 'admin_transaction_update').payload, tx);
});

test('account role updates expose safe fields and preserve registration time', () => {
  const r = recorder();
  const created_at = '2026-10-05T09:12:13.456Z';
  createRealtimeEmitter(r.io, r.admin)({
    action: 'user_role_updated', userId: 7,
    user: { id: 7, role: 'admin', username: 'person', balance: 20, created_at, password_hash: 'secret', is_suspended: true }
  });
  const payload = r.events.find(e => e.room === '/admin' && e.event === 'user_updated').payload;
  assert.equal(payload.user.role, 'admin');
  assert.equal(payload.user.is_suspended, true);
  assert.equal(payload.user.created_at, created_at);
  assert.equal('password_hash' in payload.user, false);
  assert.equal(payload.userId, 7);
});

test('presence updates only notify admins when player notifications are disabled', () => {
  const r = recorder();
  createRealtimeEmitter(r.io, r.admin)({ action: 'user_online', userId: 7, user: true, isOnline: true, notifyPlayer: false });
  assert.ok(r.events.every(e => e.room === '/admin'));
  assert.equal(r.events.find(e => e.event === 'user_updated').payload.is_online, true);
});

test('suspended and non-admin accounts cannot subscribe to admin data', () => {
  assert.equal(adminSocketAccessError({ role: 'admin' }), null);
  assert.equal(adminSocketAccessError({ role: 'superadmin' }), null);
  assert.match(adminSocketAccessError({ role: 'admin', is_suspended: true }), /suspended/);
  assert.match(adminSocketAccessError({ role: 'user' }), /privileges/);
  assert.match(adminSocketAccessError(null), /privileges/);
});

test('revocation disconnects only the target admin namespace session', () => {
  const calls = [];
  const sockets = new Map([
    ['target', { user: { id: '7' }, emit: (event, payload) => calls.push([event, payload]), disconnect: close => calls.push(['disconnect', close]) }],
    ['other', { user: { id: 8 }, emit: () => assert.fail('Other admin notified'), disconnect: () => assert.fail('Other admin disconnected') }]
  ]);
  revokeAdminSockets({ sockets }, 7, 'Administrator role removed');
  assert.equal(calls[0][0], 'admin_access_revoked');
  assert.equal(calls[0][1].userId, 7);
  assert.deepEqual(calls[1], ['disconnect', false]);
});

function matches(search, record) {
  return userSearchConditions(search).some(condition =>
    Object.entries(condition).some(([field, pattern]) => pattern.test(record[field] || '')));
}

test('phone searches match local/international forms, formatting and partial numbers', () => {
  for (const query of ['0712 345 678', '+254 (712) 345-678', '712345678', '0712']) {
    assert.ok(matches(query, { phone_number: '+254712345678' }), query);
    assert.ok(matches(query, { phone_number: '0712 345 678' }), query);
    assert.ok(matches(query, { username: '+254712345678' }), query);
  }
  assert.equal(matches('0712999999', { phone_number: '+254712345678' }), false);
  assert.equal(matches('.*', { username: 'alice' }), false);
  assert.equal(matches('ALIce', { username: 'alice' }), true);
  assert.deepEqual(userSearchConditions(''), []);
});


// Exercise the registered route without starting the server or connecting Mongo.
test('Rain credits broadcast committed wallet changes even when the transaction record fails', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/chat/rain/claim'");
  const end = source.indexOf('// 4. Send chat message', start);
  assert.ok(start >= 0 && end > start);
  const r = recorder();
  const user = { id: 7, username: 'player', role: 'user', balance: 200, async save() {} };
  const rainData = { quantityClaimed: 0, quantityTotal: 10, minBalanceRequired: 200, amountPerClaim: 20, claimedUserIds: [] };
  let route;
  let chatUpdate;
  vm.runInNewContext(source.slice(start, end), {
    app: { post(_path, _auth, handler) { route = handler; } },
    authenticateToken() {},
    User: { async findOne() { return user; } },
    Transaction: { async create() { throw new Error('Ledger temporarily unavailable'); } },
    activeRainDrops: new Map([['rain-1', { rainData }]]),
    recentChatMessages: [],
    isAdminRole: role => role === 'admin' || role === 'superadmin',
    io: { emit(event, payload) { chatUpdate = { event, payload }; } },
    emitRealtimeMutation: createRealtimeEmitter(r.io, r.admin),
    console
  });
  let status = 200;
  let response;
  await route({ user: { id: 7 }, body: { rainId: 'rain-1' } }, {
    status(code) { status = code; return this; },
    json(body) { response = body; return body; }
  });
  assert.equal(status, 200);
  assert.equal(response.success, true);
  assert.equal(user.balance, 220);
  const wallet = r.events.find(e => e.room === '/admin' && e.event === 'wallet_updated');
  assert.equal(wallet.payload.balance, 220);
  assert.equal(wallet.payload.action, 'rain_bonus_claimed');
  assert.ok(r.events.some(e => e.room === 'user_7' && e.event === 'balance_update'));
  assert.equal(chatUpdate.event, 'chat_rain_updated');
  assert.equal(chatUpdate.payload.quantityClaimed, 1);
});
