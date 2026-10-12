const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { protectPayload, maskPhone, adminClientScope, adminTicketScope, createAdminPrivacy } = require('../admin-privacy');
const { normalizePhone, transactionOwnershipFields } = require('../admin-phone-ownership');
const { migratePinSettings } = require('../admin-pin-database');

const directory = [
  { id: 7, username: '0712345678', phone_number: '+254712345678', owner_tag: 'R', payer_phones: ['0799887766'] },
  { id: 8, username: 'george', phone_number: '0711112222', owner_tag: 'G' }
];

test('locked admin payloads mask phone aliases, payout accounts, logs and support messages without changing player data', () => {
  const payload = {
    users: [{ id: 7, role: 'user', balance: 5, username: '0712345678', phone_number: '+254712345678', password_hash: 'secret' }, { id: 9, role: 'user', phone_number: '0700000000' }],
    withdrawals: [{ user_id: 7, account_details: 'M-PESA 0799887766' }],
    deposits: [{ user_id: 7, callback_payload: { PhoneNumber: 254712345678, Item: [{ Name: 'PhoneNumber', Value: 254799887766 }] } }],
    tickets: [{ id: 100, phone_number: '0712 345 678', messages: [{ sender_name: '+254712345678', text: 'Call 0712345678 or 0799887766' }] }],
    logs: [{ details: 'Replied to (254712345678)' }]
  };
  const result = protectPayload(payload, directory);
  assert.equal(result.users[0].phone_number, '+25471*****78');
  assert.equal(result.users[0].username, '071*****78');
  assert.equal(result.users[0].password_hash, undefined);
  assert.equal(result.users[1].phone_number, '0700000000');
  assert.equal(result.withdrawals[0].account_details, 'M-PESA 079*****66');
  assert.equal(result.deposits[0].callback_payload.PhoneNumber, '25471*****78');
  assert.equal(result.deposits[0].callback_payload.Item[0].Value, '25479*****66');
  assert.equal(result.tickets[0].phone_number, '071*****78');
  assert.ok(!JSON.stringify(result).includes('712345678'));
  assert.ok(!JSON.stringify(result).includes('799887766'));
  assert.equal(payload.users[0].phone_number, '+254712345678');
});

test('PIN identity shows only its clients plus unclaimed clients across every list; no account-role bypass exists', () => {
  const payload = {
    users: [{ id: 7, role: 'user', phone_number: '+254712345678' }, { id: 8, role: 'user', phone_number: '0711112222' }, { id: 9, role: 'user', phone_number: '0700000000' }],
    transactions: [{ id: 101, user_id: 7, phone_number: '+254712345678' }, { id: 102, user_id: 8, phone_number: '0711112222' }],
    tickets: [{ id: 7, phone_number: '0711112222' }, { id: 8, phone_number: '0712345678' }],
    currentRound: { activeBets: [{ userId: 8, phoneNumber: '0711112222' }, { userId: 7, phoneNumber: '+254712345678' }] },
    winners: [{ username: 'george' }, { username: '0712345678' }]
  };
  const result = protectPayload(payload, directory, 'R');
  assert.deepEqual(result.users.map(row => row.id), [7, 9]);
  assert.deepEqual(result.transactions.map(row => row.id), [101]);
  assert.deepEqual(result.tickets.map(row => row.id), [8]);
  assert.equal(result.currentRound.activeBets.length, 1);
  assert.equal(result.winners.length, 1);
  assert.equal(result.users[0].phone_number, '+254712345678');
  assert.equal(protectPayload(payload, directory).users[0].phone_hidden, true);
});

test('phone searches cannot confirm masked full numbers, and owners can search local/international equivalents', () => {
  const payload = { users: [{ id: 7, role: 'user', phone_number: '+254712345678', username: '0712345678' }] };
  assert.equal(protectPayload(payload, directory, null, '0712345678').users.length, 0);
  assert.equal(protectPayload(payload, directory, 'R', '0712345678').users.length, 1);
  assert.equal(maskPhone('0712345678'), '071*****78');
  const search = protectPayload({ players: payload.users, total: 1, page: 1, totalPages: 1 }, directory, null, '0712345678');
  assert.equal(search.total, 0);
});

