const mongoose = require('mongoose');
const { adminTicketScope } = require('./admin-privacy');

function selection(value, valid, maximum = 100) {
  if (!Array.isArray(value) || !value.length || value.length > maximum || !value.every(valid)) return null;
  return [...new Set(value)];
}

function createSupportDeletion({ SupportTicket, AdminLog }, adminNamespace) {
  const audit = (adminId, action, details) => AdminLog.create({ admin_id: adminId, action, details, target_user_id: null }).catch(() => {});
  return {
    async conversations(req, res) {
      if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin privileges required.' });
      const ids = selection(req.body?.ticket_ids, id => Number.isSafeInteger(id) && id > 0);
      if (!ids) return res.status(400).json({ error: 'Mark between 1 and 100 conversations.' });
      try {
        const filter = { id: { $in: ids }, ...adminTicketScope(req) };
        const tickets = await SupportTicket.find(filter).select('id').lean();
        if (tickets.length !== ids.length) return res.status(404).json({ error: 'A marked conversation is unavailable. Refresh and try again.' });
        await SupportTicket.deleteMany(filter);
        await audit(req.user.id, 'DELETE_SUPPORT_CONVERSATIONS', `Deleted support conversations: ${ids.join(', ')}.`);
        adminNamespace.emit('support_tickets_deleted', { ticketIds: ids });
        adminNamespace.emit('activity_updated', { action: 'support_conversations_deleted', userId: null, occurredAt: new Date().toISOString() });
        return res.json({ deletedIds: ids });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to delete marked conversations. Refresh and try again.' });
      }
    },
    async messages(req, res) {
      if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin privileges required.' });
      const ticketId = Number(req.params.id);
      const ids = selection(req.body?.message_ids, id => typeof id === 'string' && /^[a-f\d]{24}$/.test(id), 1000);
      if (!Number.isSafeInteger(ticketId) || ticketId <= 0 || !ids) return res.status(400).json({ error: 'Mark between 1 and 1000 messages in a valid conversation.' });
      try {
        const objectIds = ids.map(id => new mongoose.Types.ObjectId(id));
        const ticket = await SupportTicket.findOneAndUpdate({ id: ticketId, ...adminTicketScope(req), 'messages._id': { $all: objectIds } },
          { $pull: { messages: { _id: { $in: objectIds } } }, $set: { updated_at: new Date() } }, { new: true }).lean();
        if (!ticket) return res.status(404).json({ error: 'A marked message is unavailable. Refresh and try again.' });
        await audit(req.user.id, 'DELETE_SUPPORT_MESSAGES', `Deleted ${ids.length} marked messages from support conversation #${ticketId}.`);
        adminNamespace.emit('support_ticket_update', { ticket, deletedMessageIds: ids });
        adminNamespace.emit('activity_updated', { action: 'support_messages_deleted', userId: null, occurredAt: new Date().toISOString() });
        return res.json({ ticket, deletedMessageIds: ids });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to delete marked messages. Refresh and try again.' });
      }
    }
  };
}
module.exports = { createSupportDeletion };
