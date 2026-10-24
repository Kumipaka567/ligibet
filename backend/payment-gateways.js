const axios = require('axios');

const PROVIDERS = ['payhero', 'nexuspay'];
const error = (message, status = 502, definitive = false) => Object.assign(new Error(message), { status, definitive });
function phoneNumber(value) {
  let digits = String(value || '').replace(/[\s+().-]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) digits = '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) digits = '254' + digits;
  if (!/^254[17]\d{8}$/.test(digits)) throw error('Enter a valid M-Pesa phone number.', 400, true);
  return digits;
}
function money(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return NaN;
  return Math.round(Number(value) * 100) / 100;
}
function createPaymentGateways({ http = axios, env = process.env } = {}) {
  function authorization() {
    const token = env.PAYHERO_AUTH_TOKEN?.trim();
    if (token) return /^(Basic|Bearer) /i.test(token) ? token : `Basic ${token}`;
    if (env.PAYHERO_API_USERNAME && env.PAYHERO_API_PASSWORD) return 'Basic ' + Buffer.from(`${env.PAYHERO_API_USERNAME.trim()}:${env.PAYHERO_API_PASSWORD.trim()}`).toString('base64');
    return '';
  }
  const base = provider => String(provider === 'nexuspay' ? env.NEXUSPAY_BASE_URL || 'https://makamescopay.com/api' : env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke/api/v2').replace(/\/+$/, '');
  function configuration(provider) {
    if (!PROVIDERS.includes(provider)) throw error('Choose PayHero or Nexus Pay.', 400, true);
    const url = new URL(base(provider));
    if (url.protocol !== 'https:' || url.username || url.password) throw error('Payment gateway requires a valid HTTPS server URL.', 503, true);
    if (provider === 'payhero') {
      if (!authorization() || !Number.isSafeInteger(Number(env.PAYHERO_CHANNEL_ID)) || Number(env.PAYHERO_CHANNEL_ID) <= 0) throw error('PayHero has not been configured on the server.', 503, true);
    } else {
      if (!env.NEXUSPAY_API_KEY?.trim()) throw error('Nexus Pay has not been configured on the server.', 503, true);
      if (env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID && (!Number.isSafeInteger(Number(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID)) || Number(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID) <= 0)) throw error('Nexus Pay settlement account is invalid.', 503, true);
    }
    return { baseURL: base(provider) };
  }
  function available() {
    return PROVIDERS.map(id => {
      let configured = true;
      try { configuration(id); } catch { configured = false; }
      return { id, name: id === 'payhero' ? 'PayHero' : 'Nexus Pay', configured };
    });
  }
  function verified(deposit, result) {
    if (result.status !== 'completed') return result;
    if (!Number.isFinite(money(result.amount)) || money(result.amount) !== money(deposit.amount)) throw error('Payment amount could not be verified.');
    if (result.phone && phoneNumber(result.phone) !== phoneNumber(deposit.payer_phone)) throw error('Payment phone could not be verified.');
    if (typeof result.receipt !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(result.receipt.trim())) throw error('Payment receipt could not be verified.');
    return { ...result, amount: money(result.amount), receipt: result.receipt.trim().toUpperCase() };
  }
  function parsePayHero(deposit, raw) {
    const state = String(raw.status || raw.Status || raw.transaction_type || '').toLowerCase();
    const code = raw.ResultCode;
    const status = ['success', 'completed', 'complete', 'inbound_payment'].includes(state) || code === 0 || code === '0' ? 'completed'
      : ['failed', 'cancelled', 'canceled', 'rejected'].includes(state) || (code !== undefined && code !== null && String(code) !== '0') ? 'failed' : 'pending';
    return verified(deposit, { status, amount: raw.amount ?? raw.Amount, phone: raw.phone_number || raw.PhoneNumber,
      receipt: raw.provider_reference || raw.mpesa_reference || raw.MpesaReceiptNumber || raw.receipt,
      reason: raw.status_reason || raw.ResultDesc || 'Payment failed or was cancelled on the phone.', raw });
  }
  async function initiate(provider, deposit, customerName) {
    const { baseURL } = configuration(provider);
    let response;
    try {
      if (provider === 'nexuspay') {
        response = await http.post(`${baseURL}/payments/stkpush`, {
          phoneNumber: phoneNumber(deposit.payer_phone), amount: money(deposit.amount),
          accountReference: deposit.account_reference, transactionDesc: 'M-Pesa deposit',
          ...(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID ? { settlementAccountId: Number(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID) } : {}),
          ...(env.NEXUSPAY_TENANT_CODE?.trim() ? { tenantCode: env.NEXUSPAY_TENANT_CODE.trim() } : {})
        }, { headers: { 'X-API-Key': env.NEXUSPAY_API_KEY.trim(), 'Content-Type': 'application/json' }, timeout: 15000 });
        const data = response.data;
        if (data?.responseCode !== undefined && String(data.responseCode) !== '0') throw error('The payment prompt was rejected. Please try again later.', 502, true);
        if (typeof data?.checkoutRequestId !== 'string' || !data.checkoutRequestId.trim()) throw error('The payment request could not be confirmed. Check with support before retrying.');
        return { checkoutRequestId: data.checkoutRequestId, providerReference: String(data.transactionId ?? data.merchantRequestId ?? '') };
      }
      response = await http.post(`${baseURL}/payments`, {
        amount: money(deposit.amount), phone_number: phoneNumber(deposit.payer_phone), channel_id: Number(env.PAYHERO_CHANNEL_ID),
        provider: 'm-pesa', external_reference: deposit.external_reference, customer_name: customerName,
        ...(env.PAYHERO_CALLBACK_URL ? { callback_url: env.PAYHERO_CALLBACK_URL } : {})
      }, { headers: { Authorization: authorization(), 'Content-Type': 'application/json' }, timeout: 15000 });
      const data = response.data;
      if (!data || data.status === false || (data.ResponseCode !== undefined && String(data.ResponseCode) !== '0')) throw error('The payment prompt was rejected. Please try again later.', 502, true);
      if (data.status !== true && String(data.status).toLowerCase() !== 'success' && !data.CheckoutRequestID && !data.checkout_request_id && !data.reference && String(data.ResponseCode) !== '0') throw error('The payment request could not be confirmed. Check with support before retrying.');
      return { checkoutRequestId: data.CheckoutRequestID || data.checkout_request_id || deposit.external_reference,
        providerReference: String(data.reference ?? data.MerchantRequestID ?? '') };
    } catch (cause) {
      if (cause.definitive !== undefined) throw cause;
      const rejected = cause.response?.status >= 400 && cause.response.status < 500 && cause.response.status !== 408;
      throw error(rejected ? 'The payment prompt was rejected. Please try again later.' : 'The payment request could not be confirmed. Check with support before retrying.', 502, rejected);
    }
  }
  async function check(provider, deposit) {
    const { baseURL } = configuration(provider);
    if (provider === 'nexuspay') {
      if (!deposit.mpesa_checkout_request_id) return { status: 'pending' };
      const { data } = await http.get(`${baseURL}/payments/status/${encodeURIComponent(deposit.mpesa_checkout_request_id)}`, {
        headers: { 'X-API-Key': env.NEXUSPAY_API_KEY.trim() }, timeout: 8000
      });
      // The live API can omit the checkout ID despite the documented example.
      // The authenticated, request-specific URL identifies the payment; any
      // ID explicitly returned by the provider must still match that request.
      if (data?.checkoutRequestId !== undefined && data.checkoutRequestId !== deposit.mpesa_checkout_request_id) throw error('Payment request identity could not be verified.');
      if (!['pending', 'completed', 'failed', 'cancelled'].includes(data.status)) throw error('Payment status could not be verified.');
      if (data.status === 'completed' && !data.phoneNumber) throw error('Payment phone could not be verified.');
      return verified(deposit, { status: data.status, amount: data.amount, phone: data.phoneNumber,
        receipt: data.mpesaReceiptNumber, reason: data.status === 'cancelled' ? 'Payment cancelled on the phone.' : 'Payment failed on the phone.', raw: data });
    }
    const { data } = await http.get(`${baseURL}/transactions`, { headers: { Authorization: authorization() }, timeout: 8000 });
    const rows = data?.response || data?.transactions || (Array.isArray(data) ? data : []);
    const references = new Set([deposit.external_reference, deposit.mpesa_checkout_request_id].filter(Boolean));
    const match = Array.isArray(rows) && rows.find(row => [row.external_reference, row.ExternalReference, row.CheckoutRequestID, row.checkout_request_id].some(ref => references.has(ref)));
    // Amount/phone/time alone cannot identify a payment safely.
    return match ? parsePayHero(deposit, match) : { status: 'pending' };
  }
  return { available, configuration, initiate, check, parsePayHero, verified };
}
module.exports = { PROVIDERS, createPaymentGateways, phoneNumber, money, error };