test('database scopes exclude other owners before pagination, including support phone formats', () => {
  const request = { blockedClientIds: [7], blockedClients: [directory[0]] };
  assert.deepEqual(adminClientScope(request, 'id'), { id: { $nin: [7] } });
  assert.deepEqual(adminClientScope(request, 'user_id'), { user_id: { $nin: [7] } });
  const filter = adminTicketScope(request);
  for (const phone of ['0712345678', '+254 712 345 678', '254712345678', '712345678', '0799 887 766']) assert.equal(filter.phone_number.$not.test(phone), true, phone);
  assert.equal(filter.phone_number.$not.test('0700000000'), false);
});

function fixture(ownerKey = 'private-owner-key-only') {
  const profiles = new Map();
  const sessions = new Map();
  const attempts = new Map();
  const owners = new Map();
  const phoneOwners = new Map();
  const settings = new Map([['owner', { owner_key_hash: bcrypt.hashSync(ownerKey, 4) }]]);
  const users = directory.map(user => ({ ...user, role: 'user' }));
  const transactions = new Map([
    [101, { id: 101, user_id: 7, type: 'deposit', status: 'completed', admin_tag: null }],
    [102, { id: 102, user_id: 7, type: 'deposit', status: 'completed', admin_tag: null }],
    [103, { id: 103, user_id: 8, type: 'deposit', status: 'pending', admin_tag: null }],
    [104, { id: 104, user_id: 8, type: 'withdrawal', status: 'completed', admin_tag: null }]
  ]);
  const query = value => ({ lean: async () => value, select() { return this; }, sort() { return this; }, session: async () => value });
  const matchesUser = (user, filter) => Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') return condition.some(branch => matchesUser(user, branch));
    if (condition instanceof RegExp) return condition.test(user[field] || '');
    if (condition?.$in) return condition.$in.includes(user[field]);
    return user[field] === condition;
  });
  let queue = Promise.resolve();
  const models = {
    User: { find: filter => query(users.filter(user => matchesUser(user, filter))), findOne: filter => query(users.find(user => user.id === filter.id)) },
    Deposit: { find: () => query([]) },
    AdminPinSettings: { findById: id => query(settings.get(id)), updateOne: async (filter, update) => {
      if (!settings.has(filter._id)) settings.set(filter._id, update.$setOnInsert);
    } },
    AdminPinProfile: { findById: tag => query(profiles.has(tag) ? { pin_hash: profiles.get(tag) } : null), bulkWrite: async operations => {
      for (const op of operations) profiles.set(op.updateOne.filter._id, op.updateOne.update.$set.pin_hash);
    }, updateOne: async (filter, update) => { if (!profiles.has(filter._id)) profiles.set(filter._id, update.$setOnInsert.pin_hash); } },
    AdminPinSession: {
      create: async session => sessions.set(session.token_hash, session),
      findOne: filter => {
        const row = sessions.get(filter.token_hash);
        return query(row && row.account_hash === filter.account_hash && row.expires_at > filter.expires_at.$gt ? row : null);
      },
      deleteOne: async filter => { const row = sessions.get(filter.token_hash); if (row?.account_hash === filter.account_hash) sessions.delete(filter.token_hash); },
      deleteMany: async filter => { for (const [key, row] of sessions) if (filter.tag.$in.includes(row.tag)) sessions.delete(key); }
    },
    AdminPinAttempt: { findOneAndUpdate: async (filter, update) => {
      const now = update[0].$set.expires_at.$cond[0].$gt[1];
      const row = attempts.get(filter._id);
      const next = row && row.expires_at > now ? { ...row, attempts: row.attempts + 1 }
        : { attempts: 1, expires_at: update[0].$set.expires_at.$cond[2] };
      attempts.set(filter._id, next);
      return next;
    } },
    AdminClientOwner: {
      init: async () => {}, find: () => query([...owners.values()]),
      bulkWrite: async operations => { for (const op of operations) {
        const id = op.updateOne.filter.user_id;
        if (!owners.has(id)) owners.set(id, op.updateOne.update.$setOnInsert);
      } },
      findOneAndUpdate: async (filter, update) => {
        if (!owners.has(filter.user_id)) owners.set(filter.user_id, { user_id: filter.user_id, ...update.$setOnInsert });
        return owners.get(filter.user_id);
      }
    },
    AdminPhoneOwner: {
      init: async () => {}, find: () => query([...phoneOwners.values()]), findById: phone => query(phoneOwners.get(phone)),
      bulkWrite: async operations => { for (const op of operations) {
        const phone = op.updateOne.filter._id;
        if (!phoneOwners.has(phone)) phoneOwners.set(phone, op.updateOne.update.$setOnInsert);
      } },
      findOneAndUpdate: async (filter, update) => {
        if (!phoneOwners.has(filter._id)) phoneOwners.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
        return phoneOwners.get(filter._id);
      }
    },
    Transaction: {
      aggregate: async () => {
        const found = new Map();
        for (const tx of transactions.values()) if (tx.type === 'deposit' && tx.status === 'completed' && tx.admin_tag && !found.has(tx.user_id)) found.set(tx.user_id, { _id: tx.user_id, owner_tag: tx.admin_tag, transaction_id: tx.id });
        return [...found.values()];
      },
      findOne: filter => query(filter.id ? transactions.get(filter.id) : [...transactions.values()].find(tx => tx.user_id === filter.user_id && tx.type === filter.type && tx.status === filter.status && filter.admin_tag.$in.includes(tx.admin_tag))),
      findOneAndUpdate: async (filter, update) => {
        const tx = transactions.get(filter.id);
        if (!tx || tx.status !== filter.status || !filter.admin_tag.$in.includes(tx.admin_tag)) return null;
        Object.assign(tx, update.$set);
        return tx;
      },
      updateMany: async (filter, update) => {
        for (const tx of transactions.values()) {
          const byPhone = tx.client_phone === filter.$or[0].client_phone;
          const byAccount = tx.client_phone == null && filter.$or[1].user_id.$in.includes(tx.user_id);
          if ((byPhone || byAccount) && !filter.user_id.$nin.includes(tx.user_id)) Object.assign(tx, update.$set);
        }
      },
      startSession: async () => ({
        withTransaction: callback => {
          const work = queue.then(async () => {
            const beforeOwners = structuredClone(owners);
            const beforePhoneOwners = structuredClone(phoneOwners);
            const beforeTransactions = structuredClone(transactions);
            try { return await callback(); } catch (error) {
              owners.clear(); transactions.clear(); phoneOwners.clear();
              for (const [key, value] of beforeOwners) owners.set(key, value);
              for (const [key, value] of beforeTransactions) transactions.set(key, value);
              for (const [key, value] of beforePhoneOwners) phoneOwners.set(key, value);
              throw error;
            }
          });
          queue = work.catch(() => {});
          return work;
        }, endSession: async () => {}
      })
    }
  };
  return { service: createAdminPrivacy(models), models, profiles, sessions, attempts, transactions, owners, phoneOwners, users, settings };
}

