'use strict';

const RSVG_ADMINS_METADATA = [
  { tag: 'R', name: 'Admin R', role: 'Operations', badgeColor: '#ef4444' },
  { tag: 'S', name: 'Admin S', role: 'Settlements', badgeColor: '#0ea5e9' },
  { tag: 'V', name: 'Admin V', role: 'Verification', badgeColor: '#a855f7' },
  { tag: 'G', name: 'Admin G', role: 'Growth', badgeColor: '#10b981' }
];

const LEADERBOARD_START_DATE = '2026-11-07';

function createAdminLeaderboard(models = {}, options = {}) {
  const { Transaction, User } = models;
  const nowFn = options.now || (() => new Date());

  /**
   * Formats a Date object to YYYY-MM-DD in East Africa Time (UTC+3)
   */
  function getEatDateKey(date = nowFn()) {
    const eatDate = new Date(date.getTime() + (3 * 60 + date.getTimezoneOffset()) * 60000);
    const y = eatDate.getFullYear();
    const m = String(eatDate.getMonth() + 1).padStart(2, '0');
    const d = String(eatDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Parse date or default to today in EAT (clamping to >= 2026-11-07)
   */
  function resolveTargetDate(inputDate) {
    let dateStr = String(inputDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      dateStr = getEatDateKey(nowFn());
    }
    // Beginning with today 7th November: clamp to 2026-11-07 if before
    if (dateStr < LEADERBOARD_START_DATE) {
      dateStr = LEADERBOARD_START_DATE;
    }
    return dateStr;
  }

  /**
   * Calculates the daily leadership board for RSVG admins on the given date (24h window),
   * strictly for completed deposits (type === 'deposit', status === 'completed')
   * created within that 24-hour day, refreshing at 12:00 AM midnight EAT.
   */
  async function getDailyLeaderboard(targetDateStr) {
    const dateStr = resolveTargetDate(targetDateStr);

    // 24-hour day window in East Africa Time (UTC+3, no DST)
    // 12:00 AM (00:00:00.000) to 11:59:59 PM (23:59:59.999)
    const startOfDay = new Date(`${dateStr}T00:00:00.000+03:00`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999+03:00`);

    let staffUserIds = new Set();
    if (User && typeof User.find === 'function') {
      try {
        const staffUsers = await User.find({ role: { $in: ['admin', 'superadmin'] } }).select('id').lean();
        if (Array.isArray(staffUsers)) {
          staffUserIds = new Set(staffUsers.map(u => Number(u.id)));
        }
      } catch (_e) {
        // Ignore if User mock is not provided in unit tests
      }
    }

    let queriedTxs = [];
    if (Transaction) {
      queriedTxs = await Transaction.find({
        type: 'deposit',
        status: 'completed',
        admin_tag: { $in: ['R', 'S', 'V', 'G'] },
        created_at: { $gte: startOfDay, $lte: endOfDay }
      }).select('id user_id type status amount admin_tag admin_tagged_at created_at').lean();
    }

    // Defensive filter: strictly completed deposits within the 24-hour window, excluding staff accounts
    const todayTxs = (queriedTxs || []).filter(t => {
      if (t.type && t.type !== 'deposit') return false;
      if (t.status && t.status !== 'completed') return false;
      if (t.user_id !== undefined && staffUserIds.has(Number(t.user_id))) return false;
      const cDate = t.created_at ? new Date(t.created_at) : null;
      return cDate && cDate >= startOfDay && cDate <= endOfDay;
    });

    const totalDayClaims = todayTxs.length;
    const totalDayVolume = todayTxs.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const overallAvgTicket = totalDayClaims > 0 ? Math.round(totalDayVolume / totalDayClaims) : 0;

    // Process each of the RSVG admins for today's 24h claims
    const entries = RSVG_ADMINS_METADATA.map(admin => {
      const adminTodayTxs = todayTxs.filter(t => t.admin_tag === admin.tag);
      const claimedCount = adminTodayTxs.length;
      const totalVolume = adminTodayTxs.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const avgTicket = claimedCount > 0 ? Math.round(totalVolume / claimedCount) : 0;
      const maxTicket = adminTodayTxs.length > 0 ? Math.max(...adminTodayTxs.map(t => Number(t.amount) || 0)) : 0;
      const minTicket = adminTodayTxs.length > 0 ? Math.min(...adminTodayTxs.map(t => Number(t.amount) || 0)) : 0;

      // Latest claim timestamp today
      const timestamps = adminTodayTxs
        .map(t => t.admin_tagged_at || t.created_at)
        .filter(Boolean)
        .map(ts => new Date(ts).getTime())
        .sort((a, b) => b - a);
      const lastClaimedAt = timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null;

      // Performance score per transaction claimed:
      // Base: 100 points per claimed completed deposit
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

    // Sort entries strictly by daily claimed money (totalVolume descending), then claimedCount descending, then tag
    entries.sort((a, b) => {
      if (b.totalVolume !== a.totalVolume) return b.totalVolume - a.totalVolume;
      if (b.claimedCount !== a.claimedCount) return b.claimedCount - a.claimedCount;
      return a.tag.localeCompare(b.tag);
    });

    entries.forEach((item, index) => {
      item.rank = index + 1;
    });

    const leadingAdmin = entries[0]?.claimedCount > 0 ? entries[0].tag : null;

    return {
      success: true,
      date: dateStr,
      startDate: LEADERBOARD_START_DATE,
      serverTime: nowFn().toISOString(),
      totalDayClaims,
      totalDayVolume,
      overallAvgTicket,
      leadingAdmin,
      scoringFormula: 'Score = (Completed Deposit Claims × 100) + (Volume in KES × 0.05)',
      leaderboard: entries
    };
  }

  return {
    getDailyLeaderboard,
    resolveTargetDate,
    getEatDateKey,
    LEADERBOARD_START_DATE,
    RSVG_ADMINS_METADATA
  };
}

module.exports = {
  createAdminLeaderboard,
  RSVG_ADMINS_METADATA,
  LEADERBOARD_START_DATE
};
