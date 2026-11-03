const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual HTTP handler without starting games, MongoDB or payout APIs.
function fixture(patch = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const route = source.slice(source.indexOf('// Submit Withdrawal'), source.indexOf('// Change Password'));
  const user = { id: 7, role: 'user', balance: 500, withdrawal_allowed: false, ...patch };
  const writes = [], events = [];
  let handler;
  const create = collection => async data => {
    writes.push({ collection, data });
    return { ...data, id: writes.length, created_at: new Date() };
  };
  vm.runInNewContext(route, {
    app: { post(paths, auth, action) { handler = action; } }, authenticateToken() {},
    User: { findOne: () => ({ lean: async () => user }) },
    getWithdrawalSettings: async () => ({ initiationTitle: 'Global configured title', initiationMessage: 'Global configured message' }),
    Withdrawal: { create: create('withdrawals') }, Transaction: { create: create('transactions') },
    Notification: { create: create('notifications') },
    emitRealtimeMutation: event => events.push(event), io: { to: () => ({ emit() {} }) }, console
  });
  async function request(amount = 100) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ user: { id: 7 }, body: { amount } }, res);
    return res;
  }
  return { request, user, writes, events };
}

test('disabled withdrawals use the configured global popup without authorizing or recording a withdrawal', async () => {
  for (const withdrawal_allowed of [false, undefined, null]) {
    const f = fixture({ withdrawal_allowed });
    const res = await f.request();
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.withdrawal_blocked, true);
    assert.equal(res.body.popup.title, 'Global configured title');
    assert.equal(res.body.popup.message, 'Global configured message');
    assert.equal(res.body.error, res.body.popup.message);
    assert.equal(res.body.notification.title, res.body.popup.title);
    assert.equal(f.writes.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.user.balance, 500);
  }
});

test('personal popup fields override the global notice and missing fields inherit the configured global value', async () => {
  for (const patch of [
    { custom_withdrawal_title: 'Personal title', custom_withdrawal_message: 'Personal message' },
    { custom_withdrawal_title: 'Personal title' },
    { custom_withdrawal_message: 'Personal message' }
  ]) {
    const f = fixture({ has_custom_withdrawal_popup: true, ...patch });
    const res = await f.request();
    assert.equal(res.body.popup.title, patch.custom_withdrawal_title || 'Global configured title');
    assert.equal(res.body.popup.message, patch.custom_withdrawal_message || 'Global configured message');
    assert.equal(f.writes.length, 0);
  }
});

test('inactive personal settings use the global popup and enabled withdrawals retain their pending approval flow', async () => {
  const f = fixture({ withdrawal_allowed: true, has_custom_withdrawal_popup: false,
    custom_withdrawal_title: 'Old title', custom_withdrawal_message: 'Old message' });
  const res = await f.request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.popup.title, 'Global configured title');
  assert.equal(res.body.popup.message, 'Global configured message');
  assert.deepEqual(f.writes.map(row => row.collection), ['withdrawals', 'transactions', 'notifications']);
  assert.equal(f.writes[0].data.status, 'pending');
  assert.equal(f.user.balance, 500);
});

test('insufficient funds still stop the request before the configured withdrawal notice', async () => {
  const f = fixture({ balance: 0 });
  const res = await f.request();
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.notification.title, 'Insufficient Funds');
  assert.equal(f.writes.some(row => row.collection === 'withdrawals'), false);
  assert.equal(f.user.balance, 0);
});