test('private setup requires the owner key, stores hashes, rejects duplicate PINs and invalidates existing access', async () => {
  const { service, profiles, sessions } = fixture();
  await assert.rejects(service.configure('wrong-owner-key', { R: '1357' }), { status: 403 });
  await assert.rejects(service.configure('private-owner-key-only', { R: '1357', G: '1357' }), { status: 400 });
  await service.configure('private-owner-key-only', { R: '1357', G: '2468', S: '3690', V: '4826' });
  assert.notEqual(profiles.get('R'), '1357');
  assert.equal(await bcrypt.compare('1357', profiles.get('R')), true);
  const session = await service.unlock('R', '1357', 'shared-account');
  assert.equal((await service.identity(session.pinToken, 'shared-account')).tag, 'R');
  assert.ok(!JSON.stringify([...sessions.values()]).includes(session.pinToken));
  await service.configure('private-owner-key-only', { R: '1358' });
  assert.equal(await service.identity(session.pinToken, 'shared-account'), null);
});

test('admin PINs must be exactly four digits and preserve a leading zero', async () => {
  const { service, profiles } = fixture();
  for (const invalid of ['123', '12345', '123456', '12a4']) {
    await assert.rejects(service.unlock('R', invalid, 'shared-account'), { status: 400 });
    await assert.rejects(service.configure('private-owner-key-only', { R: invalid }), { status: 400 });
  }
  await service.configure('private-owner-key-only', { R: '0123' });
  assert.equal(await bcrypt.compare('0123', profiles.get('R')), true);
  const session = await service.unlock('R', '0123', 'shared-account');
  assert.equal((await service.identity(session.pinToken, 'shared-account')).tag, 'R');
});

