const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { normalizePhone, isStaff, phoneFor, staffPhones } = require('./admin-phone-ownership');

const ADMIN_TAGS = ['R', 'G', 'S', 'V'];
const PIN_SESSION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
function maskPhone(value) {
  const text = String(value || '');
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return (text.startsWith('+') ? '+' : '') + digits.slice(0, -7) + '*****' + digits.slice(-2);
}
const phonePattern = /(?<!\d)(?:\+?254[\s().-]*[17]|0[\s().-]*[17]|[17])(?:[\s().-]*\d){8}(?!\d)/g;
function needsPrivacy(payload) {
  const serialized = JSON.stringify(payload) || '';
  phonePattern.lastIndex = 0;
  return /phone_number|phoneNumber|payer_phone|account_details|username|sender_name|admin_tag|password_hash|pin_hash/.test(serialized) || phonePattern.test(serialized);
}
function adminClientScope(req, field) {
  return req.blockedClientIds?.length ? { [field]: { $nin: req.blockedClientIds } } : {};
}
function adminTicketScope(req) {
  const clients = req.blockedClients || [];
  const phones = [...new Set(clients.flatMap(client => [client.phone_number, ...(client.payer_phones || [])]).filter(Boolean).map(normalizePhone))];
  const patterns = phones.filter(phone => phone.length >= 9).map(phone => {
    const kenyan = /^254[17]\d{8}$/.test(phone);
    const digits = kenyan ? phone.slice(3) : phone;
    return (kenyan ? '(?:\\+?254[\\s().-]*|0[\\s().-]*)?' : '\\+?') + digits.split('').join('[\\s().-]*');
  });
  const filter = {};
  if (patterns.length) filter.phone_number = { $not: new RegExp('^\\s*(?:' + patterns.join('|') + ')\\s*$') };
  const names = clients.map(client => client.username).filter(Boolean);
  if (names.length) filter.username = { $nin: names };
  return filter;
}

