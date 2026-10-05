const { userSearchConditions } = require('./user-search');

// Presence comes only from verified, connected player sockets. Transactions and
// old bets never make an offline account appear online.
function createOnlinePlayers({ onChange = () => {}, now = () => new Date() } = {}) {
  const accounts = new Map();
  const sockets = new Map();
  let version = 0;
  let players = [];
  let summary = { onlineUsers: 0, connectedPlayers: 0, topPlayers: [], version, updatedAt: now().toISOString() };

  function profile(user) {
    return {
      id: Number(user.id), username: String(user.username || ''),
      phone_number: String(user.phone_number || ''), role: user.role || 'user',
      balance: Number(user.balance) || 0, is_suspended: Boolean(user.is_suspended),
      created_at: user.created_at || null, is_online: true
    };
  }

  function publish() {
    const previous = JSON.stringify([summary.onlineUsers, summary.connectedPlayers, summary.topPlayers]);
    players = Array.from(accounts.values())
      .filter(entry => entry.sockets.size && entry.user.role === 'user' && !entry.user.is_suspended)
      .map(entry => entry.user)
      .sort((a, b) => b.balance - a.balance || a.id - b.id);
    const connectedPlayers = players.reduce((total, user) => total + accounts.get(user.id).sockets.size, 0);
    summary = {
      onlineUsers: players.length, connectedPlayers,
      topPlayers: players.slice(0, 5), version: ++version, updatedAt: now().toISOString()
    };
    if (JSON.stringify([summary.onlineUsers, summary.connectedPlayers, summary.topPlayers]) !== previous) onChange(summary);
  }

  return {
    connect(socketId, user) {
      const id = Number(user?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || !user?.username || sockets.has(socketId)) return;
      const entry = accounts.get(id) || { user: profile(user), sockets: new Set() };
      entry.sockets.add(socketId);
      accounts.set(id, entry);
      sockets.set(socketId, id);
      publish();
    },
    disconnect(socketId) {
      const id = sockets.get(socketId);
      if (id === undefined) return;
      sockets.delete(socketId);
      const entry = accounts.get(id);
      entry.sockets.delete(socketId);
      if (!entry.sockets.size) accounts.delete(id);
      publish();
    },
    updateUser(id, patch) {
      const entry = accounts.get(Number(id));
      if (!entry) return;
      const next = profile({ ...entry.user, ...patch, id: entry.user.id });
      if (JSON.stringify(next) === JSON.stringify(entry.user)) return;
      entry.user = next;
      publish();
    },
    removeUser(id) {
      const entry = accounts.get(Number(id));
      if (!entry) return;
      for (const socketId of entry.sockets) sockets.delete(socketId);
      accounts.delete(Number(id));
      publish();
    },
    summary: () => summary,
    list({ search = '', page = 1, pageSize = 25 } = {}) {
      const conditions = userSearchConditions(search);
      const matches = conditions.length ? players.filter(user => conditions.some(condition => {
        const [field, pattern] = Object.entries(condition)[0];
        return pattern.test(user[field] || '');
      })) : players;
      const size = Math.max(1, Math.min(25, Math.floor(Number(pageSize)) || 25));
      const pages = Math.max(1, Math.ceil(matches.length / size));
      const currentPage = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1));
      return {
        ...summary, players: matches.slice((currentPage - 1) * size, currentPage * size),
        total: matches.length, page: currentPage, pageSize: size, totalPages: pages
      };
    }
  };
}

module.exports = { createOnlinePlayers };