test('a four-character owner key configures PINs and cannot be assigned as an admin PIN', async () => {
  const { service, profiles } = fixture('3842');
  await assert.rejects(service.configure('3841', { R: '1357' }), { status: 403 });
  await assert.rejects(service.configure('3842', { R: '3842' }), { status: 400 });
  await service.configure('3842', { R: '1357' });
  assert.equal(await bcrypt.compare('1357', profiles.get('R')), true);
});

test('same account can hold independent PIN identities; wrong PIN, different login token, expiry and lock never unlock', async () => {
  const { service, profiles, sessions } = fixture();
  profiles.set('R', bcrypt.hashSync('1357', 4));
  profiles.set('G', bcrypt.hashSync('2468', 4));
  await assert.rejects(service.unlock('R', '2468', 'shared-account'), { status: 403 });
  const r = await service.unlock('R', '1357', 'shared-account');
  const g = await service.unlock('G', '2468', 'shared-account');
  assert.equal((await service.identity(r.pinToken, 'shared-account')).tag, 'R');
  assert.equal((await service.identity(g.pinToken, 'shared-account')).tag, 'G');
  assert.equal(await service.identity(r.pinToken, 'another-account'), null);
  await service.lock(r.pinToken, 'shared-account');
  assert.equal(await service.identity(r.pinToken, 'shared-account'), null);
  for (const row of sessions.values()) row.expires_at = new Date(0);
  assert.equal(await service.identity(g.pinToken, 'shared-account'), null);
});

test('sixth PIN attempt is blocked across accounts', async () => {
  const { service, profiles } = fixture();
  profiles.set('R', bcrypt.hashSync('1357', 4));
  for (let i = 0; i < 5; i++) await assert.rejects(service.unlock('R', '0000', 'account-' + i), { status: 403 });
  await assert.rejects(service.unlock('R', '1357', 'correct-account'), { status: 429 });
});

test('completed deposit claims establish one client owner and reject transfers even with the same superadmin account id', async () => {
  const { service, transactions, phoneOwners } = fixture();
  await service.claim(101, 'R', 1);
  assert.equal(phoneOwners.get('254712345678').owner_tag, 'R');
  await assert.rejects(service.claim(102, 'G', 1), { status: 403 });
  await assert.rejects(service.claim(101, 'G', 1), { status: 403 });
  assert.equal(transactions.get(102).admin_tag, 'R');
  await service.claim(102, 'R', 1);
  assert.equal(transactions.get(102).admin_tag, 'R');
  await assert.rejects(service.claim(103, 'S', 1), { status: 400 });
  await assert.rejects(service.claim(104, 'S', 1), { status: 400 });
  assert.equal(phoneOwners.has('254711112222'), false);
});

test('claims avoid repeated historical scans and global user reads while ownership stays fresh', async () => {
  const { service, models, phoneOwners } = fixture();
  await service.directory();
  models.Transaction.aggregate = async () => { throw new Error('A claim must not rescan history'); };
  const find = models.User.find;
  models.User.find = filter => {
    assert.ok(filter.$or, 'claim reads only matching accounts and staff');
    return find(filter);
  };
  await service.claim(101, 'R', 1);
  models.User.find = find;
  assert.equal((await service.directory()).find(client => client.id === 7).owner_tag, 'R');
  phoneOwners.set('254711112222', { _id: '254711112222', owner_tag: 'G', user_id: 8, client_phone: '254711112222' });
  assert.equal((await service.directory()).find(client => client.id === 8).owner_tag, 'G');
});

test('ownership migration shares concurrent work and can retry after a database failure', async () => {
  const { service, models } = fixture();
  const aggregate = models.Transaction.aggregate;
  let reads = 0;
  models.Transaction.aggregate = async () => { reads++; if (reads === 1) throw new Error('Temporary failure'); return aggregate(); };
  await assert.rejects(service.directory(), /Temporary failure/);
  await Promise.all([service.directory(), service.directory(), service.directory()]);
  assert.equal(reads, 2);
  await service.directory();
  assert.equal(reads, 2);
});

