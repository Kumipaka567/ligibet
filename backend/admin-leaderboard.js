'use strict';

const RSVG_ADMINS_METADATA = [
  { tag: 'R', name: 'Admin R', role: 'Operations', badgeColor: '#ef4444' },
  { tag: 'S', name: 'Admin S', role: 'Settlements', badgeColor: '#0ea5e9' },
  { tag: 'V', name: 'Admin V', role: 'Verification', badgeColor: '#a855f7' },
  { tag: 'G', name: 'Admin G', role: 'Growth', badgeColor: '#10b981' }
];

const LEADERBOARD_START_DATE = '2026-11-07';

function createAdminLeaderboard(models = {}, options = {}) {
  const { Transaction } = models;
  const nowFn = options.now || (() => new Date());

  /**
   * Formats a Date object to YYYY-MM-DD in local time
   */
  function formatDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Parse date or default to today (clamping to >= 2026-11-07)
   */
  function resolveTargetDate(inputDate) {
    let dateStr = String(inputDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      dateStr = formatDateKey(nowFn());
    }
    // Beginning with today 7th November: clamp to 2026-11-07 if before
    if (dateStr < LEADERBOARD_START_DATE) {
      dateStr = LEADERBOARD_START_DATE;
    }
    return dateStr;
  }

  /**
   * Calculates the daily leadership board for RSVG admins on the given date
   */
  async function getDailyLeaderboard(targetDateStr) {
    const dateStr = resolveTargetDate(targetDateStr);
    const [y, m, d] = dateStr.split('-').map(Number);
    const startOfDay = new Date(y, m - 1, d, 0, 0, 0, 0);
    const endOfDay = new Date(y, m - 1, d, 23, 59, 59, 999);

    let txs = [];
    if (Transaction) {
      txs = await Transaction.find({
        status: 'completed',
        admin_tag: { $in: ['R', 'S', 'V', 'G'] },
        $or: [
          { admin_tagged_at: { $gte: startOfDay, $lte: endOfDay } },
          { admin_tagged_at: null, created_at: { $gte: startOfDay, $lte: endOfDay } }
        ]
      }).select('id amount admin_tag admin_tagged_at created_at').lean();
    }

    const totalDayClaims = txs.length;
    const totalDayVolume = txs.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const overallAvgTicket = totalDayClaims > 0 ? Math.round(totalDayVolume / totalDayClaims) : 0;

    // Process each of the RSVG admins
    const entries = RSVG_ADMINS_METADATA.map(admin => {
      const adminTxs = txs.filter(t => t.admin_tag === admin.tag);
      const claimedCount = adminTxs.length;
      const totalVolume = adminTxs.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const avgTicket = claimedCount > 0 ? Math.round(totalVolume / claimedCount) : 0;
      const maxTicket = adminTxs.length > 0 ? Math.max(...adminTxs.map(t => Number(t.amount) || 0)) : 0;
      const minTicket = adminTxs.length > 0 ? Math.min(...adminTxs.map(t => Number(t.amount) || 0)) : 0;

      // Calculate timestamps to find latest claim
      const timestamps = adminTxs
        .map(t => t.admin_tagged_at || t.created_at)
        .filter(Boolean)
        .map(ts => new Date(ts).getTime())
        .sort((a, b) => b - a);
      const lastClaimedAt = timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null;

      // Performance score per transaction claimed:
      // Base: 100 points per claimed completed transaction
      // Volume: 1 point for every 20 KES claimed (totalVolume * 0.05)
      const basePoints = claimedCount * 100;
      const volumePoints = Math.round(totalVolume * 0.05);
      const score = basePoints + volumePoints;

      const sharePercent = totalDayClaims > 0 ? Number(((claimedCount / totalDayClaims) * 100).toFixed(1)) : 0;
      const volumeSharePercent = totalDayVolume > 0 ? Number(((totalVolume / totalDayVolume) * 100).toFixed(1)) : 0;

      return {
        tag: admin.tag,
        name: admin.name,
        role: admin.role,
        badgeColor: admin.badgeColor,
        claimedCount,
        totalVolume,
        avgTicket,
        maxTicket,
        minTicket,
        sharePercent,
        volumeSharePercent,
        score,
        basePoints,
        volumePoints,
        lastClaimedAt
      };
    });

    // Sort entries in terms of total amount of money claimed within the day (descending):
    // 1. By totalVolume descending
    // 2. By claimedCount descending
    // 3. By tag alphabetically
    entries.sort((a, b) => {
      if (b.totalVolume !== a.totalVolume) return b.totalVolume - a.totalVolume;
      if (b.claimedCount !== a.claimedCount) return b.claimedCount - a.claimedCount;
      return a.tag.localeCompare(b.tag);
    });

    const ranked = entries.map((item, index) => ({
      ...item,
      rank: index + 1
    }));

    const leadingAdmin = ranked[0]?.claimedCount > 0 ? ranked[0].tag : null;

    return {
      success: true,
      date: dateStr,
      startDate: LEADERBOARD_START_DATE,
      serverTime: nowFn().toISOString(),
      totalDayClaims,
      totalDayVolume,
      overallAvgTicket,
      leadingAdmin,
      scoringFormula: 'Score = (Completed Claims × 100) + (Volume in KES × 0.05)',
      leaderboard: ranked
    };
  }

  return {
    getDailyLeaderboard,
    resolveTargetDate,
    LEADERBOARD_START_DATE,
    RSVG_ADMINS_METADATA
  };
}

module.exports = {
  createAdminLeaderboard,
  RSVG_ADMINS_METADATA,
  LEADERBOARD_START_DATE
};
