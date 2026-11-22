const labels = {
  customer_funds: 'Insufficient M-Pesa funds', wrong_pin: 'Incorrect M-Pesa PIN', cancelled: 'Cancelled by customer',
  timed_out: 'Prompt timed out', not_delivered: 'Prompt did not reach the phone', delayed: 'Prompt delayed',
  customer_blocked: 'Customer blocked by provider', provider_blocked: 'Merchant restricted by provider',
  provider_funds: 'Insufficient provider wallet funds', invalid_phone: 'Invalid customer phone number',
  rate_limit: 'Provider rate limit', provider_error: 'Prompt rejected before reaching phone',
  reported: 'Provider reported a failure', unknown: 'Not completed on phone'
};

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
  const generic = /^(?:failed|error|payment failed(?: or was cancelled on the phone| on the phone)?\.?|the payment prompt was rejected\. please try again later\.|the payment request could not be confirmed\. check with support before retrying\.)$/i;
  const details = [...new Set(options.filter(value => !generic.test(value)))];
  const text = details.join(' ').toLowerCase();
  const rawCode = records.flatMap(row => [row.ResultCode, row.resultCode, row.errorCode, row.error_code, row.ResponseCode, row.responseCode, row.code])
    .find(value => (typeof value === 'number' || typeof value === 'string') && /^[\w.-]{1,32}$/.test(String(value)) && String(value) !== '0');
  const code = rawCode === undefined ? null : String(rawCode);
  const cancelled = [status, ...records.flatMap(row => [row.Status, row.status])]
    .some(value => typeof value === 'string' && /^cancelled$|^canceled$/i.test(value.trim()));
  let category;
  if (/insufficient|low balance|not enough|top.?up|required balance|balance too low|depleted|exhausted/.test(text)
    && /service (?:wallet|balance|token|credit)|merchant (?:wallet|account|balance)|(?:pay ?hero|nexus(?: ?pay)?) (?:wallet|balance|account|funds|tokens?)|stk (?:fees?|credits?)|prompt (?:fees?|credits?)|account (?:wallet|balance)|wallet balance|token balance|service tokens?/.test(text)) category = 'provider_funds';
  else if (/block|blacklist|restrict|suspend|too many (?:failed|unpaid|attempts|prompts)/.test(text) && /phone|number|customer|subscriber|recipient|msisdn|user|client|attempts|prompts|24 hours/.test(text)) category = 'customer_blocked';
  else if (/block|blacklist|restrict|suspend/.test(text) && /merchant|account|service|gateway/.test(text)) category = 'provider_blocked';
  else if (/(?:wrong|incorrect|invalid) (?:m.?pesa )?pin|pin (?:is )?(?:wrong|incorrect|invalid|entered incorrectly)|initiator information is invalid/.test(text)) category = 'wrong_pin';
  else if (/insufficient (?:funds|balance)|not enough (?:funds|balance)|balance (?:is )?(?:insufficient|too low)/.test(text)) category = effectiveStage === 'submission' ? 'reported' : 'customer_funds';
  else if (/not (?:delivered|received|sent|reach)|did not (?:reach|receive)|cannot be reached|could not be reached|delivery failed|unable to (?:deliver|reach)|subscriber (?:unreachable|unavailable)|phone (?:unreachable|switched off|off)|sim toolkit/.test(text)) category = 'not_delivered';
  else if (/cancel(?:led|ed)(?: by (?:user|customer|subscriber)| on the phone)|user cancel|request cancelled/.test(text)) category = 'cancelled';
  else if (/timed?\s*out|expired|no response from|could not (?:get|obtain) a response/.test(text)) category = 'timed_out';
  else if (/invalid (?:m.?pesa |customer )?(?:phone|mobile|subscriber|msisdn)|not registered/.test(text)) category = 'invalid_phone';
  else if (/rate limit|too many requests|throttl/.test(text) || httpStatus === 429) category = 'rate_limit';
  else if (/delay|still queued|already in process|unable to lock subscriber/.test(text) || code === '1001') category = 'delayed';
  else if (cancelled || code === '1032') category = 'cancelled';
  else if (code === '1037' || code === '1019') category = 'timed_out';
  else if (code === '2001') category = 'wrong_pin';
  else if (code === '1' && effectiveStage !== 'submission') category = 'customer_funds';
  else if (details.length) category = 'reported';
  else if (effectiveStage === 'submission' && ((httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) || initiationStatus === 'rejected')) category = 'provider_error';
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
    provider_error: 'Gateway rejected the STK push before reaching the phone (check provider wallet balance or blocked number).',
    unknown: normalizedProvider === 'nexuspay'
      ? 'Cancelled, wrong PIN, insufficient funds, or timed out (Nexus Pay status API omits the M-Pesa code).'
      : (normalizedProvider === 'payhero'
        ? 'Cancelled, wrong PIN, insufficient funds, or timed out (PayHero did not send a callback code for this record).'
        : 'Cancelled, wrong PIN, insufficient funds, or timed out.')
  };

  return { category, label: labels[category], provider: normalizedProvider,
    code, detail: details[0] || fallbackDetails[category] || null };
}

function transactionDepositDiagnostic(tx, now = Date.now()) {
  if (tx.type !== 'deposit' || !['failed', 'pending'].includes(tx.status)) return null;
  if (tx.admin_deposit_diagnostic && tx.admin_deposit_diagnostic.category !== 'unknown') return tx.admin_deposit_diagnostic;
  if (tx.status === 'failed') {
    const existingProvider = tx.admin_deposit_diagnostic?.provider || null;
    return depositDiagnostic(existingProvider, null, { reason: tx.failure_reason, status: 'failed' });
  }
  if (now - new Date(tx.created_at).getTime() >= 60 * 1000) return depositDiagnostic(null, null, { status: 'pending' });
  return null;
}

async function adminTransactionDiagnostics(Deposit, transactions) {
  const needsLookup = transactions.filter(tx => tx.type === 'deposit' && tx.status === 'failed'
    && (!tx.admin_deposit_diagnostic || tx.admin_deposit_diagnostic.category === 'unknown'));
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

module.exports = { depositDiagnostic, transactionDepositDiagnostic, adminTransactionDiagnostics };
