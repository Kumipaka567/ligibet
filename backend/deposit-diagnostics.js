const labels = {
  customer_funds: 'Insufficient M-Pesa funds', wrong_pin: 'Incorrect M-Pesa PIN', cancelled: 'Cancelled by customer',
  timed_out: 'Prompt timed out', not_delivered: 'Prompt did not reach the phone', delayed: 'Prompt delayed',
  customer_blocked: 'Customer blocked by provider', provider_blocked: 'Merchant restricted by provider',
  provider_funds: 'Insufficient provider wallet funds', invalid_phone: 'Invalid customer phone number',
  rate_limit: 'Provider rate limit', provider_error: 'Provider rejected the request',
  reported: 'Provider reported a failure', unknown: 'Provider did not specify a reason'
};

function safeDetail(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 1000)
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/\b(?:authorization|api[_ -]?key|password|secret|token)\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, '[credential removed]')
    .replace(/\b(?:sk|pk)_(?:live|test)_[\w-]+\b/gi, '[credential removed]')
    .replace(/\+?\d(?:[(). -]*\d){8,}/g, '[number removed]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function depositDiagnostic(provider, raw, { reason, status, stage = 'confirmation', httpStatus } = {}) {
  const records = [raw?.response, raw?.data, raw?.Body?.stkCallback, raw?.error, raw].filter(row => row && typeof row === 'object');
  const fields = ['ResultDesc', 'resultDesc', 'status_reason', 'statusReason', 'failure_reason', 'failureReason', 'errorMessage', 'error_message', 'reason', 'description', 'ResponseDescription', 'responseDescription', 'message', 'error'];
  const options = [...records.flatMap(row => fields.map(field => safeDetail(row[field]))), safeDetail(reason)].filter(Boolean);
  const generic = /^(?:failed|error|payment failed(?: or was cancelled on the phone| on the phone)?\.?|the payment prompt was rejected\. please try again later\.|the payment request could not be confirmed\. check with support before retrying\.)$/i;
  const details = [...new Set(options.filter(value => !generic.test(value)))];
  const text = details.join(' ').toLowerCase();
  const rawCode = records.flatMap(row => [row.ResultCode, row.resultCode, row.errorCode, row.error_code, row.ResponseCode, row.responseCode])
    .find(value => (typeof value === 'number' || typeof value === 'string') && /^[\w.-]{1,32}$/.test(String(value)) && String(value) !== '0');
  const code = rawCode === undefined ? null : String(rawCode);
  const cancelled = [status, ...records.flatMap(row => [row.Status, row.status])]
    .some(value => typeof value === 'string' && /^cancelled$|^canceled$/i.test(value.trim()));
  let category;
  if (/insufficient|low balance|not enough|top.?up|required balance|balance too low/.test(text)
    && /service (?:wallet|balance|token|credit)|merchant (?:wallet|account|balance)|(?:pay ?hero|nexus pay) (?:wallet|balance)|stk (?:fees?|credits?)|prompt (?:fees?|credits?)|account wallet/.test(text)) category = 'provider_funds';
  else if (/block|blacklist|restrict|suspend|too many failed/.test(text) && /phone|number|customer|subscriber|recipient|msisdn/.test(text)) category = 'customer_blocked';
  else if (/block|blacklist|restrict|suspend/.test(text) && /merchant|account|service|gateway/.test(text)) category = 'provider_blocked';
  else if (/(?:wrong|incorrect|invalid) (?:m.?pesa )?pin|pin (?:is )?(?:wrong|incorrect|invalid|entered incorrectly)/.test(text)) category = 'wrong_pin';
  else if (/insufficient (?:funds|balance)|not enough (?:funds|balance)|balance (?:is )?(?:insufficient|too low)/.test(text)) category = stage === 'submission' ? 'reported' : 'customer_funds';
  else if (/not (?:delivered|received|sent|reach)|did not (?:reach|receive)|delivery failed|unable to (?:deliver|reach)|subscriber (?:unreachable|unavailable)|phone (?:unreachable|switched off)/.test(text)) category = 'not_delivered';
  else if (/cancel(?:led|ed)(?: by (?:user|customer|subscriber)| on the phone)|user cancel/.test(text)) category = 'cancelled';
  else if (/timed?\s*out|expired|no response from|could not (?:get|obtain) a response/.test(text)) category = 'timed_out';
  else if (/invalid (?:m.?pesa |customer )?(?:phone|mobile|subscriber|msisdn)|not registered/.test(text)) category = 'invalid_phone';
  else if (/rate limit|too many requests|throttl/.test(text) || httpStatus === 429) category = 'rate_limit';
  else if (/delay|still queued/.test(text)) category = 'delayed';
  else if (cancelled || code === '1032') category = 'cancelled';
  else if (code === '1037') category = 'timed_out';
  else if (code === '2001') category = 'wrong_pin';
  else if (details.length) category = 'reported';
  else if (stage === 'submission' && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) category = 'provider_error';
  else if (status === 'pending') category = 'delayed';
  else category = 'unknown';

  return { category, label: labels[category], provider: ['payhero', 'nexuspay'].includes(provider) ? provider : null,
    code, detail: details[0] || (category === 'timed_out' || category === 'delayed'
      ? 'The provider has not confirmed delivery to the phone or a customer response.' : null) };
}

function transactionDepositDiagnostic(tx, now = Date.now()) {
  if (tx.type !== 'deposit' || !['failed', 'pending'].includes(tx.status)) return null;
  if (tx.admin_deposit_diagnostic) return tx.admin_deposit_diagnostic;
  if (tx.status === 'failed') return depositDiagnostic(null, null, { reason: tx.failure_reason, status: 'failed' });
  if (now - new Date(tx.created_at).getTime() >= 60 * 1000) return depositDiagnostic(null, null, { status: 'pending' });
  return null;
}

async function adminTransactionDiagnostics(Deposit, transactions) {
  const legacy = transactions.filter(tx => tx.type === 'deposit' && tx.status === 'failed' && !tx.admin_deposit_diagnostic);
  const result = new Map(transactions.map(tx => [tx.id, transactionDepositDiagnostic(tx)]));
  if (!legacy.length) return result;

  const linked = await Deposit.find({ transaction_id: { $in: legacy.map(tx => tx.id) }, status: 'failed' })
    .select('transaction_id user_id provider provider_status failure_reason callback_payload').lean();
  const byTransaction = new Map(linked.map(deposit => [deposit.transaction_id, deposit]));
  for (const tx of legacy) {
    const deposit = byTransaction.get(tx.id);
    if (deposit?.user_id !== tx.user_id) continue;
    result.set(tx.id, depositDiagnostic(deposit.provider, deposit.callback_payload,
      { reason: deposit.failure_reason || tx.failure_reason, status: deposit.provider_status || tx.status }));
  }
  return result;
}

module.exports = { depositDiagnostic, transactionDepositDiagnostic, adminTransactionDiagnostics };
