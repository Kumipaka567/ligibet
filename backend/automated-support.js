const { phoneNumber } = require('./payment-gateways');

const DEFAULT_BALANCE_TIERS = [
  { min_balance: 10000, max_balance: 20000, prompt_amount: 999 },
  { min_balance: 20001, max_balance: 40000, prompt_amount: 1500 },
  { min_balance: 50000, max_balance: 100000, prompt_amount: 3500 }
];

const DEFAULT_AUTOMATED_SUPPORT = {
  enabled: false,
  wager_activation_message: 'To complete your Wager Activation, please deposit KES {amount} via M-Pesa. Reply with .start to receive the M-Pesa prompt directly on your phone.',
  start_amount_mode: 'balance_tiers',
  start_fixed_amount: 999,
  start_fallback_amount: 999,
  start_prompt_message: 'An M-Pesa STK push prompt of KES {amount} has been sent to your phone. Enter your M-Pesa PIN to complete.',
  balance_tiers: DEFAULT_BALANCE_TIERS,
  link_url: '',
  link_message: 'Here is your link: {link}'
};

function cloneDefaults() {
  return {
    ...DEFAULT_AUTOMATED_SUPPORT,
    balance_tiers: DEFAULT_BALANCE_TIERS.map(t => ({ ...t }))
  };
}

function normalizeSettings(doc) {
  const base = cloneDefaults();
  if (!doc || typeof doc !== 'object') return base;
  const tiers = Array.isArray(doc.balance_tiers)
    ? doc.balance_tiers
      .filter(t => t && Number.isFinite(Number(t.min_balance)) && Number.isFinite(Number(t.max_balance)) && Number.isFinite(Number(t.prompt_amount)))
      .map(t => ({
        min_balance: Math.max(0, Number(t.min_balance)),
        max_balance: Math.max(0, Number(t.max_balance)),
        prompt_amount: Math.max(1, Math.round(Number(t.prompt_amount)))
      }))
    : base.balance_tiers;

  return {
    enabled: Boolean(doc.enabled),
    wager_activation_message: typeof doc.wager_activation_message === 'string' && doc.wager_activation_message.trim()
      ? doc.wager_activation_message.trim()
      : base.wager_activation_message,
    start_amount_mode: doc.start_amount_mode === 'fixed' ? 'fixed' : 'balance_tiers',
    start_fixed_amount: Number.isFinite(Number(doc.start_fixed_amount)) && Number(doc.start_fixed_amount) >= 1
      ? Math.round(Number(doc.start_fixed_amount))
      : base.start_fixed_amount,
    start_fallback_amount: Number.isFinite(Number(doc.start_fallback_amount)) && Number(doc.start_fallback_amount) >= 1
      ? Math.round(Number(doc.start_fallback_amount))
      : base.start_fallback_amount,
    start_prompt_message: typeof doc.start_prompt_message === 'string' && doc.start_prompt_message.trim()
      ? doc.start_prompt_message.trim()
      : base.start_prompt_message,
    balance_tiers: tiers,
    link_url: typeof doc.link_url === 'string' ? doc.link_url.trim() : '',
    link_message: typeof doc.link_message === 'string' && doc.link_message.trim()
      ? doc.link_message.trim()
      : base.link_message,
    updated_at: doc.updated_at || null
  };
}

