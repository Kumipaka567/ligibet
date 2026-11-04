function createDashboardStats({ User, Bet, Deposit, Withdrawal }, { now = Date.now, ttlMs = 1000 } = {}) {
  let inFlight = null, value = null, expiresAt = 0;
  const money = amount => Math.round(Number(amount || 0) * 100) / 100;
  return function totals() {
    if (value && now() < expiresAt) return Promise.resolve(value);
    if (!inFlight) {
      inFlight = Promise.all([
        User.countDocuments(),
        Bet.aggregate([{ $group: { _id: null, totalBets: { $sum: 1 }, totalVolume: { $sum: '$bet_amount' }, totalPayout: { $sum: '$payout_amount' } } }]),
        Deposit.aggregate([{ $match: { status: 'completed', provider: { $in: ['payhero', 'nexuspay'] } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Withdrawal.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
      ]).then(([totalUsers, bets, deposits, withdrawals]) => {
        value = { totalUsers, totalBets: bets[0]?.totalBets || 0,
          totalVolume: money(bets[0]?.totalVolume), totalPayout: money(bets[0]?.totalPayout),
          totalDeposits: money(deposits[0]?.total), totalWithdrawals: money(withdrawals[0]?.total) };
        expiresAt = now() + ttlMs;
        return value;
      }).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
module.exports = { createDashboardStats };
