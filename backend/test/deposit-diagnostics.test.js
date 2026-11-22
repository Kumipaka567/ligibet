const { test } = require('node:test');
const assert = require('node:assert/strict');
const { depositDiagnostic, transactionDepositDiagnostic, adminTransactionDiagnostics } = require('../deposit-diagnostics');

test('admin reasons separate customer, prompt delivery and provider failures', () => {
  for (const [raw, expected, stage] of [
    [{ ResultDesc: 'Your M-Pesa balance is insufficient' }, 'customer_funds'],
    [{ ResultCode: 1, ResultDesc: 'The balance is insufficient for the transaction.' }, 'customer_funds'],
    [{ ResultCode: '01', ResultDesc: 'Balance too low' }, 'customer_funds'],
    [{ ResultCode: 1, ResultDesc: 'Timed out after insufficient balance' }, 'customer_funds'],
    [{ ResultDesc: 'Insufficient M-Pesa account balance' }, 'customer_funds'],
    [{ resultCode: 'INSUFFICIENT_FUNDS', resultDescription: 'Insufficient funds' }, 'customer_funds'],
    [{ errorMessage: 'Invalid M-Pesa PIN' }, 'wrong_pin'],
    [{ ResultCode: 2001, ResultDesc: 'The initiator information is invalid.' }, 'wrong_pin'],
    [{ ResultCode: 1032 }, 'cancelled'],
    [{ event: 'payment.cancelled', status: 'failed' }, 'cancelled'],
    [{ resultCode: 1037 }, 'timed_out'],
    [{ ResultCode: 1038 }, 'timed_out'],
    [{ ResultCode: 1025 }, 'not_delivered'],
    [{ status_reason: 'STK prompt was not delivered' }, 'not_delivered'],
    [{ ResultCode: 26, ResultDesc: 'System busy' }, 'delayed'],
    [{ error: { message: 'Customer number blocked for 24 hours' } }, 'customer_blocked', 'submission'],
    [{ message: 'Insufficient service wallet balance' }, 'provider_funds', 'submission'],
    [{ message: 'Insufficient funds' }, 'provider_funds', 'submission'],
    [{ error_code: 'INSUFFICIENT_BALANCE', message: 'Low balance' }, 'provider_funds', 'submission'],
    [{ error_code: 'ACCOUNT_DISABLED', message: 'Merchant disabled' }, 'provider_blocked', 'submission'],
    [{ error_code: 'RATE_LIMITED', message: 'Too many requests' }, 'rate_limit', 'submission'],
    [{ message: 'Merchant account suspended' }, 'provider_blocked', 'submission'],
    [{ message: 'Payment failed on the phone.' }, 'unknown']
  ]) assert.equal(depositDiagnostic('payhero', raw, { status: 'failed', stage }).category, expected);
});

test('reportable provider text omits credentials, URLs and phone numbers', () => {
  const diagnostic = depositDiagnostic('nexuspay', { ResultDesc: 'Unsupported request for +254712345678. API key: sk_live_secret https://internal.example' });
  assert.equal(diagnostic.category, 'reported');
  for (const sensitive of ['254712345678', 'sk_live_secret', 'internal.example']) assert.ok(!diagnostic.detail.includes(sensitive));
});

test('a delayed prompt remains pending and historical details require the same transaction and player', async () => {
  const pending = { type: 'deposit', status: 'pending', created_at: new Date(0) };
  assert.equal(transactionDepositDiagnostic(pending, 59999), null);
  assert.equal(transactionDepositDiagnostic(pending, 60000).category, 'delayed');
  const rows = [{ id: 1, user_id: 7 }, { id: 2, user_id: 8 }].map(tx => ({ ...tx, type: 'deposit', status: 'failed' }));
  const Deposit = { find: () => ({ select() { return this; }, lean: async () => [
    { transaction_id: 1, user_id: 7, provider: 'nexuspay', callback_payload: { failureReason: 'Incorrect PIN' } },
    { transaction_id: 2, user_id: 99, provider: 'nexuspay', callback_payload: { failureReason: 'Incorrect PIN' } }
  ] }) };
  const diagnostic = await adminTransactionDiagnostics(Deposit, rows);
  assert.equal(diagnostic.get(1).category, 'wrong_pin');
  assert.equal(diagnostic.get(2).category, 'unknown');
});
