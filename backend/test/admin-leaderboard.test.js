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

test('admin leaderboard clamps dates earlier than 2026-11-07 to 2026-11-07', async () => {
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
  assert.deepEqual(queriedFilter.admin_tag, { $in: ['R', 'S', 'V', 'G'] });
  assert.equal(queriedFilter.status, 'completed');
});

test('admin leaderboard calculates scores, volume, avg ticket and ranks admins correctly', async () => {
  const mockTransactions = [
    // Admin R: 2 claims, 5,000 + 3,000 = 8,000 KES.
    // Score = (2 * 100) + (8000 * 0.05) = 200 + 400 = 600 pts
    { id: 101, amount: 5000, admin_tag: 'R', admin_tagged_at: new Date('2026-11-07T08:30:00Z'), created_at: new Date('2026-11-07T08:00:00Z') },
    { id: 102, amount: 3000, admin_tag: 'R', admin_tagged_at: new Date('2026-11-07T11:45:00Z'), created_at: new Date('2026-11-07T11:00:00Z') },

    // Admin S: 3 claims, 2,000 + 1,000 + 1,000 = 4,000 KES.
    // Score = (3 * 100) + (4000 * 0.05) = 300 + 200 = 500 pts
    { id: 103, amount: 2000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T09:10:00Z'), created_at: new Date('2026-11-07T09:00:00Z') },
    { id: 104, amount: 1000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T10:20:00Z'), created_at: new Date('2026-11-07T10:00:00Z') },
    { id: 105, amount: 1000, admin_tag: 'S', admin_tagged_at: new Date('2026-11-07T14:15:00Z'), created_at: new Date('2026-11-07T14:00:00Z') },

    // Admin V: 1 claim, 20,000 KES.
    // Score = (1 * 100) + (20000 * 0.05) = 100 + 1000 = 1100 pts
    { id: 106, amount: 20000, admin_tag: 'V', admin_tagged_at: null, created_at: new Date('2026-11-07T16:00:00Z') },

    // Admin G: 0 claims. Score = 0 pts
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
  assert.equal(result.leadingAdmin, 'V'); // V has highest score 1100

  const [rank1, rank2, rank3, rank4] = result.leaderboard;

  // Rank 1: Admin V (Score 1100)
  assert.equal(rank1.tag, 'V');
  assert.equal(rank1.rank, 1);
  assert.equal(rank1.claimedCount, 1);
  assert.equal(rank1.totalVolume, 20000);
  assert.equal(rank1.avgTicket, 20000);
  assert.equal(rank1.score, 1100);
  assert.equal(rank1.basePoints, 100);
  assert.equal(rank1.volumePoints, 1000);

  // Rank 2: Admin R (Score 600)
  assert.equal(rank2.tag, 'R');
  assert.equal(rank2.rank, 2);
  assert.equal(rank2.claimedCount, 2);
  assert.equal(rank2.totalVolume, 8000);
  assert.equal(rank2.avgTicket, 4000);
  assert.equal(rank2.score, 600);

  // Rank 3: Admin S (Score 500)
  assert.equal(rank3.tag, 'S');
  assert.equal(rank3.rank, 3);
  assert.equal(rank3.claimedCount, 3);
  assert.equal(rank3.totalVolume, 4000);
  assert.equal(rank3.avgTicket, Math.round(4000 / 3)); // 1333
  assert.equal(rank3.score, 500);

  // Rank 4: Admin G (Score 0)
  assert.equal(rank4.tag, 'G');
  assert.equal(rank4.rank, 4);
  assert.equal(rank4.claimedCount, 0);
  assert.equal(rank4.totalVolume, 0);
  assert.equal(rank4.score, 0);
});
