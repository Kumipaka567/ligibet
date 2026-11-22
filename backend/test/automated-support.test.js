const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_AUTOMATED_SUPPORT,
  detectAutomatedSupportCommand,
  calculatePromptAmount,
  validateAndSanitizeSettings,
  createAutomatedSupport
} = require('../automated-support');

function makeFixture({ userBalance = 15000, userPhone = '0712345678', suspended = false, initiateError = null } = {}) {
  let stored = null;
  const logs = [];
  const initiated = [];
  const emitted = [];
  let clock = 1000000;

  const AutomatedSupportSetting = {
    findById: () => ({ lean: async () => (stored ? structuredClone(stored) : null) }),
    findByIdAndUpdate: async (_id, update) => {
      stored = structuredClone(update.$set);
      return stored;
    }
  };
  const User = {
    findOne: ({ id }) => ({
      select() { return this; },
      lean: async () => (id === 7 ? {
        id: 7,
        username: 'player7',
        phone_number: userPhone,
        balance: userBalance,
        is_suspended: suspended
      } : null)
    })
  };
  const AdminLog = {
    create: async entry => { logs.push(entry); return entry; }
  };
  const paymentService = {
    initiate: async (user, amount, phone) => {
      initiated.push({ userId: user.id, amount, phone });
      if (initiateError) throw initiateError;
      return { success: true, checkoutRequestId: `ws_CO_auto_${initiated.length}` };
    }
  };
  const adminNamespace = {
    emit: (event, payload) => emitted.push({ event, payload })
  };

  const service = createAutomatedSupport({
    AutomatedSupportSetting,
    User,
    AdminLog,
    paymentService,
    adminNamespace,
    supportSenderName: 'LigiBet Support',
    isMongoConnected: () => true,
    now: () => clock
  });

  return {
    service,
    logs,
    initiated,
    emitted,
    tick: ms => { clock += ms; },
    setStored: next => { stored = structuredClone(next); }
  };
}

test('detects Wager Activation, .start, and .link case-insensitively without matching normal chat', () => {
  assert.equal(detectAutomatedSupportCommand('Wager Activation'), 'wager_activation');
  assert.equal(detectAutomatedSupportCommand('  wager   activation '), 'wager_activation');
  assert.equal(detectAutomatedSupportCommand('Wager activation.'), 'wager_activation');
  assert.equal(detectAutomatedSupportCommand('.start'), 'start');
  assert.equal(detectAutomatedSupportCommand('  .START  '), 'start');
  assert.equal(detectAutomatedSupportCommand('.link'), 'link');
  assert.equal(detectAutomatedSupportCommand('.LINK'), 'link');
  assert.equal(detectAutomatedSupportCommand('Hello I need help with wager activation'), null);
  assert.equal(detectAutomatedSupportCommand('start'), null);
  assert.equal(detectAutomatedSupportCommand('link please'), null);
});

test('calculates prompt amounts accurately for default balance tiers, fallback, and fixed mode', () => {
  const base = { ...DEFAULT_AUTOMATED_SUPPORT };
  assert.equal(calculatePromptAmount(10000, base), 999);
  assert.equal(calculatePromptAmount(15500, base), 999);
  assert.equal(calculatePromptAmount(20000, base), 999);
  assert.equal(calculatePromptAmount(20001, base), 1500);
  assert.equal(calculatePromptAmount(35000, base), 1500);
  assert.equal(calculatePromptAmount(40000, base), 1500);
  assert.equal(calculatePromptAmount(50000, base), 3500);
  assert.equal(calculatePromptAmount(75000, base), 3500);
  assert.equal(calculatePromptAmount(100000, base), 3500);
  assert.equal(calculatePromptAmount(5000, base), 999); // fallback
  assert.equal(calculatePromptAmount(45000, { ...base, start_fallback_amount: 2500 }), 2500);
  assert.equal(calculatePromptAmount(75000, { ...base, start_amount_mode: 'fixed', start_fixed_amount: 2200 }), 2200);
});

