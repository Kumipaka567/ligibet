const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ADMIN_TAGS = ['R', 'G', 'S', 'V'];
const PIN_SESSION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const normalizePhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return '254' + digits;
  return digits;
};
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
      byPhone.set(key, existing && existing.owner_tag !== user.owner_tag
        ? { owner_tag: null } : user);
    }
  }
  function ownerOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const phoneOwner = byPhone.get(normalizePhone(value.phone_number || value.phoneNumber || value.payer_phone));
    const userId = value.user_id ?? value.userId ?? value.target_user_id
      ?? (('balance' in value || 'role' in value || 'is_online' in value) ? value.id : null);
    return byId.get(Number(userId)) || phoneOwner || byName.get(value.username) || (value.admin_tag ? { owner_tag: value.admin_tag } : null);
  }
  function visit(value, restricted = false, field = '') {
    if (typeof value === 'number') {
      const owner = byPhone.get(normalizePhone(value));
      if ((restricted && /phone/i.test(field)) || (owner && (!tag || owner.owner_tag !== tag))) return maskPhone(value);
      return value;
    }
    if (typeof value === 'string') {
      if (restricted && (/phone/i.test(field) || field === 'account_details') && /\d{7}/.test(value.replace(/\D/g, ''))) {
        return value.replace(phonePattern, match => maskPhone(match)) === value ? maskPhone(value) : value.replace(phonePattern, match => maskPhone(match));
      }
      return value.replace(phonePattern, match => {
        const owner = byPhone.get(normalizePhone(match));
        return restricted || (owner && (!tag || owner.owner_tag !== tag)) ? maskPhone(match) : match;
      });
    }
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (typeof value.toJSON === 'function') return visit(value.toJSON(), restricted, field);
    if (Array.isArray(value)) {
      const rows = value.filter(item => {
        const owner = ownerOf(item);
        return !tag || !owner || owner.owner_tag === tag;
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
    const ownerTag = owner?.owner_tag || value.admin_tag;
    const hidden = restricted || Boolean(owner && (!tag || owner.owner_tag !== tag))
      || Boolean(ownerTag && ownerTag !== tag);
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (['password_hash', 'pin_hash', 'token_hash', 'account_hash'].includes(key)) continue;
      const callbackPhone = /phone/i.test(String(value.Name || value.name || '')) && /^(value)$/i.test(key);
      result[key] = visit(child, hidden, callbackPhone ? 'phone' : key);
    }
    if (ownerTag && ('phone_number' in value || 'phoneNumber' in value)) {
      result.client_admin_tag = ownerTag;
      result.phone_hidden = hidden;
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

function createAdminPrivacy(models, env = process.env) {
  const { User, Transaction, Deposit, AdminClientOwner, AdminPinSession, AdminPinAttempt, AdminPinProfile } = models;
  const configuredHash = async tag => (await AdminPinProfile.findById(tag).lean())?.pin_hash || env[`ADMIN_PIN_${tag}_HASH`] || '';

  async function directory() {
    // Existing completed deposit claims take effect immediately, including after a restart.
    // Earliest claim wins if legacy transactions contain conflicting initials.
    const legacy = await Transaction.aggregate([
      { $match: { type: 'deposit', status: 'completed', admin_tag: { $in: ADMIN_TAGS } } },
      { $sort: { admin_tagged_at: 1, created_at: 1, id: 1 } },
      { $group: { _id: '$user_id', owner_tag: { $first: '$admin_tag' }, transaction_id: { $first: '$id' }, claimed_at: { $first: '$admin_tagged_at' } } }
    ]);
    const owners = new Map(legacy.map(row => [Number(row._id), row.owner_tag]));
    const persisted = await AdminClientOwner.find({}).lean();
    for (const row of persisted) owners.set(Number(row.user_id), row.owner_tag);
    if (!owners.size) return [];
    const ids = [...owners.keys()];
    const [users, deposits] = await Promise.all([
      User.find({ id: { $in: ids } }).select('id username phone_number').lean(),
      Deposit.find({ user_id: { $in: ids }, payer_phone: { $ne: null } }).select('user_id payer_phone').lean()
    ]);
    const payerPhones = new Map();
    for (const deposit of deposits) {
      const phones = payerPhones.get(Number(deposit.user_id)) || [];
      phones.push(deposit.payer_phone);
      payerPhones.set(Number(deposit.user_id), phones);
    }
    const userMap = new Map(users.map(user => [Number(user.id), user]));
    const snapshots = new Map(persisted.map(owner => [Number(owner.user_id), owner]));
    const missingOwners = legacy.filter(row => !snapshots.has(Number(row._id)));
    if (missingOwners.length) {
      await AdminClientOwner.init();
      const writes = missingOwners.map(row => {
        const client = userMap.get(Number(row._id));
        const owner = { user_id: row._id, owner_tag: row.owner_tag, claimed_transaction_id: row.transaction_id,
          claimed_at: row.claimed_at || new Date(), client_phone: client?.phone_number || payerPhones.get(Number(row._id))?.[0], client_username: client?.username };
        snapshots.set(Number(row._id), owner);
        return { updateOne: { filter: { user_id: row._id }, update: { $setOnInsert: owner }, upsert: true } };
      });
      // Persist historical ownership before any admin mutation can delete the original deposit ledger.
      await AdminClientOwner.bulkWrite(writes);
    }
    return ids.map(id => ({
      id, username: snapshots.get(id)?.client_username, phone_number: snapshots.get(id)?.client_phone,
      ...userMap.get(id), owner_tag: owners.get(id), payer_phones: [...(payerPhones.get(id) || []), snapshots.get(id)?.client_phone].filter(Boolean)
    }));
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
    const hash = env.ADMIN_PIN_SETUP_KEY_HASH || '';
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) throw fail(503, 'The private owner key has not been configured on the server.');
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
      if (await bcrypt.compare(pins[tag], hash)) throw fail(400, 'An admin PIN must be different from the private owner key.');
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
    await AdminClientOwner.init();
    const session = await Transaction.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const tx = await Transaction.findOne({ id: txId }).session(session);
        if (!tx) throw fail(404, 'Transaction not found.');
        if (tx.type !== 'deposit' || tx.status !== 'completed') throw fail(400, 'Only completed deposits can be claimed.');
        const client = await User.findOne({ id: tx.user_id }).select('id username phone_number').session(session);
        if (!client) throw fail(404, 'Client account not found.');
        if (tx.admin_tag && tx.admin_tag !== tag) throw fail(403, `Transaction belongs to admin ${tx.admin_tag}.`);
        const legacy = await Transaction.findOne({ user_id: tx.user_id, type: 'deposit', status: 'completed', admin_tag: { $in: ADMIN_TAGS } })
          .sort({ admin_tagged_at: 1, created_at: 1, id: 1 }).session(session);
        const owner = await AdminClientOwner.findOneAndUpdate({ user_id: tx.user_id }, {
          $setOnInsert: { owner_tag: legacy?.admin_tag || tag, claimed_transaction_id: legacy?.id || tx.id, claimed_at: new Date(), client_phone: client.phone_number, client_username: client.username }
        }, { upsert: true, new: true, session });
        if (owner.owner_tag !== tag) throw fail(403, `Client already belongs to admin ${owner.owner_tag}.`);
        result = await Transaction.findOneAndUpdate({ id: txId, type: 'deposit', status: 'completed', admin_tag: { $in: [null, tag] } }, {
          $set: { admin_tag: tag, admin_tagged_by: adminId, admin_tagged_at: tx.admin_tagged_at || new Date() }
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
    identity(req.headers['x-admin-pin'], accountToken).then(async pinIdentity => {
      req.pinIdentity = pinIdentity;
      const clients = pinIdentity || req.method !== 'GET' ? await directory() : [];
      req.blockedClients = pinIdentity ? clients.filter(client => client.owner_tag !== pinIdentity.tag) : [];
      req.blockedClientIds = req.blockedClients.map(client => client.id);
      res.json = payload => {
        // Serialize immediately so concurrent mutations cannot alter an outbound snapshot.
        const snapshot = JSON.parse(JSON.stringify(payload));
        Promise.all([needsPrivacy(snapshot) ? directory() : [], identity(req.headers['x-admin-pin'], accountToken)])
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
