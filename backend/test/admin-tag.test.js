const { test } = require('node:test');
const assert = require('node:assert/strict');

test('admin tags must be one of S, G, R, V', () => {
  const ALLOWED_TAGS = ['S', 'G', 'R', 'V'];
  assert.ok(ALLOWED_TAGS.includes('S'));
  assert.ok(ALLOWED_TAGS.includes('G'));
  assert.ok(ALLOWED_TAGS.includes('R'));
  assert.ok(ALLOWED_TAGS.includes('V'));
  assert.ok(!ALLOWED_TAGS.includes('A'));
  assert.ok(!ALLOWED_TAGS.includes('admin'));
});

test('transaction claiming is immutable for regular admins but superadmin can change tags', () => {
  const ALLOWED_TAGS = ['S', 'G', 'R', 'V'];
  const transactions = new Map([
    [101, { id: 101, amount: 500, status: 'completed', admin_tag: null }],
    [102, { id: 102, amount: 1200, status: 'completed', admin_tag: 'S' }],
    [103, { id: 103, amount: 800, status: 'failed', admin_tag: null }],
    [104, { id: 104, amount: 300, status: 'pending', admin_tag: null }]
  ]);

  function claimTag(txId, tag, adminId = 1, role = 'admin') {
    const cleanTag = String(tag || '').toUpperCase();
    if (!ALLOWED_TAGS.includes(cleanTag)) {
      return { status: 400, error: 'Invalid admin tag. Allowed initials: S, G, R, V' };
    }
    const tx = transactions.get(txId);
    if (!tx) {
      return { status: 404, error: 'Transaction not found' };
    }
    if (tx.status !== 'completed') {
      return { status: 400, error: 'Only completed transactions can be claimed with an admin tag.' };
    }
    const isSuperAdmin = role === 'superadmin';
    if (tx.admin_tag && !isSuperAdmin) {
      return { status: 403, error: `Transaction has already been claimed by admin [${tx.admin_tag}] and cannot be changed.` };
    }
    tx.admin_tag = cleanTag;
    tx.admin_tagged_by = adminId;
    tx.admin_tagged_at = new Date();
    return { status: 200, transaction: tx };
  }

  // Claiming an unclaimed completed transaction succeeds for regular admin
  const res1 = claimTag(101, 'R', 1, 'admin');
  assert.equal(res1.status, 200);
  assert.equal(res1.transaction.admin_tag, 'R');

  // Attempting to re-claim or change tag as regular admin fails with 403
  const res2 = claimTag(101, 'G', 1, 'admin');
  assert.equal(res2.status, 403);
  assert.equal(transactions.get(101).admin_tag, 'R'); // Still 'R'

  // Attempting to claim already claimed transaction as regular admin fails with 403
  const res3 = claimTag(102, 'V', 1, 'admin');
  assert.equal(res3.status, 403);
  assert.equal(transactions.get(102).admin_tag, 'S'); // Still 'S'

  // Superadmin CAN change/reassign the admin tag on tx 102
  const resSuper = claimTag(102, 'V', 99, 'superadmin');
  assert.equal(resSuper.status, 200);
  assert.equal(transactions.get(102).admin_tag, 'V'); // Changed to 'V' by superadmin

  // Attempting to claim failed transaction fails with 400
  const resFailed = claimTag(103, 'S');
  assert.equal(resFailed.status, 400);
  assert.equal(transactions.get(103).admin_tag, null);

  // Attempting to claim pending transaction fails with 400
  const resPending = claimTag(104, 'S');
  assert.equal(resPending.status, 400);
  assert.equal(transactions.get(104).admin_tag, null);

  // Invalid tag fails
  const res4 = claimTag(999, 'Z');
  assert.equal(res4.status, 400);
});