test('when automated chat support is OFF, player commands do not trigger replies or STK pushes', async () => {
  const f = makeFixture({ userBalance: 60000 });
  const authUser = { id: 7, username: 'player7' };
  for (const text of ['Wager Activation', '.start', '.link']) {
    const res = await f.service.handlePlayerMessage({ text, authenticatedUser: authUser, fallbackPhone: '0712345678' });
    assert.equal(res, null);
  }
  assert.equal(f.initiated.length, 0);
});

test('Wager Activation replies with admin message and balance-calculated amount for authenticated players only', async () => {
  const f = makeFixture({ userBalance: 75000 });
  await f.service.saveSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    enabled: true,
    wager_activation_message: 'Hi {username}, your balance is KES {balance}. Deposit KES {amount} by typing .start.'
  }, { id: 1, username: 'admin' });

  // Unauthenticated visitor cannot read another account's balance
  const anon = await f.service.handlePlayerMessage({ text: 'Wager Activation', authenticatedUser: null, fallbackPhone: '0712345678' });
  assert.equal(anon.command, 'wager_activation');
  assert.match(anon.replyText, /log in/i);
  assert.ok(!anon.replyText.includes('3,500'));

  // Authenticated player receives exact balance tier amount (75,000 -> 3,500)
  const authed = await f.service.handlePlayerMessage({ text: 'wager activation', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(authed.command, 'wager_activation');
  assert.equal(authed.amount, 3500);
  assert.equal(authed.replyText, 'Hi player7, your balance is KES 75,000.00. Deposit KES 3,500 by typing .start.');
});

test('.start initiates a live M-Pesa STK prompt for authenticated player with cooldown and safe error handling', async () => {
  const f = makeFixture({ userBalance: 25000, userPhone: '+254712345678' });
  await f.service.saveSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    enabled: true,
    start_prompt_message: 'Prompt of KES {amount} sent! Enter your M-Pesa PIN.'
  }, { id: 1, username: 'admin' });

  // Unauthenticated visitor cannot trigger STK pushes
  const anon = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: null, fallbackPhone: '0712345678' });
  assert.match(anon.replyText, /log in/i);
  assert.equal(f.initiated.length, 0);

  // Authenticated player with KES 25,000 balance gets KES 1,500 prompt
  const first = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(first.stkPrompt.initiated, true);
  assert.equal(first.stkPrompt.amount, 1500);
  assert.equal(first.replyText, 'Prompt of KES 1,500 sent! Enter your M-Pesa PIN.');
  assert.deepEqual(f.initiated, [{ userId: 7, amount: 1500, phone: '254712345678' }]);

  // Immediate repeat hits cooldown without firing a duplicate STK prompt
  const rapid = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(rapid.stkPrompt.initiated, false);
  assert.equal(f.initiated.length, 1);

  // After cooldown, fixed .start amount override takes effect
  f.tick(16000);
  await f.service.saveSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    enabled: true,
    start_amount_mode: 'fixed',
    start_fixed_amount: 1200
  }, { id: 1, username: 'admin' });
  const second = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(second.stkPrompt.initiated, true);
  assert.equal(second.stkPrompt.amount, 1200);
  assert.equal(f.initiated.at(-1).amount, 1200);
});

test('.link returns admin-configured HTTPS URL and rejects unsafe URL schemes on save', async () => {
  assert.throws(() => validateAndSanitizeSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    link_url: 'javascript:alert(1)'
  }), { status: 400 });

  assert.throws(() => validateAndSanitizeSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    balance_tiers: [{ min_balance: 50000, max_balance: 10000, prompt_amount: 999 }]
  }), { status: 400 });

  const f = makeFixture();
  await f.service.saveSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    enabled: true,
    link_url: 'https://t.me/support_channel',
    link_message: 'Open our official support channel: {link}'
  }, { id: 1, username: 'admin' });

  const res = await f.service.handlePlayerMessage({ text: '.link', authenticatedUser: { id: 7 } });
  assert.equal(res.command, 'link');
  assert.equal(res.linkUrl, 'https://t.me/support_channel');
  assert.equal(res.replyText, 'Open our official support channel: https://t.me/support_channel');
  assert.equal(f.logs.length, 1);
  assert.equal(f.emitted.length, 1);
});
