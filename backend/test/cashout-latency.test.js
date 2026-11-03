const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Run the production socket handler without a live game or real wallet.
function fixture({ history = async data => data, betWrite, walletWrite, room = 1 } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const handlerSource = source.slice(source.indexOf('  // Cash Out Handler'), source.indexOf('  // Chat Handlers via Socket'));
  const handlers = new Map(), events = [], mutations = [], broadcasts = [];
  const user = { id: 7, balance: 500 };
  let credits = 0, historyWrites = 0;
  const bet = { id: 77, userId: 7, room, slot: 1, betAmount: 100, status: 'placed' };
  const context = {
    socket: { user: { id: 7, username: 'player' }, data: { gameRoom: room },
      on: (event, handler) => handlers.set(event, handler), emit: (event, payload) => events.push({ event, payload }) },
    activeBets: new Map([[`${room}:7:1`, bet]]), activeBetKey: (id, slot, room) => `${room}:${id}:${slot}`,
    parseBetSlot: value => value === 2 ? 2 : 1, parseGameRoom: value => value,
    gamePhase: 'flying', currentMultiplier: 2.5,
    secondaryRoomEngines: new Map([[2, { phase: 'flying', multiplier: 2.5 }], [3, { phase: 'flying', multiplier: 2.5 }]]),
    isTimedCrashTimeoutEnabled: false,
    Bet: { updateOne: betWrite || (async () => {}) },
    User: { findOneAndUpdate: walletWrite || (async (filter, change) => {
      credits++; user.balance += change.$inc.balance; return { ...user };
    }) },
    Transaction: { create: async data => { historyWrites++; return history(data); } },
    emitRealtimeMutation: event => mutations.push(event), emitAdminCurrentRound() {},
    io: { to: () => ({ emit: (event, payload) => broadcasts.push({ event, payload }) }) },
    playerRoomName: room => `game_room_${room}`, console: { log() {}, error() {} }
  };
  vm.runInNewContext(handlerSource, context);
  return { context, user, bet, events, mutations, broadcasts, cashout: () => handlers.get('cash_out')({ slot: 1 }),
    credits: () => credits, historyWrites: () => historyWrites };
}
const flush = () => new Promise(setImmediate);

test('cashout confirms and updates the wallet while history is still blocked and the plane is flying', async () => {
  for (const room of [1, 2, 3]) {
    const history = deferred();
    const f = fixture({ room, history: () => history.promise });
    const request = f.cashout();
    await flush();
    const success = f.events.find(row => row.event === 'cash_out_success');
    assert.ok(success, 'confirmation must not wait for transaction history');
    assert.equal(success.payload.balance, 750);
    assert.equal(success.payload.payoutAmount, 250);
    assert.equal(success.payload.multiplier, 2.5);
    assert.equal(success.payload.room, room);
    assert.equal(f.context.gamePhase, 'flying');
    assert.equal(f.mutations.find(row => row.action === 'bet_cashout').balance, 750);
    assert.ok(f.broadcasts.some(row => row.event === 'bet_cashed_out_broadcast'));
    history.resolve({ id: 99 });
    await request;
    assert.equal(f.mutations.filter(row => row.balance !== undefined).length, 1);
    assert.equal(f.mutations.find(row => row.action === 'bet_cashout_recorded').transaction.id, 99);
  }
});

test('slow history and repeated clicks cannot credit the same bet twice', async () => {
  const history = deferred();
  const f = fixture({ history: () => history.promise });
  const first = f.cashout();
  await flush();
  await f.cashout();
  assert.equal(f.credits(), 1);
  assert.equal(f.historyWrites(), 1);
  assert.equal(f.user.balance, 750);
  assert.equal(f.events.filter(row => row.event === 'cash_out_success').length, 1);
  history.resolve({ id: 99 });
  await first;
});

test('a history failure never reports an already credited cashout as failed', async () => {
  const f = fixture({ history: async () => { throw new Error('history offline'); } });
  await f.cashout();
  assert.equal(f.user.balance, 750);
  assert.equal(f.events.filter(row => row.event === 'cash_out_success').length, 1);
  assert.equal(f.events.some(row => row.event === 'cashout_error'), false);
});

test('no success is sent before the wallet credit is committed, and the payout stays at the received multiplier', async () => {
  const wallet = deferred();
  const f = fixture({ walletWrite: () => wallet.promise });
  const request = f.cashout();
  await flush();
  assert.equal(f.events.some(row => row.event === 'cash_out_success'), false);
  assert.equal(f.historyWrites(), 0);
  f.context.currentMultiplier = 99;
  wallet.resolve({ balance: 750 });
  await request;
  assert.equal(f.events.find(row => row.event === 'cash_out_success').payload.multiplier, 2.5);
});

test('failed bet/wallet writes never show a successful cashout or create a payout history entry', async () => {
  for (const controls of [
    { betWrite: async () => { throw new Error('bet offline'); } },
    { walletWrite: async () => { throw new Error('wallet offline'); } },
    { walletWrite: async () => null }
  ]) {
    const f = fixture(controls);
    await f.cashout();
    assert.equal(f.events.some(row => row.event === 'cash_out_success'), false);
    assert.equal(f.events.some(row => row.event === 'cashout_error'), true);
    assert.equal(f.historyWrites(), 0);
  }
});
