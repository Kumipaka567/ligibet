const labels = {
  customer_funds: 'Insufficient funds', wrong_pin: 'Wrong PIN', cancelled: 'Cancelled by user',
  timed_out: 'Prompt timed out', not_delivered: 'Prompt not reached', delayed: 'Delayed prompt',
  customer_blocked: 'Customer blocked', provider_blocked: 'Gateway restricted',
  provider_funds: 'Gateway insufficient funds', invalid_phone: 'Invalid phone',
  rate_limit: 'Rate limited', provider_error: 'Prompt rejected',
  reported: 'Provider error', unknown: 'Failed on phone'
};

const categoryPriority = {
  unknown: 0,
  delayed: 1,
  provider_error: 2,
  reported: 3,
  timed_out: 4,
  cancelled: 5,
  not_delivered: 6,
  invalid_phone: 7,
  rate_limit: 8,
  wrong_pin: 9,
  customer_funds: 10,
  customer_blocked: 10,
  provider_blocked: 10,
  provider_funds: 10
};

function isStrongerDiagnostic(candidate, current) {
  if (!candidate || candidate.category === 'unknown') return false;
  if (!current || current.category === 'unknown') return true;
  return (categoryPriority[candidate.category] || 0) > (categoryPriority[current.category] || 0);
}

