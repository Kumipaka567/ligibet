const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminLeaderboard } = require('../admin-leaderboard');

test('admin leaderboard returns all 4 RSVG admins with zero claims when no transactions exist', async () => {
  const models = {
    Transaction: {
      find: () => ({
        select: () => ({
          lean: async () => []
        })
      })
    }
  };

  const fixedNow = new Date('2026-11-07T12:00:00Z');
  const service = createAdminLeaderboard(models, { now: () => fixedNow });
  const result = await service.getDailyLeaderboard('2026-11-07');

  assert.equal(result.success, true);
  assert.equal(result.date, '2026-11-07');
  assert.equal(result.startDate, '2026-11-07');
  assert.equal(result.totalDayClaims, 0);
  assert.equal(result.totalDayVolume, 0);
  assert.equal(result.overallAvgTicket, 0);
  assert.equal(result.leadingAdmin, null);
  assert.equal(result.leaderboard.length, 4);

  const tags = result.leaderboard.map(a => a.tag).sort();
  assert.deepEqual(tags, ['G', 'R', 'S', 'V']);
  for (const admin of result.leaderboard) {
    assert.equal(admin.claimedCount, 0);
    assert.equal(admin.totalVolume, 0);
    assert.equal(admin.score, 0);
    assert.equal(admin.basePoints, 0);
    assert.equal(admin.volumePoints, 0);
    assert.equal(admin.avgTicket, 0);
    assert.ok(admin.rank >= 1 && admin.rank <= 4);
  }
});

test('admin leaderboard clamps dates earlier than 2026-11-07 to 2026-11-07 and queries only completed deposits', async () => {
  let queriedFilter = null;
  const models = {
    Transaction: {
      find: (filter) => {
        queriedFilter = filter;
        return {
          select: () => ({
            lean: async () => []
          })
        };
      }
    }
  };

  const service = createAdminLeaderboard(models);
  const result = await service.getDailyLeaderboard('2026-10-15');

  assert.equal(result.date, '2026-11-07');
  assert.ok(queriedFilter);
  assert.equal(queriedFilter.type, 'deposit');
  assert.equal(queriedFilter.status, 'completed');
  assert.deepEqual(queriedFilter.admin_tag, { $in: ['R', 'S', 'V', 'G'] });
});

test('admin leaderboard calculates scores, volume, avg ticket and ranks admins correctly for daily deposits', async () => {
  const mockTransactions = [
    // Admin R: 2 deposits, 5,000 + 3,000 = 8,000 KES.
    { id: 101, type: 'deposit', status: 'completed', amount: 5000, admin_tag: 'R', admin_tagged_at: new Date('2026-11-07T08:30:00Z'), created_at: new Date('2026-11-07T08:00:00Z') },
    { id: 102, type: 'deposit', status: 'completed', amount: 3000, admin_tag: 'R', admin_tagged_at: new Date('2026-11-07T11:45:00Z'), created_at: new Date('2026-11-07T11:00:00Z') },

    // Admin S: 3 deposits, 2,000 + 1,000 + 1,000 = 4,000 KES.
    { id: 103, type: 'deposit', status: 'completed', amount: 2000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T09:10:00Z'), created_at: new Date('2026-11-07T09:00:00Z') },
    { id: 104, type: 'deposit', status: 'completed', amount: 1000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T10:20:00Z'), created_at: new Date('2026-11-07T10:00:00Z') },
    { id: 105, type: 'deposit', status: 'completed', amount: 1000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T14:15:00Z'), created_at: new Date('2026-11-07T14:00:00Z') },

    // Admin V: 1 deposit, 20,000 KES.
    { id: 106, type: 'deposit', status: 'completed', amount: 20000, admin_tag: 'V', admin_tagged_at: null, created_at: new Date('2026-11-07T16:00:00Z') }
  ];

  const models = {
    Transaction: {
      find: () => ({
        select: () => ({
          lean: async () => mockTransactions
        })
      })
    }
  };

  const service = createAdminLeaderboard(models);
  const result = await service.getDailyLeaderboard('2026-11-07');

  assert.equal(result.totalDayClaims, 6);
  assert.equal(result.totalDayVolume, 32000);
  assert.equal(result.overallAvgTicket, Math.round(32000 / 6)); // 5333
  assert.equal(result.leadingAdmin, 'V');

  const [rank1, rank2, rank3, rank4] = result.leaderboard;

  assert.equal(rank1.tag, 'V');
  assert.equal(rank1.rank, 1);
  assert.equal(rank1.claimedCount, 1);
  assert.equal(rank1.totalVolume, 20000);

  assert.equal(rank2.tag, 'R');
  assert.equal(rank2.rank, 2);
  assert.equal(rank2.claimedCount, 2);
  assert.equal(rank2.totalVolume, 8000);

  assert.equal(rank3.tag, 'S');
  assert.equal(rank3.rank, 3);
  assert.equal(rank3.claimedCount, 3);
  assert.equal(rank3.totalVolume, 4000);

  assert.equal(rank4.tag, 'G');
  assert.equal(rank4.rank, 4);
  assert.equal(rank4.claimedCount, 0);
  assert.equal(rank4.totalVolume, 0);
});

test('admin leaderboard excludes bets, payouts, withdrawals, adjustments, and historical dates from daily claims', async () => {
  const mockTransactions = [
    // Non-deposit transactions on Nov 7th that have admin_tag (MUST BE EXCLUDED)
    { id: 90, type: 'bet_placed', status: 'completed', amount: 50000, admin_tag: 'R', created_at: new Date('2026-11-07T08:00:00Z') },
    { id: 91, type: 'bet_payout', status: 'completed', amount: 84852, admin_tag: 'R', created_at: new Date('2026-11-07T08:05:00Z') },
    { id: 92, type: 'admin_adjustment', status: 'completed', amount: 100000, admin_tag: 'R', created_at: new Date('2026-11-07T08:10:00Z') },
    { id: 93, type: 'withdrawal', status: 'completed', amount: 10000, admin_tag: 'R', created_at: new Date('2026-11-07T08:15:00Z') },
    // Historical deposit from earlier date (MUST BE EXCLUDED)
    { id: 99, type: 'deposit', status: 'completed', amount: 100000, admin_tag: 'R', admin_tagged_at: new Date('2026-11-07T08:00:00Z'), created_at: new Date('2026-11-01T10:00:00Z') },
    // Real completed deposits on Nov 7th
    { id: 100, type: 'deposit', status: 'completed', amount: 500, admin_tag: 'R', admin_tagged_at: new Date('2026-11-07T09:00:00Z'), created_at: new Date('2026-11-07T09:00:00Z') },
    { id: 101, type: 'deposit', status: 'completed', amount: 1000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T10:00:00Z'), created_at: new Date('2026-11-07T10:00:00Z') }
  ];

  const models = {
    Transaction: {
      find: () => ({
        select: () => ({
          lean: async () => mockTransactions
        })
      })
    }
  };

  const service = createAdminLeaderboard(models);
  const result = await service.getDailyLeaderboard('2026-11-07');

  assert.equal(result.totalDayClaims, 2);
  assert.equal(result.totalDayVolume, 1500);

  const adminR = result.leaderboard.find(a => a.tag === 'R');
  assert.equal(adminR.claimedCount, 1);
  assert.equal(adminR.totalVolume, 500);

  const adminS = result.leaderboard.find(a => a.tag === 'S');
  assert.equal(adminS.claimedCount, 1);
  assert.equal(adminS.totalVolume, 1000);
  assert.equal(adminS.rank, 1);
  assert.equal(adminR.rank, 2);
});
