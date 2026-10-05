const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createOnlinePlayers } = require('../online-players');
const user = (id, patch = {}) => ({ id, username: `player_${id}`, phone_number: '07' + String(id).padStart(8, '0'), role: 'user', balance: id, created_at: '2026-10-05T07:40:25Z', ...patch });

test('counts each connected player once across sockets and never counts guest/admin/suspended accounts', () => {
  const presence = createOnlinePlayers();
  presence.connect('tab-1', user(1));
  presence.connect('tab-2', user(1));
  presence.connect('room-3', user(2));
  presence.connect('admin-preview', user(3, { role: 'admin' }));
  presence.connect('suspended', user(4, { is_suspended: true }));
  presence.connect('guest', {});
  assert.equal(presence.summary().onlineUsers, 2);
  assert.equal(presence.summary().connectedPlayers, 3);
  presence.disconnect('tab-1');
  assert.equal(presence.summary().onlineUsers, 2);
  presence.disconnect('tab-2');
  assert.equal(presence.summary().onlineUsers, 1);
  presence.disconnect('room-3');
  assert.equal(presence.summary().onlineUsers, 0);
});

test('ranks top five online players by balance, exposes safe fields and drops offline entries immediately', () => {
  const presence = createOnlinePlayers();
  for (let id = 1; id <= 8; id++) presence.connect(`s${id}`, user(id, { password_hash: 'secret' }));
  assert.deepEqual(presence.summary().topPlayers.map(p => p.id), [8, 7, 6, 5, 4]);
  presence.updateUser(1, { balance: 100 });
  assert.equal(presence.summary().topPlayers[0].id, 1);
  assert.ok(!JSON.stringify(presence.list()).includes('secret'));
  presence.disconnect('s1');
  assert.ok(!presence.list().players.some(p => p.id === 1));
});

test('withdrawal attempts and past bets cannot add presence; deleting, promoting or suspending a player removes them', () => {
  const presence = createOnlinePlayers();
  presence.updateUser(55, { balance: 10000 });
  assert.equal(presence.summary().onlineUsers, 0);
  presence.connect('player', user(1));
  presence.updateUser(1, { role: 'admin' });
  assert.equal(presence.summary().onlineUsers, 0);
  presence.updateUser(1, { role: 'user' });
  assert.equal(presence.summary().onlineUsers, 1);
  presence.updateUser(1, { is_suspended: true });
  assert.equal(presence.summary().onlineUsers, 0);
  presence.removeUser(1);
  presence.disconnect('player');
  assert.equal(presence.summary().onlineUsers, 0);
});

test('returns at most 25 rows and searches all connected players using local/international phone forms', () => {
  const presence = createOnlinePlayers();
  for (let id = 1; id <= 1000; id++) presence.connect(`s${id}`, user(id));
  assert.equal(presence.list({ pageSize: 99999 }).players.length, 25);
  assert.equal(presence.list().total, 1000);
  assert.equal(presence.list({ search: '+254 700 001 000' }).players[0].id, 1000);
  assert.equal(presence.list({ search: '(' }).total, 0);
  assert.equal(presence.list({ page: 100000 }).page, 40);
  assert.equal(presence.list({ page: 2 }).players[0].id, 975);
});

test('does not broadcast unchanged presence on repeated round ticks or identical balance updates', () => {
  const events = [];
  const presence = createOnlinePlayers({ onChange: value => events.push(value) });
  presence.connect('s1', user(1));
  const version = presence.summary().version;
  for (let i = 0; i < 1000; i++) { presence.summary(); presence.updateUser(1, { balance: 1 }); }
  assert.equal(events.length, 1);
  assert.equal(presence.summary().version, version);
});

function socketAuth({ decoded = { id: 1 }, error = null, record = user(1), fail = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('io.use((socket, next) => {');
  const end = source.indexOf("\nio.on('connection'", start);
  let middleware;
  let queries = 0;
  vm.runInNewContext(source.slice(start, end), {
    io: { use: callback => { middleware = callback; } }, JWT_SECRET: 'test',
    jwt: { verify: (_token, _secret, callback) => callback(error, decoded) },
    isSuspendedUser: () => false, buildPublicUser: record => ({ ...record }),
    User: { findOne: () => { queries++; return { select: () => ({ lean: async () => {
      if (fail) throw new Error('DB unavailable');
      return record;
    } }) }; } }
  });
  return { middleware, queries: () => queries };
}

test('socket authentication verifies current database identity before counting a player', async () => {
  const auth = socketAuth({ record: user(1, { role: 'admin' }) });
  const socket = { handshake: { auth: { token: 'verified-test-token' } } };
  const error = await new Promise(resolve => auth.middleware(socket, resolve));
  assert.equal(error, undefined);
  assert.equal(socket.presenceUser.role, 'admin');
  assert.equal(auth.queries(), 1);
});

test('invalid, deleted, suspended or unverifiable accounts never get a presence profile', async () => {
  for (const config of [{ error: new Error('invalid token') }, { record: null }, { record: user(1, { is_suspended: true }) }, { fail: true }]) {
    const auth = socketAuth(config);
    const socket = { handshake: { auth: { token: 'test' } } };
    const error = await new Promise(resolve => auth.middleware(socket, resolve));
    assert.ok(error);
    assert.equal(socket.presenceUser, undefined);
  }
  const guest = { handshake: { auth: {} } };
  const auth = socketAuth();
  await new Promise(resolve => auth.middleware(guest, resolve));
  assert.equal(auth.queries(), 0);
  assert.equal(guest.presenceUser, undefined);
});
