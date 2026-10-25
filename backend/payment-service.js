const crypto = require('crypto');
const { createPaymentGateways, phoneNumber, money, error, PROVIDERS } = require('./payment-gateways');

function createPaymentService({ models, env = process.env, gateways = createPaymentGateways({ env }),
  emitRealtimeMutation = () => {}, adminNamespace = { emit() {} }, getMinimumDeposit = () => 1,
  brand = 'LIGI', now = () => Date.now(), logger = console }) {
  const { Deposit, Transaction, User, PaymentGatewaySetting, PaymentReceipt, AdminLog } = models;
  const legacyProviders = ['payhero', 'daraja', null];
  const providerOf = deposit => deposit.provider === 'nexuspay' ? 'nexuspay'
    : legacyProviders.includes(deposit.provider ?? null) ? 'payhero' : null;
  let receiptReady;
  let reconciling = false;

  async function settings() {
    const setting = await PaymentGatewaySetting.findById('global_settings').lean();
    const activeGateway = setting?.active_gateway || 'payhero';
    if (!PROVIDERS.includes(activeGateway)) throw error('The payment gateway setting is invalid. Contact an administrator.', 503);
    return { activeGateway, gateways: gateways.available(), updatedAt: setting?.updated_at || null };
  }
  async function switchGateway(provider, adminId) {
    gateways.configuration(provider);
    await PaymentGatewaySetting.init();
    const session = await Deposit.startSession();
    let updated;
    try {
      await session.withTransaction(async () => {
        updated = await PaymentGatewaySetting.findByIdAndUpdate('global_settings', {
          $set: { active_gateway: provider, updated_by: adminId, updated_at: new Date(now()) }
        }, { upsert: true, new: true, runValidators: true, session });
        await AdminLog.create([{ admin_id: adminId, action: 'SWITCH_PAYMENT_GATEWAY', details: `Active deposit gateway set to ${provider}. Pending payments retain their provider.` }], { session });
      });
    } finally { await session.endSession(); }
    adminNamespace.emit('dashboard_stats_updated', { action: 'payment_gateway_changed', userId: null, occurredAt: new Date(now()).toISOString() });
    return { activeGateway: updated.active_gateway, gateways: gateways.available(), updatedAt: updated.updated_at };
  }
  function references(deposit) {
    return [...new Set([deposit.external_reference, deposit.mpesa_checkout_request_id].filter(Boolean))]
      .flatMap(reference => [{ reference }, { reference: `MPESA-${reference}` }]);
  }
  async function settle(id, result) {
    if (!receiptReady) receiptReady = PaymentReceipt.init().catch(cause => { receiptReady = null; throw cause; });
    await receiptReady;
    const session = await Deposit.startSession();
    let committed;
    try {
      await session.withTransaction(async () => {
        committed = null;
        const deposit = await Deposit.findOne({ id }).session(session);
        if (!deposit || deposit.status === 'completed') { committed = { deposit, changed: false }; return; }
        if (result.status === 'pending') { committed = { deposit, changed: false }; return; }
        const complete = result.status === 'completed';
        if (!complete && deposit.status === 'failed') { committed = { deposit, changed: false }; return; }
        const verified = gateways.verified(deposit, result);
        if (complete) {
          const depositKey = String(deposit._id || deposit.external_reference || id);
          const reused = await Deposit.findOne({ id: { $ne: id }, status: 'completed', mpesa_receipt_number: verified.receipt }).session(session);
          if (reused) throw error('This payment receipt is already credited.', 409);
          const recorded = await PaymentReceipt.findOne({ _id: `mpesa:${verified.receipt}` }).session(session);
          if (recorded) throw error('This payment receipt is already credited.', 409);
          await PaymentReceipt.create([{ _id: `mpesa:${verified.receipt}`, deposit_id: id,
            deposit_key: depositKey, provider: providerOf(deposit), created_at: new Date(now()) }], { session });
        }
        const update = { status: complete ? 'completed' : 'failed', provider_status: result.status,
          failure_reason: complete ? null : result.reason || 'Payment failed or was cancelled on the phone.',
          callback_payload: result.raw || null, updated_at: new Date(now()),
          ...(complete ? { mpesa_receipt_number: verified.receipt, credited_at: new Date(now()) } : {}) };
        const updated = await Deposit.findOneAndUpdate({ id, status: { $ne: 'completed' } }, { $set: update }, { session, new: true });
        if (!updated) throw error('Payment changed while confirming. Please check its status again.', 409);
        let user;
        if (complete) {
          user = await User.findOneAndUpdate({ id: deposit.user_id }, { $inc: { balance: Number(deposit.amount) } }, { session, new: true });
          if (!user) throw error('Payment account not found.', 404);
        }
        const alternatives = references(deposit);
        if (deposit.transaction_id) alternatives.unshift({ id: deposit.transaction_id });
        const transactionFields = {
          status: update.status, failure_reason: update.failure_reason,
          ...(complete ? { reference: `MPESA-${verified.receipt}`, mpesa_receipt_number: verified.receipt } : {})
        };
        let transaction = alternatives.length ? await Transaction.findOneAndUpdate({
          user_id: deposit.user_id, type: 'deposit', $or: alternatives
        }, { $set: transactionFields }, { session, new: true }) : null;
        if (!transaction) [transaction] = await Transaction.create([{
          user_id: deposit.user_id, client_phone: deposit.payer_phone || null, type: 'deposit', amount: deposit.amount,
          reference: deposit.external_reference || `DEP-${deposit.id}`, ...transactionFields
        }], { session });
        committed = { deposit: updated, user, transaction, changed: true };
      });
    } finally { await session.endSession(); }
    if (committed?.changed) emitRealtimeMutation({
      action: committed.deposit.status === 'completed' ? 'mpesa_deposit_completed' : 'mpesa_deposit_failed',
      userId: committed.deposit.user_id, ...(committed.user ? { balance: committed.user.balance, user: committed.user } : {}),
      transaction: committed.transaction, deposits: true
    });
    return committed?.deposit;
  }
  async function findDeposit(reference, userId, provider) {
    const filter = { $or: [{ external_reference: reference }, { mpesa_checkout_request_id: reference }] };
    if (userId !== undefined) filter.user_id = userId;
    if (provider === 'payhero') {
      filter.provider = { $in: legacyProviders };
      filter.$or.push({ provider_reference: reference });
    }
    if (provider === 'nexuspay') filter.provider = 'nexuspay';
    return Deposit.findOne(filter).lean();
  }
  async function refresh(deposit) {
    if (!deposit || deposit.status !== 'pending') return deposit;
    const provider = providerOf(deposit);
    if (!provider || (provider === 'nexuspay' && !deposit.mpesa_checkout_request_id)) return deposit;
    const leased = await Deposit.findOneAndUpdate({ id: deposit.id, status: 'pending',
      $or: [{ next_poll_at: null }, { next_poll_at: { $lte: new Date(now()) } }]
    }, { $set: { next_poll_at: new Date(now() + 4000) } }, { new: true });
    if (!leased) return Deposit.findOne({ id: deposit.id }).lean();
    try {
      const result = await gateways.check(provider, leased);
      return result.status === 'pending' ? leased : await settle(deposit.id, result);
    } catch (cause) {
      // A network error or unverifiable result is not evidence that the customer failed to pay.
      logger.warn('Payment confirmation unavailable; payment retained for reconciliation.');
      return Deposit.findOne({ id: deposit.id }).lean();
    }
  }
  async function initiate(user, amount, phone) {
    const value = money(amount);
    const minimum = getMinimumDeposit();
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > 1000000) throw error(`Deposit amount must be a whole number between KES ${minimum} and 1,000,000.`, 400, true);
    const payer = phoneNumber(phone);
    const { activeGateway } = await settings();
    gateways.configuration(activeGateway);
    const uncertain = await Deposit.findOne({ user_id: user.id, payer_phone: payer, amount: value,
      status: 'pending', initiation_status: { $in: ['submitting', 'unknown'] }, created_at: { $gte: new Date(now() - 15 * 60000) }
    }).lean();
    if (uncertain) throw error('An earlier request is still being confirmed. Check with support before retrying.', 409);
    const reference = `${brand}-DEP-${crypto.randomUUID()}`;
    const session = await Deposit.startSession();
    let deposit, transaction;
    try {
      await session.withTransaction(async () => {
        [deposit] = await Deposit.create([{ user_id: user.id, amount: value, payer_phone: payer, payment_method: 'M-Pesa STK Push',
          provider: activeGateway, status: 'pending', initiation_status: 'submitting', external_reference: reference }], { session });
        [transaction] = await Transaction.create([{ user_id: user.id, client_phone: payer, type: 'deposit', amount: value,
          status: 'pending', reference: `MPESA-${reference}` }], { session });
        deposit.transaction_id = transaction.id;
        deposit.account_reference = `${brand.slice(0, 4)}-${deposit.id}`;
        await deposit.save({ session });
      });
    } finally { await session.endSession(); }
    emitRealtimeMutation({ action: 'mpesa_deposit_pending', userId: user.id, transaction, user, deposits: true });
    adminNamespace.emit('admin_deposit_initiated', { userId: user.id, username: user.username, phone: payer, amount: value,
      depositId: deposit.id, transactionId: transaction.id, transaction, timestamp: new Date(now()).toISOString() });
    try {
      const accepted = await gateways.initiate(activeGateway, deposit, user.username || 'Customer');
      // Do not overwrite a concurrent callback that already completed this payment.
      await Deposit.updateOne({ id: deposit.id }, { $set: { mpesa_checkout_request_id: accepted.checkoutRequestId,
        provider_reference: accepted.providerReference, initiation_status: 'accepted', updated_at: new Date(now()) } });
      return { success: true, message: 'STK push sent. Enter your M-Pesa PIN on your phone.', checkoutRequestId: accepted.checkoutRequestId };
    } catch (cause) {
      await Deposit.updateOne({ id: deposit.id }, { $set: { initiation_status: cause.definitive ? 'rejected' : 'unknown' } });
      if (cause.definitive) await settle(deposit.id, { status: 'failed', reason: cause.message });
      throw cause;
    } finally {
      if (activeGateway === 'payhero') adminNamespace.emit('dashboard_stats_updated', { action: 'payhero_service_wallet_changed', userId: null, occurredAt: new Date(now()).toISOString() });
    }
  }
  async function reconcilePending() {
    if (reconciling) return;
    reconciling = true;
    try {
      const deposits = await Deposit.find({ status: 'pending', created_at: { $gte: new Date(now() - 24 * 3600000) },
        $or: [{ provider: { $in: legacyProviders } }, { provider: 'nexuspay', mpesa_checkout_request_id: { $type: 'string', $ne: '' } }]
      }).sort({ next_poll_at: 1, created_at: 1 }).limit(100).lean();
      for (let index = 0; index < deposits.length; index += 4) await Promise.allSettled(deposits.slice(index, index + 4).map(refresh));
    } catch { logger.warn('Pending payment reconciliation will retry.'); }
    finally { reconciling = false; }
  }
  async function callback(req) {
    const key = env.PAYHERO_CALLBACK_TOKEN;
    let authenticated = false;
    if (key) {
      const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || String(req.query?.token || '');
      const actual = Buffer.from(supplied), expected = Buffer.from(key);
      authenticated = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      if (!authenticated) throw error('Unauthorized callback.', 401);
    }
    const payload = req.body || {}, raw = payload.response || payload;
    const reference = raw.ExternalReference || raw.external_reference || raw.CheckoutRequestID || raw.checkout_request_id || raw.reference || raw.MerchantRequestID || payload.external_reference;
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 256) return;
    const deposit = await findDeposit(reference, undefined, 'payhero');
    if (!deposit || deposit.status === 'completed') return;
    // Without a callback secret, use the notification only as a hint to verify through PayHero's API.
    if (!authenticated) { await refresh(deposit); return; }
    const result = gateways.parsePayHero(deposit, raw);
    if (result.status !== 'pending') await settle(deposit.id, result);
  }
  function mount(app, { authenticateToken, authenticateAdminToken }) {
    const handle = action => async (req, res) => {
      try { return await action(req, res); }
      catch (cause) {
        return res.status(cause.status || 503).json({ error: cause.status ? cause.message : 'Payment service is temporarily unavailable. Please check again.' });
      }
    };
    app.get('/api/admin/payment-gateway', authenticateAdminToken, handle(async (req, res) => res.json(await settings())));
    app.put('/api/admin/payment-gateway', authenticateAdminToken, handle(async (req, res) => res.json(await switchGateway(req.body.gateway, req.user.id))));
    app.post(['/api/payhero/stkpush', '/api/payhero/stk-push', '/api/mpesa/stkpush', '/api/mpesa/stk-push',
      '/api/wallet/mpesa/stkpush', '/api/wallet/mpesa/stk-push'], authenticateToken, handle(async (req, res) => {
      // The saved server setting is authoritative; customer-supplied gateway/provider fields are ignored.
      return res.json(await initiate(req.user, req.body.amount, req.body.phone));
    }));
    app.post(['/api/payhero/stk-status', '/api/mpesa/stk-status'], authenticateToken, handle(async (req, res) => {
      const reference = req.body.checkoutRequestId;
      if (typeof reference !== 'string' || !reference.trim()) throw error('checkoutRequestId required.', 400);
      let deposit = await findDeposit(reference, req.user.id);
      if (!deposit) throw error('Deposit not found.', 404);
      deposit = await refresh(deposit);
      const user = deposit.status === 'completed' ? await User.findOne({ id: req.user.id }).select('balance').lean() : null;
      return res.json({ status: deposit.status, receiptNumber: deposit.mpesa_receipt_number || null,
        ...(user ? { balance: user.balance } : {}), failure_reason: deposit.failure_reason || null,
        reason: deposit.failure_reason || null });
    }));
    app.post(['/api/payhero/cancel-pending', '/api/mpesa/cancel-pending'], authenticateToken, handle(async (req, res) => {
      if (typeof req.body.checkoutRequestId !== 'string') throw error('checkoutRequestId required.', 400);
      const deposit = await findDeposit(req.body.checkoutRequestId, req.user.id);
      if (!deposit) throw error('Deposit not found.', 404);
      await Deposit.updateOne({ id: deposit.id }, { $set: { client_dismissed_at: new Date(now()) } });
      return res.json({ success: true, message: 'Stopped waiting. Payment confirmation continues in the background.' });
    }));
    app.post(['/api/payhero/callback', '/api/mpesa/callback'], handle(async (req, res) => {
      await callback(req);
      return res.json({ status: true, message: 'Callback processed.' });
    }));
  }
  return { settings, switchGateway, initiate, settle, refresh, reconcilePending, callback, mount };
}
module.exports = { createPaymentService };
