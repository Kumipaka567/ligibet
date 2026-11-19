const { adminClientScope } = require('./admin-privacy');

// Retain the accounting record for totals, ownership and payment idempotency.
function createDeleteAdminTransaction({ Transaction, AdminLog }, adminNamespace) {
  return async (req, res) => {
    if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin privileges required' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid transaction ID.' });
    try {
      const tx = await Transaction.findOneAndUpdate({ id, status: 'completed',
        type: { $in: ['deposit', 'withdrawal'] }, admin_deleted_at: null, ...adminClientScope(req, 'user_id') },
      { $set: { admin_deleted_at: new Date(), admin_deleted_by: req.user.id } }, { new: true }).lean();
      if (!tx) return res.status(409).json({ error: 'Only an available completed transaction can be deleted.' });
      await AdminLog.create({ admin_id: req.user.id, action: 'DELETE_COMPLETED_TRANSACTION', target_user_id: tx.user_id,
        details: `Deleted ${tx.type} transaction #${tx.id} from the admin list. Balance and deposit totals preserved.` }).catch(() => {});
      adminNamespace.emit('transactions_updated', { action: 'transaction_deleted', transactionId: tx.id,
        userId: null, occurredAt: new Date().toISOString() });
      adminNamespace.emit('activity_updated', { action: 'transaction_deleted', userId: null, occurredAt: new Date().toISOString() });
      return res.json({ message: 'Transaction deleted. Balance and deposit totals are unchanged.', transactionId: tx.id });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to delete transaction. Refresh the list and try again.' });
    }
  };
}
module.exports = { createDeleteAdminTransaction };
