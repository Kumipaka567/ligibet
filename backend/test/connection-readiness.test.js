const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { adminSocketAccessError } = require('../realtime');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function verifySocket(admin, readyState, user, invalidToken = false) {
  let verify;
  const api = { use(handler) { verify = handler; } };
  const from = admin ? "adminNamespace.use((socket, next) => {" : "io.use((socket, next) => {";
  const end = admin ? "adminNamespace.on('connection'" : "io.on('connection'";
  vm.runInNewContext(source.slice(source.indexOf(from), source.indexOf(end, source.indexOf(from))), {
    io: api, adminNamespace: api, JWT_SECRET: 'test-only',
    jwt: { verify(token, secret, callback) { callback(invalidToken ? new Error('invalid') : null, { id: 7 }); } },
    mongoose: { connection: { readyState } },
    User: { findOne() { return { select() { return this; }, lean: async () => user }; } },
    buildPublicUser: value => value, isSuspendedUser: () => false, adminSocketAccessError
  });
  return new Promise(resolve => verify({ handshake: { auth: { token: 'test-token' } } }, error => resolve(error)));
}

test('player and admin sockets identify database startup/outages as retryable without authenticating a user', async () => {
  for (const admin of [false, true]) for (const state of [0, 2]) {
    const error = await verifySocket(admin, state, { id: 7, role: 'admin' });
    assert.equal(error.data.retryable, true);
  }
});

test('valid accounts connect, but invalid credentials and suspended accounts are never marked retryable', async () => {
  for (const admin of [false, true]) {
    assert.equal(await verifySocket(admin, 1, { id: 7, role: 'admin' }), undefined);
    assert.equal((await verifySocket(admin, 1, { id: 7, role: 'admin' }, true)).data, undefined);
    assert.equal((await verifySocket(admin, 1, { id: 7, role: 'admin', is_suspended: true })).data, undefined);
  }
});

test('API requests receive availability errors while MongoDB is connecting, rather than entering unready queries', () => {
  const fragment = source.slice(source.indexOf('function requireDatabase'), source.indexOf("app.use('/api', requireDatabase)"));
  const context = { mongoose: { connection: { readyState: 2 } }, process: { env: { NODE_ENV: 'production' } } };
  vm.runInNewContext(fragment, context);
  let status, next = false;
  context.requireDatabase({ path: '/auth/login' }, { status(code) { status = code; return this; }, json() {} }, () => { next = true; });
  assert.equal(status, 503);
  assert.equal(next, false);
});
