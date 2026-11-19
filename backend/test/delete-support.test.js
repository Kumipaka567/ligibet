const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSupportDeletion } = require('../delete-support');
const first = '000000000000000000000001', second = '000000000000000000000002', third = '000000000000000000000003';

function fixture() {
  const tickets = [
    { id: 11, phone_number: '0712345678', messages: [{ _id: first, text: 'First' }, { _id: second, text: 'Keep' }, { _id: third, text: 'New arrival' }] },
    { id: 12, phone_number: '0799887766', messages: [{ _id: first, text: 'Other conversation' }] },
    { id: 13, phone_number: '0711112222', messages: [] }
  ];
  const events = [], logs = [];
  const matches = (ticket, filter) => (filter.id?.$in ? filter.id.$in.includes(ticket.id) : filter.id === ticket.id)
    && (!filter.phone_number?.$not || !filter.phone_number.$not.test(ticket.phone_number));
  const model = {
    find: filter => ({ select() { return this; }, lean: async () => tickets.filter(ticket => matches(ticket, filter)).map(ticket => ({ id: ticket.id })) }),
    deleteMany: async filter => {
      for (let index = tickets.length - 1; index >= 0; index--) if (matches(tickets[index], filter)) tickets.splice(index, 1);
    },
    findOneAndUpdate: (filter, update, options) => ({ lean: async () => {
      assert.equal(options.new, true);
      const ticket = tickets.find(row => matches(row, filter));
      const required = filter['messages._id'].$all.map(String);
      if (!ticket || !required.every(id => ticket.messages.some(message => message._id === id))) return null;
      const removed = update.$pull.messages._id.$in.map(String);
      ticket.messages = ticket.messages.filter(message => !removed.includes(message._id));
      ticket.updated_at = update.$set.updated_at;
      return structuredClone(ticket);
    } })
  };
  const handlers = createSupportDeletion({ SupportTicket: model, AdminLog: { create: async log => logs.push(log) } },
    { emit: (event, data) => events.push({ event, data }) });
  async function call(which, body, { role = 'superadmin', id = '11', blockedClients = [] } = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers[which]({ user: { id: 1, role }, params: { id }, body, blockedClients }, res);
    return res;
  }
  return { tickets, events, logs, call };
}

test('bulk Support deletion removes exactly the marked conversations and broadcasts their IDs', async () => {
  const f = fixture();
  const result = await f.call('conversations', { ticket_ids: [11, 13, 11] });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(f.tickets.map(ticket => ticket.id), [12]);
  assert.deepEqual(result.body.deletedIds, [11, 13]);
  assert.deepEqual(f.events[0], { event: 'support_tickets_deleted', data: { ticketIds: [11, 13] } });
  assert.equal(f.logs[0].action, 'DELETE_SUPPORT_CONVERSATIONS');
});

test('individual Support deletion preserves unmarked and newly arrived messages and all other conversations', async () => {
  const f = fixture();
  const result = await f.call('messages', { message_ids: [first] });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(f.tickets[0].messages.map(message => message._id), [second, third]);
  assert.equal(f.tickets[1].messages[0]._id, first);
  assert.deepEqual(result.body.deletedMessageIds, [first]);
  assert.equal(f.events[0].event, 'support_ticket_update');
  assert.equal(f.events[0].data.ticket.messages.length, 2);
});

test('both deletion operations require superadmin and reject invalid or unavailable selections before changing data', async () => {
  for (const operation of ['conversations', 'messages']) {
    const body = operation === 'messages' ? { message_ids: [first] } : { ticket_ids: [11] };
    for (const role of ['admin', 'user']) {
      const f = fixture();
      assert.equal((await f.call(operation, body, { role })).statusCode, 403);
      assert.equal(f.tickets.length, 3);
      assert.equal(f.tickets[0].messages.length, 3);
    }
  }
  const f = fixture();
  for (const ids of [[], ['11'], [0], [11, 99], Array(101).fill(11)]) {
    assert.ok([400, 404].includes((await f.call('conversations', { ticket_ids: ids })).statusCode));
  }
  for (const ids of [[], ['bad-id'], ['000000000000000000000099']]) {
    assert.ok([400, 404].includes((await f.call('messages', { message_ids: ids })).statusCode));
  }
  assert.equal(f.tickets.length, 3);
  assert.equal(f.tickets[0].messages.length, 3);
  assert.equal(f.events.length, 0);
});

test('PIN ownership scopes prevent deleting another owner’s messages or mixing their conversation into a bulk selection', async () => {
  const blockedClients = [{ id: 7, phone_number: '0712345678', username: 'player' }];
  const f = fixture();
  assert.equal((await f.call('messages', { message_ids: [first] }, { blockedClients })).statusCode, 404);
  assert.equal((await f.call('conversations', { ticket_ids: [11, 12] }, { blockedClients })).statusCode, 404);
  assert.equal(f.tickets.length, 3);
  assert.equal(f.events.length, 0);
});

test('both Support delete routes enforce the existing superadmin authentication middleware', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /app\.delete\('\/api\/admin\/support\/tickets', authenticateSuperAdminToken, supportDeletion\.conversations\)/);
  assert.match(source, /app\.delete\('\/api\/admin\/support\/tickets\/:id\/messages', authenticateSuperAdminToken, supportDeletion\.messages\)/);
});