// Work on a copy: player responses and in-memory presence retain their original data.
function protectPayload(payload, directory, tag = null, search = '') {
  const byId = new Map(directory.map(user => [Number(user.id), user]));
  const byName = new Map(directory.filter(user => user.username).map(user => [user.username, user]));
  const byPhone = new Map();
  for (const user of directory) {
    for (const phone of [user.phone_number, user.username, ...(user.payer_phones || [])]) {
      const key = normalizePhone(phone);
      if (key.length < 9) continue;
      const existing = byPhone.get(key);
      byPhone.set(key, user.exempt ? user : existing?.exempt ? existing : existing && existing.owner_tag !== user.owner_tag
        ? { owner_tag: null } : user);
    }
  }
  function ownerOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (isStaff(value)) return { exempt: true };
    const snapshotOwner = value.client_phone ? byPhone.get(normalizePhone(value.client_phone)) : null;
    const phoneOwner = byPhone.get(normalizePhone(value.phone_number || value.phoneNumber || value.payer_phone));
    const userId = value.user_id ?? value.userId ?? value.target_user_id
      ?? (('balance' in value || 'role' in value || 'is_online' in value) ? value.id : null);
    return snapshotOwner || byId.get(Number(userId)) || phoneOwner || byName.get(value.username) || (value.admin_tag ? { owner_tag: value.admin_tag } : null);
  }
  function visit(value, restricted = false, field = '') {
    if (typeof value === 'number') {
      const owner = byPhone.get(normalizePhone(value));
      if (owner?.exempt) return value;
      if ((restricted && /phone/i.test(field)) || (owner && (!tag || owner.owner_tag !== tag))) return maskPhone(value);
      return value;
    }
    if (typeof value === 'string') {
      if (byPhone.get(normalizePhone(value))?.exempt) return value;
      if (restricted && (/phone/i.test(field) || field === 'account_details') && /\d{7}/.test(value.replace(/\D/g, ''))) {
        return value.replace(phonePattern, match => maskPhone(match)) === value ? maskPhone(value) : value.replace(phonePattern, match => maskPhone(match));
      }
      return value.replace(phonePattern, match => {
        const owner = byPhone.get(normalizePhone(match));
        if (owner?.exempt) return match;
        return restricted || (owner && (!tag || owner.owner_tag !== tag)) ? maskPhone(match) : match;
      });
    }
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (typeof value.toJSON === 'function') return visit(value.toJSON(), restricted, field);
    if (Array.isArray(value)) {
      const rows = value.filter(item => {
        const owner = ownerOf(item);
        return !tag || !owner || owner.exempt || owner.owner_tag === tag;
      }).map(item => visit(item, restricted, field));
      if (!search || !['users', 'transactions', 'activeUsers', 'players'].includes(field)) return rows;
      const query = String(search).trim().toLowerCase();
      const digits = query.replace(/\D/g, '');
      return rows.filter(row => {
        if (String(row.id) === query || String(row.user_id) === query) return true;
        return [row.username, row.phone_number, row.phoneNumber, row.reference].some(text => {
          if (!text) return false;
          if (String(text).toLowerCase().includes(query)) return true;
          return digits.length >= 7 && !String(text).includes('*') && normalizePhone(text) === normalizePhone(digits);
        });
      });
    }
    // A support ticket's id is a ticket ID, so use its phone to resolve ownership.
    const owner = ownerOf(value);
    const ownerTag = owner?.exempt ? null : owner?.owner_tag || value.admin_tag;
    const failedHidden = value.status === 'failed' && value.user_id !== undefined && (!ownerTag || ownerTag !== tag);
    const hidden = !owner?.exempt && (restricted || failedHidden || Boolean(owner && (!tag || owner.owner_tag !== tag))
      || Boolean(ownerTag && ownerTag !== tag));
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (['password_hash', 'pin_hash', 'owner_key_hash', 'token_hash', 'account_hash'].includes(key)) continue;
      const callbackPhone = /phone/i.test(String(value.Name || value.name || '')) && /^(value)$/i.test(key);
      result[key] = visit(child, hidden, callbackPhone ? 'phone' : key);
    }
    if ((ownerTag || failedHidden) && ('phone_number' in value || 'phoneNumber' in value)) {
      if (ownerTag) result.client_admin_tag = ownerTag;
      result.phone_hidden = hidden;
    }
    if (value.user_id !== undefined && value.type) {
      result.ownership_exempt = Boolean(owner?.exempt);
      result.admin_tag = ownerTag || null;
      if (ownerTag && owner?.claimed_at) {
        result.admin_tagged_by = owner.admin_id || null;
        result.admin_tagged_at = owner.claimed_at;
      }
    }
    if (search && Array.isArray(value.players) && result.players.length !== value.players.length) {
      result.total = result.players.length;
      result.page = 1;
      result.totalPages = 1;
    }
    return result;
  }
  return visit(payload);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function createAdminPrivacy(models) {
  const { User, Transaction, Deposit, AdminClientOwner, AdminPhoneOwner, AdminPinSettings, AdminPinSession, AdminPinAttempt, AdminPinProfile } = models;
  const configuredHash = async tag => (await AdminPinProfile.findById(tag).lean())?.pin_hash || '';
  let migrationPromise;

  function ensureOwnershipMigration() {
    if (!migrationPromise) migrationPromise = migrateLegacyOwnership().catch(error => {
      migrationPromise = null;
      throw error;
    });
    return migrationPromise;
  }

  async function migrateLegacyOwnership() {
    const [users, persisted, legacy] = await Promise.all([
      User.find({}).select('id username phone_number role').lean(),
      AdminClientOwner.find({}).lean(),
      Transaction.aggregate([
      { $match: { type: 'deposit', status: 'completed', admin_tag: { $in: ADMIN_TAGS } } },
      { $sort: { admin_tagged_at: 1, created_at: 1, id: 1 } },
      { $group: { _id: '$user_id', owner_tag: { $first: '$admin_tag' }, transaction_id: { $first: '$id' },
        claimed_at: { $first: '$admin_tagged_at' }, admin_id: { $first: '$admin_tagged_by' } } }
      ])
    ]);
    const userMap = new Map(users.map(user => [Number(user.id), user]));
    const exemptPhones = staffPhones(users);
    // Import previous claims into the phone ledger once; the unique phone key makes ownership durable.
    const snapshots = new Map(persisted.map(row => [Number(row.user_id), row]));
    const candidates = [...persisted, ...legacy.filter(row => !snapshots.has(Number(row._id))).map(row => ({
      user_id: row._id, owner_tag: row.owner_tag, claimed_transaction_id: row.transaction_id,
      claimed_at: row.claimed_at, admin_id: row.admin_id
    }))].sort((a, b) => (new Date(a.claimed_at || 0) - new Date(b.claimed_at || 0))
      || (a.claimed_transaction_id || 0) - (b.claimed_transaction_id || 0));
    const existing = await AdminPhoneOwner.find({}).lean();
    const owners = new Map(existing.map(row => [row._id, row]));
    const writes = [];
    for (const row of candidates) {
      const client = userMap.get(Number(row.user_id));
      const phone = normalizePhone(row.client_phone || phoneFor(client));
      if (phone.length < 9 || isStaff(client) || exemptPhones.has(phone) || owners.has(phone)) continue;
      const owner = { ...row, _id: phone, client_phone: phone, client_username: row.client_username || client?.username,
        claimed_at: row.claimed_at || new Date() };
      owners.set(phone, owner);
      writes.push({ updateOne: { filter: { _id: phone }, update: { $setOnInsert: owner }, upsert: true } });
    }
    if (writes.length) {
      await AdminPhoneOwner.init();
      await AdminPhoneOwner.bulkWrite(writes);
    }
  }

  async function directory() {
    await ensureOwnershipMigration();
    // Only the legacy import is memoized. Live ownership and exemptions are always fresh.
    const [users, existing] = await Promise.all([
      User.find({}).select('id username phone_number role').lean(),
      AdminPhoneOwner.find({}).lean()
    ]);
    const exemptPhones = staffPhones(users);
    const owners = new Map(existing.map(row => [row._id, row]));
    const ownedUsers = users.filter(user => !isStaff(user) && !exemptPhones.has(phoneFor(user)) && owners.has(phoneFor(user)));
    const ids = [...new Set([...ownedUsers.map(user => user.id), ...[...owners.values()].map(owner => owner.user_id)])];
    const deposits = ids.length ? await Deposit.find({ user_id: { $in: ids }, payer_phone: { $ne: null } }).select('user_id payer_phone').lean() : [];
    const payerPhones = new Map();
    for (const deposit of deposits) {
      if (exemptPhones.has(normalizePhone(deposit.payer_phone))) continue;
      const phones = payerPhones.get(Number(deposit.user_id)) || [];
      phones.push(deposit.payer_phone);
      payerPhones.set(Number(deposit.user_id), phones);
    }
    const result = ownedUsers.map(user => {
      const owner = owners.get(phoneFor(user));
      return { ...user, ...owner, id: user.id, username: user.username, phone_number: user.phone_number || phoneFor(user),
        payer_phones: [...new Set([...(payerPhones.get(Number(user.id)) || []), ...(payerPhones.get(Number(owner.user_id)) || [])])] };
    });
    const representedPhones = new Set(ownedUsers.map(phoneFor));
    for (const owner of owners.values()) {
      if (exemptPhones.has(owner._id)) continue;
      if (!representedPhones.has(owner._id)) result.push({ ...owner, id: owner.user_id,
        username: owner.client_username, phone_number: owner._id, payer_phones: payerPhones.get(Number(owner.user_id)) || [] });
    }
    return [...result, ...users.filter(user => isStaff(user) || exemptPhones.has(phoneFor(user))).map(user => ({ ...user, exempt: true }))];
  }

  async function identity(pinToken, accountToken) {
    if (!pinToken || !accountToken || !/^[a-f0-9]{64}$/.test(String(pinToken))) return null;
    const session = await AdminPinSession.findOne({
      token_hash: digest(pinToken), account_hash: digest(accountToken), expires_at: { $gt: new Date() }
    }).lean();
    if (!session || session.profile_hash !== digest(await configuredHash(session.tag))) return null;
    return session;
  }

  async function unlock(tag, pin, accountToken) {
    if (!ADMIN_TAGS.includes(tag) || !/^\d{4}$/.test(String(pin || ''))) throw fail(400, 'Choose R, G, S or V and enter your 4-digit PIN.');
    const hash = await configuredHash(tag);
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) throw fail(503, `PIN for ${tag} has not been configured. Contact the platform owner.`);
    const now = new Date();
    // An atomic, shared database counter prevents parallel requests or server replicas bypassing the limit.
    const attempt = await AdminPinAttempt.findOneAndUpdate({ _id: tag }, [
      { $set: {
        attempts: { $cond: [{ $gt: ['$expires_at', now] }, { $add: [{ $ifNull: ['$attempts', 0] }, 1] }, 1] },
        expires_at: { $cond: [{ $gt: ['$expires_at', now] }, '$expires_at', new Date(now.getTime() + ATTEMPT_WINDOW_MS)] }
      } }
    ], { upsert: true, new: true });
    if (attempt.attempts > 5) throw fail(429, 'Too many PIN attempts. Try again after 15 minutes.');
    if (!await bcrypt.compare(String(pin), hash)) throw fail(403, 'Incorrect admin PIN.');
    const pinToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + PIN_SESSION_MS);
    await AdminPinSession.create({
      token_hash: digest(pinToken), account_hash: digest(accountToken), tag,
      profile_hash: digest(hash), expires_at: expiresAt
    });
    return { pinToken, tag, expiresAt: expiresAt.toISOString() };
  }

  async function lock(pinToken, accountToken) {
    await AdminPinSession.deleteOne({ token_hash: digest(pinToken), account_hash: digest(accountToken) });
  }

  async function configure(ownerKey, pins) {
    const hash = (await AdminPinSettings.findById('owner').lean())?.owner_key_hash || '';
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) throw fail(503, 'The private owner key has not been initialized in the database. Run the database owner-key setup.');
    if (typeof ownerKey !== 'string' || ownerKey.length < 4 || Buffer.byteLength(ownerKey, 'utf8') > 72) throw fail(403, 'Incorrect private owner key.');
    const now = new Date();
    const attempts = await AdminPinAttempt.findOneAndUpdate({ _id: 'owner-setup' }, [
      { $set: {
        attempts: { $cond: [{ $gt: ['$expires_at', now] }, { $add: [{ $ifNull: ['$attempts', 0] }, 1] }, 1] },
        expires_at: { $cond: [{ $gt: ['$expires_at', now] }, '$expires_at', new Date(now.getTime() + ATTEMPT_WINDOW_MS)] }
      } }
    ], { upsert: true, new: true });
    if (attempts.attempts > 5) throw fail(429, 'Too many owner-key attempts. Try again after 15 minutes.');
    if (!await bcrypt.compare(ownerKey, hash)) throw fail(403, 'Incorrect private owner key.');
    const tags = ADMIN_TAGS.filter(tag => pins?.[tag]);
    if (!tags.length || tags.some(tag => typeof pins[tag] !== 'string' || !/^\d{4}$/.test(pins[tag]))) throw fail(400, 'Enter a 4-digit PIN for each admin you want to configure.');
    const current = await Promise.all(ADMIN_TAGS.map(configuredHash));
    const nextHashes = new Map();
    for (const tag of tags) {
      if (pins[tag] === ownerKey) throw fail(400, 'An admin PIN must be different from the private owner key.');
      for (const other of ADMIN_TAGS) {
        if (other === tag) continue;
        if (pins[other] && pins[other] === pins[tag]) throw fail(400, 'Each admin must have a different PIN.');
        if (!pins[other] && current[ADMIN_TAGS.indexOf(other)] && await bcrypt.compare(pins[tag], current[ADMIN_TAGS.indexOf(other)])) throw fail(400, 'Each admin must have a different PIN.');
      }
      nextHashes.set(tag, await bcrypt.hash(pins[tag], 12));
    }
    await AdminPinProfile.bulkWrite(tags.map(tag => ({ updateOne: {
      filter: { _id: tag }, update: { $set: { pin_hash: nextHashes.get(tag), updated_at: now } }, upsert: true
    } })));
    await AdminPinSession.deleteMany({ tag: { $in: tags } });
    return { message: `PINs saved for ${tags.join(', ')}.`, configuredTags: tags };
  }

  async function claim(txId, tag, adminId) {
    if (!ADMIN_TAGS.includes(tag)) throw fail(400, 'Invalid admin initial.');
    await ensureOwnershipMigration();
    await AdminPhoneOwner.init();
    const session = await Transaction.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const tx = await Transaction.findOne({ id: txId }).session(session);
        if (!tx) throw fail(404, 'Transaction not found.');
        if (tx.type !== 'deposit' || tx.status !== 'completed') throw fail(400, 'Only completed deposits can be claimed.');
        const client = await User.findOne({ id: tx.user_id }).select('id username phone_number role').session(session);
        if (!client) throw fail(404, 'Client account not found.');
        const phone = normalizePhone(tx.client_phone || phoneFor(client));
        const phoneDigits = /^254[17]\d{8}$/.test(phone) ? phone.slice(3) : phone;
        const prefix = /^254[17]\d{8}$/.test(phone) ? '(?:\\+?254[\\s().-]*|0[\\s().-]*)?' : '\\+?';
        const equivalentPhone = new RegExp('^\\s*' + prefix + phoneDigits.split('').join('[\\s().-]*') + '\\s*$');
        const users = await User.find({ $or: [
          { role: { $in: ['admin', 'superadmin'] } }, { phone_number: equivalentPhone }, { username: equivalentPhone }
        ] }).select('id username phone_number role').session(session);
        if (isStaff(client) || staffPhones(users).has(phone)) throw fail(400, 'Admin and superadmin numbers are excluded from client ownership.');
        if (phone.length < 9) throw fail(400, 'Client needs a valid phone number before claiming.');
        if (tx.admin_tag && tx.admin_tag !== tag) throw fail(403, `Transaction belongs to admin ${tx.admin_tag}.`);
        const owner = await AdminPhoneOwner.findOneAndUpdate({ _id: phone }, {
          $setOnInsert: { owner_tag: tag, user_id: client.id, admin_id: adminId, claimed_transaction_id: tx.id,
            claimed_at: new Date(), client_phone: phone, client_username: client.username }
        }, { upsert: true, new: true, session });
        if (owner.owner_tag !== tag) throw fail(403, `Client already belongs to admin ${owner.owner_tag}.`);
        const relatedIds = users.filter(user => !isStaff(user) && phoneFor(user) === phone).map(user => user.id);
        await Transaction.updateMany({ $or: [{ client_phone: phone }, { client_phone: null, user_id: { $in: relatedIds } }],
          user_id: { $nin: users.filter(isStaff).map(user => user.id) } }, {
          $set: { client_phone: phone, admin_tag: tag, admin_tagged_by: owner.admin_id, admin_tagged_at: owner.claimed_at }
        }, { session });
        result = await Transaction.findOneAndUpdate({ id: txId, type: 'deposit', status: 'completed', admin_tag: { $in: [null, tag] } }, {
          $set: { client_phone: phone, admin_tag: tag, admin_tagged_by: owner.admin_id, admin_tagged_at: owner.claimed_at }
        }, { new: true, session });
        if (!result) throw fail(409, 'Transaction changed. Refresh and try again.');
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  function middleware(req, res, next) {
    const sendJson = res.json.bind(res);
    res.set('Cache-Control', 'no-store');
    const accountToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    req.adminAccountToken = accountToken;
    const controlRequest = req.method === 'POST' && /^\/api\/admin\/(?:pin\/(?:unlock|lock|configure)|transactions\/\d+\/claim-tag)$/.test((req.originalUrl || '').split('?')[0]);
    (controlRequest ? Promise.resolve(null) : identity(req.headers['x-admin-pin'], accountToken)).then(async pinIdentity => {
      req.pinIdentity = pinIdentity;
      if (!controlRequest && req.method !== 'GET') await ensureOwnershipMigration();
      const clients = pinIdentity && !controlRequest ? await directory() : [];
      req.blockedClients = pinIdentity ? clients.filter(client => !client.exempt && client.owner_tag !== pinIdentity.tag) : [];
      req.blockedClientIds = req.blockedClients.map(client => client.id);
      res.json = payload => {
        // Serialize immediately so concurrent mutations cannot alter an outbound snapshot.
        const snapshot = JSON.parse(JSON.stringify(payload));
        const privateData = needsPrivacy(snapshot);
        Promise.all([privateData ? directory() : [], privateData ? identity(req.headers['x-admin-pin'], accountToken) : null])
          .then(([users, currentIdentity]) => sendJson(protectPayload(snapshot, users, currentIdentity?.tag, req.query?.search)))
          .catch(() => { if (!res.headersSent) { res.status(503); sendJson({ error: 'Phone privacy verification unavailable. Please retry.' }); } });
        return res;
      };
      next();
    }).catch(() => res.status(503).json({ error: 'Admin PIN verification unavailable. Please retry.' }));
  }

  function protectSocket(socket) {
    const send = socket.emit.bind(socket);
    let queue = Promise.resolve();
    socket.emit = (event, payload, sharedDirectory = null) => {
      const snapshot = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
      queue = queue.then(async () => {
        // Countdown and wallet amounts contain no client identity; keep them immediate and cheap.
        if (!needsPrivacy(snapshot)) {
          if (socket.connected) send(event, snapshot);
          return;
        }
        const [users, pinIdentity] = await Promise.all([
          sharedDirectory || directory(), identity(socket.handshake.auth?.pinToken, socket.handshake.auth?.token)
        ]);
        if (socket.connected) send(event, protectPayload(snapshot, users, pinIdentity?.tag));
      }).catch(() => { if (socket.connected) send('admin_privacy_unavailable', { message: 'Phone privacy verification unavailable.' }); });
      return socket;
    };
  }

  function protectNamespace(namespace) {
    namespace.emit = (event, payload) => {
      // Each recipient has a separate PIN identity even when account tokens are shared.
      // Share one ownership read per broadcast, never a timed cache of pre-claim ownership.
      const users = namespace.sockets.size && needsPrivacy(payload) ? directory() : null;
      if (users) users.catch(() => {});
      for (const socket of namespace.sockets.values()) socket.emit(event, payload, users);
      return true;
    };
  }
  return { directory, identity, unlock, lock, configure, claim, middleware, protectSocket, protectNamespace };
}

module.exports = { ADMIN_TAGS, PIN_SESSION_MS, normalizePhone, maskPhone, protectPayload, adminClientScope, adminTicketScope, createAdminPrivacy };