function safeDetail(value) {
  if (Array.isArray(value)) value = value.map(item => (typeof item === 'string' ? item : item?.message || '')).filter(Boolean).join('; ');
  if (typeof value !== 'string') return '';
  return value.slice(0, 1000)
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/\b(?:authorization|api[_ -]?key|password|secret|token)\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, '[credential removed]')
    .replace(/\b(?:sk|pk)_(?:live|test)_[\w-]+\b/gi, '[credential removed]')
    .replace(/\+?\d(?:[(). -]*\d){8,}/g, '[number removed]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function depositDiagnostic(provider, raw, { reason, status, stage = 'confirmation', httpStatus, initiationStatus } = {}) {
  const effectiveStage = initiationStatus === 'rejected' ? 'submission' : stage;
  const records = [raw?.response, raw?.data?.response, raw?.data, raw?.Body?.stkCallback, raw?.stkCallback, raw?.error, raw].filter(row => row && typeof row === 'object');
  const fields = ['ResultDesc', 'resultDesc', 'ResultDescription', 'resultDescription', 'status_reason', 'statusReason', 'status_message', 'statusMessage', 'failure_reason', 'failureReason', 'errorMessage', 'error_message', 'error_desc', 'errorDesc', 'reason', 'description', 'ResponseDescription', 'responseDescription', 'detail', 'details', 'message', 'error', 'errors'];
  const options = [...records.flatMap(row => fields.map(field => safeDetail(row[field]))), safeDetail(reason)].filter(Boolean);
  const generic = /^(?:failed|error|mpesa_error|payment failed(?: or was cancelled on the phone| on the phone)?\.?|the payment prompt was rejected\. please try again later\.|the payment request could not be confirmed\. check with support before retrying\.)$/i;
  const details = [...new Set(options.filter(value => !generic.test(value)))];
  const text = details.join(' ').toLowerCase();
  const rawCode = records.flatMap(row => [row.ResultCode, row.resultCode, row.errorCode, row.error_code, row.ResponseCode, row.responseCode, row.code])
    .find(value => (typeof value === 'number' || typeof value === 'string') && /^[\w.-]{1,32}$/.test(String(value)) && String(value) !== '0');
  const code = rawCode === undefined ? null : String(rawCode);
  const upperCode = code ? code.toUpperCase() : '';
  const events = [raw?.event, ...records.map(row => row.event)]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase());
  const cancelled = [status, ...records.flatMap(row => [row.Status, row.status])]
    .some(value => typeof value === 'string' && /^cancelled$|^canceled$/i.test(value.trim()))
    || events.some(value => value === 'payment.cancelled' || value === 'payment.canceled');
  const insufficientText = /insufficient(?:[\s_-]+[\w.-]+){0,3}[\s_-]+(?:funds|balance|money|credit|amount)|insufficient[\s_-]*(?:funds|balance)|not enough(?:[\s_-]+[\w.-]+){0,2}[\s_-]+(?:funds|balance|money)|balance(?:[\s_-]+[\w.-]+){0,2}[\s_-]+(?:is[\s_-]+)?(?:insufficient|too low|less)|low[\s_-]+m.?pesa[\s_-]+(?:funds|balance)|exceeds(?:[\s_-]+[\w.-]+){0,2}[\s_-]+(?:balance|limit)|fuliza(?:[\s_-]+[\w.-]+){0,3}[\s_-]+(?:insufficient|exceeded|declined|limit)/.test(text);
  const insufficientCode = upperCode === 'INSUFFICIENT_BALANCE' || upperCode === 'INSUFFICIENT_FUNDS';
  let category;
  if ((/insufficient|low[\s_-]*balance|not enough|top.?up|required[\s_-]*balance|balance[\s_-]*too[\s_-]*low|depleted|exhausted/.test(text)
    && /service[\s_-]*(?:wallet|balance|token|credit)|merchant[\s_-]*(?:wallet|account|balance)|(?:pay ?hero|nexus(?: ?pay)?)[\s_-]*(?:wallet|balance|account|funds|tokens?)|stk[\s_-]*(?:fees?|credits?)|prompt[\s_-]*(?:fees?|credits?)|service[\s_-]*tokens?|token[\s_-]*balance|wallet[\s_-]*balance/.test(text))
    || (effectiveStage === 'submission' && (insufficientCode || insufficientText || /low[\s_-]+balance|top[\s_-]*up/.test(text)))) category = 'provider_funds';
  else if (/block|blacklist|restrict|suspend|too many (?:failed|unpaid|attempts|prompts)/.test(text) && /phone|number|customer|subscriber|recipient|msisdn|user|client|attempts|prompts|24 hours/.test(text)) category = 'customer_blocked';
  else if (upperCode === 'ACCOUNT_DISABLED' || upperCode === 'ACTIVATION_REQUIRED' || (/block|blacklist|restrict|suspend|disabled|deactivated/.test(text) && /merchant|account|service|gateway|activation/.test(text))) category = 'provider_blocked';
  else if (effectiveStage !== 'submission' && (code === '1' || code === '01' || code === '2006' || insufficientCode || insufficientText)) category = 'customer_funds';
  else if (code === '2001' || /(?:wrong|incorrect|invalid) (?:m.?pesa )?pin|pin (?:is )?(?:wrong|incorrect|invalid|entered incorrectly)|initiator information is invalid/.test(text)) category = 'wrong_pin';
  else if (code === '1025' || code === '1036' || /not (?:delivered|received|sent|reach)|did not (?:reach|receive)|cannot be reached|could not be reached|delivery failed|unable to (?:deliver|reach)|subscriber (?:unreachable|unavailable)|phone (?:unreachable|switched off|off)|sim toolkit|smsc ack timeout|error occurred while sending a push/.test(text)) category = 'not_delivered';
  else if (/cancel(?:led|ed)(?: by (?:user|customer|subscriber)| on the phone)|user cancel|request cancelled/.test(text)) category = 'cancelled';
  else if (/timed?\s*out|expired|no response from|could not (?:get|obtain) a response/.test(text)) category = 'timed_out';
  else if (/invalid (?:m.?pesa |customer )?(?:phone|mobile|subscriber|msisdn)|not registered/.test(text)) category = 'invalid_phone';
  else if (upperCode === 'RATE_LIMITED' || /rate limit|too many requests|throttl/.test(text) || httpStatus === 429) category = 'rate_limit';
  else if (/delay|still queued|already in process|unable to lock subscriber|system busy/.test(text) || code === '1001' || code === '26') category = 'delayed';
  else if (cancelled || code === '1032') category = 'cancelled';
  else if (code === '1037' || code === '1038' || code === '1019') category = 'timed_out';
  else if (details.length) category = 'reported';
  else if (effectiveStage === 'submission' && ((httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) || initiationStatus === 'rejected' || upperCode === 'MPESA_ERROR')) category = 'provider_error';
  else if (status === 'pending') category = 'delayed';
  else category = 'unknown';

  const normalizedProvider = ['payhero', 'nexuspay'].includes(provider) ? provider : null;
  const fallbackDetails = {
    timed_out: 'No PIN response before timeout or phone was unreachable.',
    delayed: 'Awaiting provider confirmation or customer PIN response.',
    cancelled: 'Customer cancelled or dismissed the M-Pesa prompt on their phone.',
    wrong_pin: 'Customer entered an incorrect M-Pesa PIN on the phone.',
    customer_funds: 'Customer M-Pesa balance was too low to complete this deposit.',
    not_delivered: 'STK prompt could not reach the customer phone (off, out of coverage, or SIM busy).',
    provider_funds: 'Payment gateway wallet/tokens balance is too low to initiate STK prompts.',
    provider_error: 'Gateway rejected the STK push before reaching the phone (check provider wallet balance or blocked number).',
    unknown: normalizedProvider === 'nexuspay'
      ? 'Cancelled, wrong PIN, insufficient funds, or timed out (Nexus Pay API omits Safaricom M-Pesa failure codes).'
      : (normalizedProvider === 'payhero'
        ? 'Cancelled, wrong PIN, insufficient funds, or timed out (PayHero did not send a callback code for this record).'
        : 'Cancelled, wrong PIN, insufficient funds, or timed out.')
  };

  return { category, label: labels[category], provider: normalizedProvider,
    code, detail: details[0] || fallbackDetails[category] || null };
}