test('PIN-free claim acknowledgements do not require a privacy-directory or PIN lookup', async () => {
  const { models } = fixture();
  models.Transaction.aggregate = async () => { throw new Error('No history read needed for an acknowledgement'); };
  models.AdminPinSession.findOne = () => { throw new Error('No PIN needed for claiming'); };
  const service = createAdminPrivacy(models);
  const request = { method: 'POST', originalUrl: '/api/admin/transactions/101/claim-tag',
    headers: { authorization: 'Bearer account', 'x-admin-pin': 'a'.repeat(64) }, query: {} };
  const response = { set() {}, status() { return this; } };
  const done = new Promise(resolve => { response.json = resolve; });
  service.middleware(request, response, () => response.json({ message: 'Client claimed.', transactionId: 101, tag: 'R' }));
  assert.deepEqual(await done, { message: 'Client claimed.', transactionId: 101, tag: 'R' });
});

test('one phone claim covers all statuses and equivalent numbers on different accounts without a PIN', async () => {
  const { service, users, models, transactions, profiles } = fixture();
  users.push({ id: 9, username: 'another-account', phone_number: '0712 345 678', role: 'user' });
  transactions.set(105, { id: 105, user_id: 9, type: 'deposit', status: 'failed', admin_tag: null });
  transactions.set(106, { id: 106, user_id: 9, type: 'withdrawal', status: 'pending', admin_tag: null });
  assert.equal(profiles.size, 0);
  await service.claim(101, 'R', 1);
  for (const id of [101, 102, 105, 106]) {
    assert.equal(transactions.get(id).admin_tag, 'R');
    assert.equal(transactions.get(id).client_phone, '254712345678');
  }
  const clients = await service.directory();
  assert.equal(clients.find(client => client.id === 9).owner_tag, 'R');
  assert.equal(protectPayload({ tickets: [{ phone_number: '0712345678' }] }, clients).tickets[0].phone_number, '071*****78');
  for (const type of ['deposit', 'withdrawal', 'bet_placed', 'bet_payout']) {
    for (const status of ['completed', 'failed', 'pending']) {
      const fields = await transactionOwnershipFields(models, { user_id: 9, type, status });
      assert.equal(fields.admin_tag, 'R');
    }
  }
});

test('failed transactions remain masked; their owner can unlock them and all statuses show inherited initials', () => {
  const payload = { transactions: [
    { id: 1, user_id: 7, type: 'deposit', status: 'failed', admin_tag: null, phone_number: '0712345678' },
    { id: 2, user_id: 9, type: 'deposit', status: 'failed', phone_number: '0700000000' },
    { id: 3, user_id: 9, type: 'deposit', status: 'completed', phone_number: '0700000000' },
    { id: 4, user_id: 7, type: 'withdrawal', status: 'pending', phone_number: '0712345678' }
  ] };
  const locked = protectPayload(payload, directory);
  assert.equal(locked.transactions[0].phone_number, '071*****78');
  assert.equal(locked.transactions[0].admin_tag, 'R');
  assert.equal(locked.transactions[1].phone_number, '070*****00');
  assert.equal(locked.transactions[2].phone_number, '0700000000');
  assert.equal(locked.transactions[3].admin_tag, 'R');
  assert.equal(protectPayload(payload, directory, 'R').transactions[0].phone_number, '0712345678');
});

test('admin/superadmin accounts and numbers never acquire client ownership', async () => {
  const { service, users, transactions, models, phoneOwners } = fixture();
  users.push({ id: 1, role: 'superadmin', username: 'owner', phone_number: '0712345678' });
  users.push({ id: 2, role: 'admin', username: 'staff', phone_number: '0799001122' });
  transactions.set(105, { id: 105, user_id: 2, type: 'deposit', status: 'completed', admin_tag: null });
  await assert.rejects(service.claim(101, 'R', 1), { status: 400 });
  await assert.rejects(service.claim(105, 'G', 1), { status: 400 });
  assert.equal(phoneOwners.size, 0);
  // Exemption also applies to old claims created before the exclusion existed.
  phoneOwners.set('254712345678', { _id: '254712345678', user_id: 7, owner_tag: 'R', client_phone: '254712345678' });
  const clients = await service.directory();
  const payload = protectPayload({ transactions: [{ id: 101, user_id: 7, client_phone: '254712345678',
    type: 'deposit', status: 'failed', admin_tag: 'R', phone_number: '0712345678' }] }, clients, 'G');
  assert.equal(payload.transactions[0].phone_number, '0712345678');
  assert.equal(payload.transactions[0].admin_tag, null);
  assert.equal(payload.transactions[0].ownership_exempt, true);
  assert.equal((await transactionOwnershipFields(models, { user_id: 7 })).admin_tag, null);
  assert.equal((await transactionOwnershipFields(models, { user_id: 2 })).admin_tag, null);
});

