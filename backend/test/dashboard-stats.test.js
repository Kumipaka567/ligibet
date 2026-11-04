const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardStats } = require('../dashboard-stats');

test('simultaneous dashboard reads share aggregation work and refresh after one second', async () => {
  let clock = 0, reads = 0;
  const models = {
    User: { countDocuments: async () => { reads++; return 12; } },
    Bet: { aggregate: async () => [{ totalBets: 4, totalVolume: 100, totalPayout: 50 }] },
    Deposit: { aggregate: async () => [{ total: 25 }] }, Withdrawal: { aggregate: async () => [] }
  };
  const totals = createDashboardStats(models, { now: () => clock });
  const results = await Promise.all([totals(), totals(), totals()]);
  assert.equal(reads, 1);
  assert.deepEqual(results[0], { totalUsers: 12, totalBets: 4, totalVolume: 100, totalPayout: 50, totalDeposits: 25, totalWithdrawals: 0 });
  await totals();
  assert.equal(reads, 1);
  clock = 1001;
  await totals();
  assert.equal(reads, 2);
});

test('failed statistics queries are not cached and remain retryable', async () => {
  let fail = true;
  const models = {
    User: { countDocuments: async () => { if (fail) throw new Error('offline'); return 3; } },
    Bet: { aggregate: async () => [] }, Deposit: { aggregate: async () => [] }, Withdrawal: { aggregate: async () => [] }
  };
  const totals = createDashboardStats(models);
  await assert.rejects(totals(), /offline/);
  fail = false;
  assert.equal((await totals()).totalUsers, 3);
});

test('room restoration includes only the requesting player’s active bets in that room', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const context = { activeBets: new Map([
    ['1:7:1', { userId: 7, room: 1, slot: 1, status: 'placed', betAmount: 100 }],
    ['2:7:2', { userId: 7, room: 2, slot: 2, status: 'cashed_out', betAmount: 200, payoutAmount: 300, cashoutMultiplier: 1.5 }],
    ['2:8:1', { userId: 8, room: 2, slot: 1, status: 'placed', betAmount: 500 }],
    ['2:7:1', { userId: 7, room: 2, slot: 1, status: 'lost', betAmount: 100 }]
  ]) };
  vm.runInNewContext(source.slice(source.indexOf('function getPlayerActiveBets'), source.indexOf('function parseBetSlot')), context);
  const bets = context.getPlayerActiveBets(7, 2);
  assert.equal(bets.length, 1);
  assert.equal(bets[0].slot, 2);
  assert.equal(bets[0].amount, 200);
  assert.equal(bets[0].payoutAmount, 300);
  assert.equal(context.getPlayerActiveBets(null, 2).length, 0);
});