function transactionDepositDiagnostic(tx, now = Date.now()) {
  if (tx.type !== 'deposit' || !['failed', 'pending'].includes(tx.status)) return null;
  if (tx.admin_deposit_diagnostic && tx.admin_deposit_diagnostic.category !== 'unknown') {
    const existing = tx.admin_deposit_diagnostic;
    return { ...existing, label: labels[existing.category] || existing.label };
  }
  if (tx.status === 'failed') {
    const existingProvider = tx.admin_deposit_diagnostic?.provider || null;
    return depositDiagnostic(existingProvider, null, { reason: tx.failure_reason, status: 'failed' });
  }
  if (now - new Date(tx.created_at).getTime() >= 60 * 1000) return depositDiagnostic(null, null, { status: 'pending' });
  return null;
}

async function adminTransactionDiagnostics(Deposit, transactions) {
  const needsLookup = transactions.filter(tx => tx.type === 'deposit' && tx.status === 'failed'
    && (!tx.admin_deposit_diagnostic || ['unknown', 'reported'].includes(tx.admin_deposit_diagnostic.category)));
  const result = new Map(transactions.map(tx => [tx.id, transactionDepositDiagnostic(tx)]));
  if (!needsLookup.length) return result;

  const linked = await Deposit.find({ transaction_id: { $in: needsLookup.map(tx => tx.id) }, status: 'failed' })
    .select('transaction_id user_id provider initiation_status provider_status failure_reason callback_payload').lean();
  const byTransaction = new Map(linked.map(deposit => [deposit.transaction_id, deposit]));
  for (const tx of needsLookup) {
    const deposit = byTransaction.get(tx.id);
    if (deposit?.user_id !== tx.user_id) continue;
    result.set(tx.id, depositDiagnostic(deposit.provider, deposit.callback_payload, {
      reason: deposit.failure_reason || tx.failure_reason,
      status: deposit.provider_status || tx.status,
      initiationStatus: deposit.initiation_status
    }));
  }
  return result;
}

module.exports = { depositDiagnostic, transactionDepositDiagnostic, adminTransactionDiagnostics, isStrongerDiagnostic };