test('database PIN settings override legacy environment hashes and migrate without replacing existing values', async () => {
  const { service, models, settings, profiles } = fixture('3842');
  await migratePinSettings(models, { ADMIN_PIN_SETUP_KEY_HASH: bcrypt.hashSync('9999', 4), ADMIN_PIN_R_HASH: bcrypt.hashSync('0123', 4) });
  assert.equal(await bcrypt.compare('3842', settings.get('owner').owner_key_hash), true);
  await service.configure('3842', { G: '2468' });
  await service.unlock('R', '0123', 'shared-account');
  await migratePinSettings(models, { ADMIN_PIN_R_HASH: bcrypt.hashSync('9999', 4) });
  assert.equal(await bcrypt.compare('0123', profiles.get('R')), true);
  settings.clear();
  await assert.rejects(service.configure('3842', { G: '2468' }), { status: 503 });
});

test('concurrent deposits for the same client cannot create two owners', async () => {
  const { service, phoneOwners } = fixture();
  const results = await Promise.allSettled([service.claim(101, 'R', 1), service.claim(102, 'G', 1)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(phoneOwners.get('254712345678').owner_tag, 'R');
});

test('legacy completed deposit claims apply in support and cannot be stolen through a new deposit', async () => {
  const { service, transactions } = fixture();
  transactions.get(101).admin_tag = 'G';
  const users = await service.directory();
  const payload = { tickets: [{ id: 999, phone_number: '0712345678' }] };
  assert.equal(protectPayload(payload, users, 'R').tickets.length, 0);
  assert.equal(protectPayload(payload, users).tickets[0].phone_number, '071*****78');
  await assert.rejects(service.claim(102, 'R', 1), { status: 403 });
});

test('legacy ownership remains private after deposit ledger reset or client deletion', async () => {
  const { service, transactions, models } = fixture();
  transactions.get(101).admin_tag = 'R';
  await service.directory();
  transactions.clear();
  models.User.find = () => ({ select() { return this; }, lean: async () => [] });
  const users = await service.directory();
  assert.equal(users[0].owner_tag, 'R');
  const payload = protectPayload({ tickets: [{ phone_number: '0712345678' }] }, users);
  assert.equal(payload.tickets[0].phone_number, '071*****78');
});

test('all HTTP admin response data fails closed if ownership lookup fails', async () => {
  const { models } = fixture();
  models.Transaction.aggregate = async () => { throw new Error('Database offline'); };
  const service = createAdminPrivacy(models, {});
  const request = { headers: { authorization: 'Bearer admin-account' }, query: {} };
  const response = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; } };
  const finished = new Promise(resolve => { response.json = resolve; });
  service.middleware(request, response, () => response.json({ users: [{ phone_number: '0712345678' }] }));
  const payload = await finished;
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.ok(!JSON.stringify(payload).includes('0712345678'));
});

test('socket broadcasts verify each PIN independently and initial snapshots cannot expose claimed phones', async () => {
  const { service, profiles } = fixture();
  profiles.set('R', bcrypt.hashSync('1357', 4));
  profiles.set('G', bcrypt.hashSync('2468', 4));
  await service.claim(101, 'R', 1);
  const r = await service.unlock('R', '1357', 'shared');
  const g = await service.unlock('G', '2468', 'shared');
  function socket(pinToken) {
    const events = [];
    let resolve;
    const done = new Promise(res => { resolve = res; });
    const socket = { connected: true, handshake: { auth: { token: 'shared', pinToken } }, emit: (event, payload) => { events.push({ event, payload }); resolve(); } };
    service.protectSocket(socket);
    return { socket, events, done };
  }
  const first = socket(r.pinToken), second = socket(g.pinToken), locked = socket(null);
  const namespace = { sockets: new Map([[1, first.socket], [2, second.socket], [3, locked.socket]]) };
  service.protectNamespace(namespace);
  namespace.emit('admin_online_players', { topPlayers: [{ id: 7, balance: 5, phone_number: '+254712345678' }] });
  await Promise.all([first.done, second.done, locked.done]);
  assert.equal(first.events[0].payload.topPlayers[0].phone_number, '+254712345678');
  assert.equal(second.events[0].payload.topPlayers.length, 0);
  assert.equal(locked.events[0].payload.topPlayers[0].phone_number, '+25471*****78');
});
