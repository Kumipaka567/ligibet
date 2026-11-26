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

test('uses a single uniform admin-editable fixed amount across every wallet balance', () => {
  const fixed3500 = { ...DEFAULT_AUTOMATED_SUPPORT, start_fixed_amount: 3500 };
  for (const balance of [0, 5000, 15000, 30000, 75000, 150000]) {
    assert.equal(calculatePromptAmount(balance, fixed3500), 3500);
  }
  // Legacy documents saved with balance_tiers still resolve uniformly to start_fixed_amount
  assert.equal(calculatePromptAmount(75000, { start_amount_mode: 'balance_tiers', start_fixed_amount: 1500 }), 1500);
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

test('Wager Activation and .start always use the exact same uniform fixed amount edited by admin', async () => {
  const f = makeFixture({ userBalance: 75000, userPhone: '+254712345678' });
  await f.service.saveSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    enabled: true,
    start_fixed_amount: 3500,
    wager_activation_message: 'Hi {username}, please deposit KES {amount} to activate your wager. Type .start to receive the prompt.',
    start_prompt_message: 'Prompt of KES {amount} sent! Enter your M-Pesa PIN.'
  }, { id: 1, username: 'admin' });

  // Unauthenticated visitor cannot read account info or trigger STK pushes
  const anonWager = await f.service.handlePlayerMessage({ text: 'Wager Activation', authenticatedUser: null, fallbackPhone: '0712345678' });
  assert.match(anonWager.replyText, /log in/i);
  const anonStart = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: null, fallbackPhone: '0712345678' });
  assert.match(anonStart.replyText, /log in/i);
  assert.equal(f.initiated.length, 0);

  // Authenticated player gets uniform KES 3,500 on BOTH Wager Activation AND .start
  const wager = await f.service.handlePlayerMessage({ text: 'wager activation', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(wager.amount, 3500);
  assert.equal(wager.replyText, 'Hi player7, please deposit KES 3,500 to activate your wager. Type .start to receive the prompt.');

  const first = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(first.stkPrompt.initiated, true);
  assert.equal(first.stkPrompt.amount, 3500);
  assert.equal(first.replyText, 'Prompt of KES 3,500 sent! Enter your M-Pesa PIN.');
  assert.deepEqual(f.initiated, [{ userId: 7, amount: 3500, phone: '254712345678' }]);

  // Immediate repeat hits cooldown without firing a duplicate STK prompt
  const rapid = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(rapid.stkPrompt.initiated, false);
  assert.equal(f.initiated.length, 1);

  // Admin edits the uniform fixed amount to KES 1,500 -> both Wager Activation and .start update together
  f.tick(16000);
  await f.service.saveSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    enabled: true,
    start_fixed_amount: 1500,
    wager_activation_message: 'Deposit KES {amount}. Reply .start.'
  }, { id: 1, username: 'admin' });

  const wagerUpdated = await f.service.handlePlayerMessage({ text: 'Wager Activation', authenticatedUser: { id: 7 } });
  assert.equal(wagerUpdated.amount, 1500);
  assert.equal(wagerUpdated.replyText, 'Deposit KES 1,500. Reply .start.');

  const second = await f.service.handlePlayerMessage({ text: '.start', authenticatedUser: { id: 7 }, fallbackPhone: '0712345678' });
  assert.equal(second.stkPrompt.initiated, true);
  assert.equal(second.stkPrompt.amount, 1500);
  assert.equal(f.initiated.at(-1).amount, 1500);
});

test('.link returns admin-configured HTTPS URL and rejects unsafe URL schemes or invalid amounts on save', async () => {
  assert.throws(() => validateAndSanitizeSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    link_url: 'javascript:alert(1)'
  }), { status: 400 });

  assert.throws(() => validateAndSanitizeSettings({
    ...DEFAULT_AUTOMATED_SUPPORT,
    start_fixed_amount: 0
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