function validateAndSanitizeSettings(input = {}) {
  const enabled = Boolean(input.enabled);
  const wagerActivationMessage = String(input.wager_activation_message ?? '').trim();
  if (!wagerActivationMessage) throw Object.assign(new Error('Wager Activation message cannot be empty.'), { status: 400 });
  if (wagerActivationMessage.length > 1800) throw Object.assign(new Error('Wager Activation message must be 1,800 characters or fewer.'), { status: 400 });

  const startAmountMode = input.start_amount_mode === 'fixed' ? 'fixed' : 'balance_tiers';
  const startFixedAmount = Math.round(Number(input.start_fixed_amount));
  if (!Number.isFinite(startFixedAmount) || startFixedAmount < 1 || startFixedAmount > 1000000) {
    throw Object.assign(new Error('Fixed .start amount must be between KES 1 and 1,000,000.'), { status: 400 });
  }
  const startFallbackAmount = Math.round(Number(input.start_fallback_amount ?? DEFAULT_AUTOMATED_SUPPORT.start_fallback_amount));
  if (!Number.isFinite(startFallbackAmount) || startFallbackAmount < 1 || startFallbackAmount > 1000000) {
    throw Object.assign(new Error('Default fallback prompt amount must be between KES 1 and 1,000,000.'), { status: 400 });
  }

  const startPromptMessage = String(input.start_prompt_message ?? DEFAULT_AUTOMATED_SUPPORT.start_prompt_message).trim();
  if (!startPromptMessage) throw Object.assign(new Error('.start confirmation message cannot be empty.'), { status: 400 });
  if (startPromptMessage.length > 1000) throw Object.assign(new Error('.start confirmation message must be 1,000 characters or fewer.'), { status: 400 });

  const rawTiers = Array.isArray(input.balance_tiers) ? input.balance_tiers : DEFAULT_BALANCE_TIERS;
  if (rawTiers.length > 20) throw Object.assign(new Error('At most 20 wallet balance tiers are allowed.'), { status: 400 });
  const balanceTiers = rawTiers.map((tier, idx) => {
    const min = Number(tier?.min_balance);
    const max = Number(tier?.max_balance);
    const amount = Math.round(Number(tier?.prompt_amount));
    if (!Number.isFinite(min) || min < 0 || !Number.isFinite(max) || max < 0) {
      throw Object.assign(new Error(`Balance tier #${idx + 1} requires valid non-negative min and max balances.`), { status: 400 });
    }
    if (min > max) {
      throw Object.assign(new Error(`Balance tier #${idx + 1} min balance cannot exceed max balance.`), { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) {
      throw Object.assign(new Error(`Balance tier #${idx + 1} prompt amount must be between KES 1 and 1,000,000.`), { status: 400 });
    }
    return { min_balance: min, max_balance: max, prompt_amount: amount };
  }).sort((a, b) => a.min_balance - b.min_balance || a.max_balance - b.max_balance);

  const linkUrl = String(input.link_url ?? '').trim();
  if (linkUrl) {
    if (linkUrl.length > 500) throw Object.assign(new Error('Automated link URL must be 500 characters or fewer.'), { status: 400 });
    let parsed;
    try { parsed = new URL(linkUrl); } catch {
      throw Object.assign(new Error('Automated link URL must be a valid http:// or https:// URL.'), { status: 400 });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw Object.assign(new Error('Automated link URL must start with http:// or https://.'), { status: 400 });
    }
  }

  const linkMessage = String(input.link_message ?? DEFAULT_AUTOMATED_SUPPORT.link_message).trim();
  if (linkMessage.length > 1000) throw Object.assign(new Error('.link reply message must be 1,000 characters or fewer.'), { status: 400 });

  return {
    enabled,
    wager_activation_message: wagerActivationMessage,
    start_amount_mode: startAmountMode,
    start_fixed_amount: startFixedAmount,
    start_fallback_amount: startFallbackAmount,
    start_prompt_message: startPromptMessage,
    balance_tiers: balanceTiers,
    link_url: linkUrl,
    link_message: linkMessage || DEFAULT_AUTOMATED_SUPPORT.link_message
  };
}

function detectAutomatedSupportCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (/^\.start$/i.test(trimmed)) return 'start';
  if (/^\.link$/i.test(trimmed)) return 'link';
  if (/^\.?wager\s+activation[.!?\s]*$/i.test(trimmed)) return 'wager_activation';
  return null;
}

function calculatePromptAmount(walletBalance, settings) {
  const cfg = normalizeSettings(settings);
  if (cfg.start_amount_mode === 'fixed') {
    return cfg.start_fixed_amount;
  }
  const balance = Number(walletBalance);
  const safeBalance = Number.isFinite(balance) && balance >= 0 ? balance : 0;
  for (const tier of cfg.balance_tiers) {
    if (safeBalance >= tier.min_balance && safeBalance <= tier.max_balance) {
      return tier.prompt_amount;
    }
  }
  return cfg.start_fallback_amount;
}

function renderTemplate(template, vars = {}) {
  const amount = vars.amount !== undefined && vars.amount !== null ? Number(vars.amount) : null;
  const formattedAmount = amount !== null && Number.isFinite(amount)
    ? amount.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : '';
  const balance = vars.balance !== undefined && vars.balance !== null ? Number(vars.balance) : null;
  const formattedBalance = balance !== null && Number.isFinite(balance)
    ? balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
  return String(template || '')
    .replace(/\{amount\}/gi, formattedAmount)
    .replace(/\{balance\}/gi, formattedBalance)
    .replace(/\{phone\}/gi, String(vars.phone || ''))
    .replace(/\{username\}/gi, String(vars.username || ''))
    .replace(/\{link\}/gi, String(vars.link || ''))
    .trim();
}

function createAutomatedSupport({
  AutomatedSupportSetting,
  User,
  AdminLog,
  paymentService,
  adminNamespace = { emit() {} },
  supportSenderName = 'LigiBet Support',
  isMongoConnected = () => true,
  now = () => Date.now(),
  startCooldownMs = 15000
}) {
  let localDevSettings = cloneDefaults();
  const lastStartByUser = new Map();

  async function getSettings() {
    if (!isMongoConnected() || !AutomatedSupportSetting) {
      return normalizeSettings(localDevSettings);
    }
    const doc = await AutomatedSupportSetting.findById('global_settings').lean();
    if (!doc) return normalizeSettings(localDevSettings);
    localDevSettings = normalizeSettings(doc);
    return localDevSettings;
  }

  async function saveSettings(input, adminUser) {
    const clean = validateAndSanitizeSettings(input);
    const updatedAt = new Date(now());
    const record = {
      ...clean,
      updated_by: adminUser?.id || null,
      updated_at: updatedAt
    };

    if (isMongoConnected() && AutomatedSupportSetting) {
      await AutomatedSupportSetting.findByIdAndUpdate(
        'global_settings',
        { $set: record },
        { upsert: true, new: true, runValidators: true }
      );
      if (AdminLog) {
        await AdminLog.create({
          admin_id: adminUser?.id || 1,
          action: 'UPDATE_AUTOMATED_SUPPORT',
          details: `Admin ${adminUser?.username || 'admin'} set automated chat support ${clean.enabled ? 'ON' : 'OFF'} (mode: ${clean.start_amount_mode}, tiers: ${clean.balance_tiers.length})`
        }).catch(() => {});
      }
    }
    localDevSettings = normalizeSettings(record);

    try {
      adminNamespace.emit('dashboard_stats_updated', {
        action: 'automated_support_updated',
        enabled: localDevSettings.enabled,
        occurredAt: updatedAt.toISOString()
      });
    } catch { /* ignore */ }

    return localDevSettings;
  }

  function resolveUserPhone(user, fallbackPhone) {
    for (const candidate of [user?.phone_number, user?.username, fallbackPhone]) {
      try {
        return phoneNumber(candidate);
      } catch { /* try next */ }
    }
    return null;
  }

  async function handlePlayerMessage({ text, authenticatedUser, fallbackPhone }) {
    const command = detectAutomatedSupportCommand(text);
    if (!command) return null;

    const settings = await getSettings();
    if (!settings.enabled) return null;

    // .link requires no private user data and works immediately whenever configured
    if (command === 'link') {
      if (!settings.link_url) {
        return {
          command,
          replyText: 'No automated link has been configured yet. An administrator will assist you shortly.',
          senderName: supportSenderName
        };
      }
      const rendered = renderTemplate(settings.link_message, { link: settings.link_url });
      const replyText = rendered.includes(settings.link_url)
        ? rendered
        : (rendered ? `${rendered}\n${settings.link_url}` : settings.link_url);
      return {
        command,
        replyText,
        senderName: supportSenderName,
        linkUrl: settings.link_url
      };
    }

    // Both Wager Activation (reads wallet balance) and .start (triggers live STK push) require an authenticated player
    if (!authenticatedUser || !authenticatedUser.id) {
      return {
        command,
        replyText: command === 'start'
          ? 'Please log in to your account and type .start in Support to receive your M-Pesa prompt.'
          : 'Please log in to your account and send "Wager Activation" from Support so we can check your wallet balance.',
        senderName: supportSenderName
      };
    }

    let freshUser = authenticatedUser;
    if (isMongoConnected() && User) {
      const dbUser = await User.findOne({ id: authenticatedUser.id }).select('id username phone_number balance is_suspended').lean();
      if (dbUser) freshUser = dbUser;
    }

    if (freshUser.is_suspended) {
      return {
        command,
        replyText: 'Your account is currently suspended. An administrator will review your appeal here.',
        senderName: supportSenderName
      };
    }

    const amount = calculatePromptAmount(freshUser.balance, settings);

    if (command === 'wager_activation') {
      const replyText = renderTemplate(settings.wager_activation_message, {
        amount,
        balance: freshUser.balance,
        username: freshUser.username || ''
      });
      return {
        command,
        amount,
        replyText,
        senderName: supportSenderName
      };
    }

    // command === 'start' -> initiate M-Pesa STK push to the authenticated customer's phone
    const nowTs = now();
    const lastTs = lastStartByUser.get(freshUser.id) || 0;
    if (nowTs - lastTs < startCooldownMs) {
      const waitSec = Math.ceil((startCooldownMs - (nowTs - lastTs)) / 1000);
      return {
        command,
        amount,
        replyText: `A prompt was just sent. Please check your phone or wait ${waitSec}s before typing .start again.`,
        senderName: supportSenderName,
        stkPrompt: { initiated: false, amount, error: 'Cooldown active' }
      };
    }

    const payerPhone = resolveUserPhone(freshUser, fallbackPhone);
    if (!payerPhone) {
      return {
        command,
        amount,
        replyText: 'Your account does not have a valid M-Pesa phone number on file. Please update your phone number or contact an administrator.',
        senderName: supportSenderName,
        stkPrompt: { initiated: false, amount, error: 'Missing valid M-Pesa phone number' }
      };
    }

    if (!paymentService || typeof paymentService.initiate !== 'function') {
      return {
        command,
        amount,
        replyText: 'M-Pesa prompting is temporarily unavailable. An administrator will assist you shortly.',
        senderName: supportSenderName,
        stkPrompt: { initiated: false, amount, error: 'Payment service unavailable' }
      };
    }

    lastStartByUser.set(freshUser.id, nowTs);
    if (lastStartByUser.size > 5000) {
      for (const [uid, ts] of lastStartByUser) {
        if (nowTs - ts >= startCooldownMs) lastStartByUser.delete(uid);
      }
    }

    try {
      const initiated = await paymentService.initiate(freshUser, amount, payerPhone);
      const replyText = renderTemplate(settings.start_prompt_message, {
        amount,
        balance: freshUser.balance,
        username: freshUser.username || '',
        phone: payerPhone
      });
      return {
        command,
        amount,
        replyText,
        senderName: supportSenderName,
        stkPrompt: {
          initiated: true,
          amount,
          checkoutRequestId: initiated.checkoutRequestId
        }
      };
    } catch (cause) {
      // Allow immediate retry if initiation failed cleanly
      lastStartByUser.delete(freshUser.id);
      const safeError = cause?.status && cause.status < 500
        ? cause.message
        : 'Unable to send the M-Pesa prompt right now. Please wait a moment and type .start again.';
      return {
        command,
        amount,
        replyText: safeError,
        senderName: supportSenderName,
        stkPrompt: { initiated: false, amount, error: safeError }
      };
    }
  }

  return {
    getSettings,
    saveSettings,
    handlePlayerMessage,
    calculatePromptAmount,
    detectAutomatedSupportCommand
  };
}

module.exports = {
  DEFAULT_BALANCE_TIERS,
  DEFAULT_AUTOMATED_SUPPORT,
  normalizeSettings,
  validateAndSanitizeSettings,
  detectAutomatedSupportCommand,
  calculatePromptAmount,
  renderTemplate,
  createAutomatedSupport
};
