// Central fan-out for committed wallet and account changes.
function createRealtimeEmitter(io, adminNamespace) {
  return function emitRealtimeMutation({
    action, userId = null, balance, transaction = null, deposits = false,
    withdrawals = false, user = false, dashboard = true, notifyPlayer = true,
    isOnline
  }) {
    const payload = { action, userId, occurredAt: new Date().toISOString() };
    const hasBalance = (typeof balance === 'number' || typeof balance === 'string')
      && String(balance).trim() !== '' && Number.isFinite(Number(balance));
    const walletPayload = hasBalance ? { ...payload, balance: Number(balance) } : null;
    const userPayload = user && typeof user === 'object'
      ? { ...payload, user: publicRealtimeUser(user) } : { ...payload };
    if (typeof isOnline === 'boolean') {
      userPayload.is_online = isOnline;
      if (userPayload.user) userPayload.user.is_online = isOnline;
    }

    if (userId !== null && userId !== undefined && notifyPlayer) {
      // Numeric and string IDs resolve to the same room; emit only once.
      const player = io.to('user_' + userId);
      if (walletPayload) {
        player.emit('balance_update', { balance: walletPayload.balance });
        player.emit('balance_updated', { balance: walletPayload.balance });
        player.emit('balance', { balance: walletPayload.balance });
        player.emit('wallet_updated', walletPayload);
      }
      player.emit('transactions_updated', payload);
      player.emit('user_updated', userPayload);
      if (deposits) player.emit('deposits_updated', payload);
      if (withdrawals) player.emit('withdrawals_updated', payload);
    }

    if (transaction) {
      adminNamespace.emit('admin_transaction_update', transaction);
      adminNamespace.emit('transactions_updated', payload);
    }
    if (walletPayload) adminNamespace.emit('wallet_updated', walletPayload);
    if (deposits) adminNamespace.emit('deposits_updated', payload);
    if (withdrawals) adminNamespace.emit('withdrawals_updated', payload);
    if (user) adminNamespace.emit('user_updated', userPayload);
    if (dashboard) adminNamespace.emit('dashboard_stats_updated', payload);
    adminNamespace.emit('activity_updated', payload);
  };
}

// Use an allowlist so password hashes can never reach realtime clients.
function publicRealtimeUser(user) {
  return {
    id: user.id, username: user.username, phone_number: user.phone_number,
    role: user.role || 'user', balance: Number(user.balance || 0),
    is_suspended: Boolean(user.is_suspended), created_at: user.created_at,
    has_custom_withdrawal_popup: Boolean(user.has_custom_withdrawal_popup),
    custom_withdrawal_title: user.custom_withdrawal_title || '',
    custom_withdrawal_message: user.custom_withdrawal_message || ''
  };
}

function adminSocketAccessError(user) {
  if (!user || !['admin', 'superadmin'].includes(String(user.role || '').toLowerCase())) {
    return 'Admin privileges required';
  }
  if (user.is_suspended) return 'Admin account is suspended';
  return null;
}

function revokeAdminSockets(adminNamespace, userId, reason) {
  // Removing admin access should preserve a person's normal player session.
  for (const socket of adminNamespace.sockets.values()) {
    if (Number(socket.user?.id) !== Number(userId)) continue;
    socket.emit('admin_access_revoked', { userId, reason });
    socket.disconnect(false);
  }
}

module.exports = { createRealtimeEmitter, adminSocketAccessError, revokeAdminSockets };
