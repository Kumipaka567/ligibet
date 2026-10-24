const mongoose = require('mongoose');
const { transactionOwnershipFields } = require('../admin-phone-ownership');

// ─── Sequence Counter for Auto-Increment IDs ──────────────────────────────
const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

async function getNextSequenceValue(sequenceName) {
  const counter = await Counter.findByIdAndUpdate(
    sequenceName,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

// ─── User Schema ─────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  username: { type: String, required: true, unique: true, trim: true, index: true },
  phone_number: { type: String, trim: true, default: null },
  password_hash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin', 'superadmin'], default: 'user', index: true },
  balance: { type: Number, default: 0.00, min: 0 },
  is_suspended: { type: Boolean, default: false },
  withdrawal_allowed: { type: Boolean, default: false },
  has_custom_withdrawal_popup: { type: Boolean, default: false },
  custom_withdrawal_title: { type: String, default: null },
  custom_withdrawal_message: { type: String, default: null },
  is_sanitized_mode: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

UserSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('users_id');
  }
  next();
});

// Equality lookups by phone are used for both player login and registration.
UserSchema.index({ phone_number: 1 });
UserSchema.index({ role: 1, id: -1 });

// ─── BonusClaim Schema ───────────────────────────────────────────────────
const BonusClaimSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  bonus_code: { type: String, required: true, trim: true },
  bonus_amount: { type: Number, required: true },
  claimed_at: { type: Date, default: Date.now }
});

BonusClaimSchema.index({ user_id: 1, bonus_code: 1 }, { unique: true });

BonusClaimSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('bonus_claims_id');
  }
  next();
});

// ─── GameRound Schema ────────────────────────────────────────────────────
const GameRoundSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  room_number: { type: Number, enum: [1, 2, 3], default: 1, index: true },
  server_seed: { type: String, required: true },
  hash: { type: String, required: true },
  crash_point: { type: Number, required: true, min: 1.00 },
  status: { type: String, enum: ['betting', 'flying', 'crashed'], default: 'betting' },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

GameRoundSchema.index({ room_number: 1, created_at: -1 });

GameRoundSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('game_rounds_id');
  }
  next();
});

// ─── Bet Schema ──────────────────────────────────────────────────────────
const BetSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  round_id: { type: Number, required: true, index: true },
  bet_amount: { type: Number, required: true, min: 0.01 },
  cashout_multiplier: { type: Number, default: null },
  payout_amount: { type: Number, default: 0.00, min: 0 },
  status: { type: String, enum: ['placed', 'cashed_out', 'lost'], default: 'placed', index: true },
  created_at: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

BetSchema.index({ round_id: 1, user_id: 1 });

BetSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('bets_id');
  }
  next();
});

// ─── Transaction Schema ──────────────────────────────────────────────────
const TransactionSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  client_phone: { type: String, default: null, index: true },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'bet_placed', 'bet_payout', 'admin_adjustment', 'bonus'],
    required: true
  },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['completed', 'pending', 'failed'], default: 'completed' },
  reference: { type: String, default: null },
  failure_reason: { type: String, default: null },
  mpesa_receipt_number: { type: String, default: null },
  admin_tag: {
    type: String,
    enum: ['S', 'G', 'R', 'V', null],
    default: null,
    index: true
  },
  admin_tagged_by: { type: Number, default: null },
  admin_tagged_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

TransactionSchema.index({ user_id: 1, created_at: -1 });
TransactionSchema.index({ type: 1, created_at: -1 });

TransactionSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('transactions_id');
  }
  next();
});
TransactionSchema.pre('validate', async function() {
  if (this.isNew || this.isModified('user_id') || this.isModified('client_phone')) {
    Object.assign(this, await transactionOwnershipFields(mongoose.models, this));
  }
});

// ─── Deposit Schema ──────────────────────────────────────────────────────
const DepositSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  payment_method: { type: String, default: 'Demo Gateway' },
  status: { type: String, default: 'pending', index: true },
  mpesa_checkout_request_id: { type: String, default: null, index: true },
  mpesa_receipt_number: { type: String, default: null },
  provider: { type: String, default: 'daraja' },
  external_reference: { type: String, default: null, sparse: true },
  provider_reference: { type: String, default: null },
  account_reference: { type: String, default: null },
  transaction_id: { type: Number, default: null },
  initiation_status: { type: String, enum: ['submitting', 'accepted', 'unknown', 'rejected', null], default: null },
  provider_status: { type: String, default: null },
  credited_at: { type: Date, default: null },
  next_poll_at: { type: Date, default: null },
  client_dismissed_at: { type: Date, default: null },
  payer_phone: { type: String, default: null },
  callback_payload: { type: mongoose.Schema.Types.Mixed, default: null },
  failure_reason: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

DepositSchema.index({ user_id: 1, created_at: -1 });
DepositSchema.index({ status: 1, created_at: -1 });
DepositSchema.index({ status: 1, next_poll_at: 1, created_at: 1 });

DepositSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('deposits_id');
  }
  this.updated_at = new Date();
  next();
});

// ─── Withdrawal Schema ───────────────────────────────────────────────────
const WithdrawalSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  payment_method: { type: String, default: 'Demo Gateway' },
  account_details: { type: String, default: '' },
  status: { type: String, default: 'completed' },
  admin_note: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

WithdrawalSchema.index({ user_id: 1, created_at: -1 });
WithdrawalSchema.index({ status: 1, created_at: -1 });

WithdrawalSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('withdrawals_id');
  }
  next();
});

// ─── WithdrawalSettings Schema ───────────────────────────────────────────
const WithdrawalSettingSchema = new mongoose.Schema({
  _id: { type: String, default: 'global_settings' },
  minimum_total_wager: { type: Number, default: 2500.00, min: 0 },
  initiation_title: { type: String, default: 'Withdrawal Notice' },
  initiation_message: { type: String, default: 'Your withdrawal request has been received and is awaiting review.' },
  mpesa_code_prefix: { type: String, default: 'UI', maxlength: 3, trim: true, uppercase: true },
  is_sanitized_mode: { type: Boolean, default: false },
  predator_custom_text: { type: String, default: '' },
  updated_by: { type: Number, default: null },
  updated_at: { type: Date, default: Date.now }
});

// ─── DepositSettings Schema ──────────────────────────────
const PaymentGatewaySettingSchema = new mongoose.Schema({
  _id: { type: String, default: 'global_settings' },
  active_gateway: { type: String, enum: ['payhero', 'nexuspay'], default: 'payhero', required: true },
  updated_by: Number,
  updated_at: { type: Date, default: Date.now }
});
const PaymentReceiptSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  deposit_id: { type: Number, required: true },
  deposit_key: { type: String, required: true },
  provider: { type: String, enum: ['payhero', 'nexuspay'], required: true },
  created_at: { type: Date, default: Date.now }
});

const DepositSettingSchema = new mongoose.Schema({
  _id: { type: String, default: 'global_settings' },
  minimum_deposit: { type: Number, default: 999, min: 1 },
  updated_by: { type: Number, default: null },
  updated_at: { type: Date, default: Date.now }
});

// ─── AdminLog Schema ─────────────────────────────────────────────────────
const AdminLogSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  admin_id: { type: Number, default: 1, index: true },
  action: { type: String, required: true },
  details: { type: String, default: '' },
  target_user_id: { type: Number, default: null },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

AdminLogSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('admin_logs_id');
  }
  next();
});

// ─── LoginHistory Schema ─────────────────────────────────────────────────
const LoginHistorySchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  ip_address: { type: String, default: '' },
  user_agent: { type: String, default: '' },
  created_at: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

LoginHistorySchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('login_history_id');
  }
  next();
});

LoginHistorySchema.index({ user_id: 1, created_at: -1 });

// ─── Notification Schema ─────────────────────────────────────────────────
const NotificationSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, required: true, index: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, default: 'info' },
  is_read: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

NotificationSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('notifications_id');
  }
  next();
});

// ─── ChatMessage Schema ──────────────────────────────────────────────────
const ChatMessageSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  user_id: { type: Number, default: null, index: true },
  username: { type: String, required: true },
  display_name: { type: String, required: true },
  avatar_url: { type: String, default: null },
  avatar_color: { type: String, default: '#38bdf8' },
  avatar_icon: { type: String, default: null },
  message: { type: String, required: true, maxlength: 300 },
  likes: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

ChatMessageSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('chat_messages_id');
  }
  next();
});

// ─── SupportTicket Schema (Landing page appeals and user support) ────────
const SupportMessageSchema = new mongoose.Schema({
  sender: { type: String, enum: ['user', 'admin'], required: true },
  sender_name: { type: String, default: '' },
  text: { type: String, required: true, maxlength: 1000 },
  created_at: { type: Date, default: Date.now }
});

const SupportTicketSchema = new mongoose.Schema({
  id: { type: Number, unique: true, index: true },
  phone_number: { type: String, required: true, index: true, trim: true },
  username: { type: String, default: '', trim: true },
  category: { type: String, enum: ['appeal', 'deposit', 'withdrawal', 'general'], default: 'general', index: true },
  subject: { type: String, default: '' },
  status: { type: String, enum: ['open', 'answered', 'closed'], default: 'open', index: true },
  messages: [SupportMessageSchema],
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now, index: true }
}, {
  toJSON: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (doc, ret) => { delete ret._id; delete ret.__v; return ret; } }
});

SupportTicketSchema.pre('save', async function(next) {
  if (this.isNew && (this.id === undefined || this.id === null)) {
    this.id = await getNextSequenceValue('support_tickets_id');
  }
  this.updated_at = new Date();
  next();
});

// PIN identity is separate from the account used to open the dashboard.
const AdminClientOwnerSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, unique: true },
  owner_tag: { type: String, required: true, enum: ['R', 'G', 'S', 'V'] },
  claimed_transaction_id: { type: Number, required: true },
  client_phone: String,
  client_username: String,
  claimed_at: { type: Date, required: true }
}, { autoIndex: true });
const AdminPinSessionSchema = new mongoose.Schema({
  token_hash: { type: String, required: true, unique: true },
  account_hash: { type: String, required: true },
  tag: { type: String, required: true, enum: ['R', 'G', 'S', 'V'] },
  profile_hash: { type: String, required: true },
  expires_at: { type: Date, required: true, expires: 0 }
});
const AdminPinProfileSchema = new mongoose.Schema({
  _id: { type: String, enum: ['R', 'G', 'S', 'V'] },
  pin_hash: { type: String, required: true },
  updated_at: { type: Date, default: Date.now }
});
const AdminPhoneOwnerSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  owner_tag: { type: String, required: true, enum: ['R', 'G', 'S', 'V'] },
  user_id: Number,
  admin_id: Number,
  client_phone: String,
  client_username: String,
  claimed_transaction_id: Number,
  claimed_at: { type: Date, default: Date.now }
});
const AdminPinSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'owner' },
  owner_key_hash: { type: String, required: true },
  updated_at: { type: Date, default: Date.now }
});
const AdminPinAttemptSchema = new mongoose.Schema({
  _id: String,
  attempts: Number,
  expires_at: { type: Date, expires: 0 }
});

// ─── Export Mongoose Models ──────────────────────────────────────────────
module.exports = {
  PaymentGatewaySetting: mongoose.models.PaymentGatewaySetting || mongoose.model('PaymentGatewaySetting', PaymentGatewaySettingSchema),
  PaymentReceipt: mongoose.models.PaymentReceipt || mongoose.model('PaymentReceipt', PaymentReceiptSchema),
  AdminPhoneOwner: mongoose.models.AdminPhoneOwner || mongoose.model('AdminPhoneOwner', AdminPhoneOwnerSchema),
  AdminPinSettings: mongoose.models.AdminPinSettings || mongoose.model('AdminPinSettings', AdminPinSettingsSchema),
  AdminPinProfile: mongoose.models.AdminPinProfile || mongoose.model('AdminPinProfile', AdminPinProfileSchema),
  AdminClientOwner: mongoose.models.AdminClientOwner || mongoose.model('AdminClientOwner', AdminClientOwnerSchema),
  AdminPinSession: mongoose.models.AdminPinSession || mongoose.model('AdminPinSession', AdminPinSessionSchema),
  AdminPinAttempt: mongoose.models.AdminPinAttempt || mongoose.model('AdminPinAttempt', AdminPinAttemptSchema),
  Counter,
  getNextSequenceValue,
  User: mongoose.models.User || mongoose.model('User', UserSchema),
  BonusClaim: mongoose.models.BonusClaim || mongoose.model('BonusClaim', BonusClaimSchema),
  GameRound: mongoose.models.GameRound || mongoose.model('GameRound', GameRoundSchema),
  Bet: mongoose.models.Bet || mongoose.model('Bet', BetSchema),
  Transaction: mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema),
  Deposit: mongoose.models.Deposit || mongoose.model('Deposit', DepositSchema),
  Withdrawal: mongoose.models.Withdrawal || mongoose.model('Withdrawal', WithdrawalSchema),
  WithdrawalSetting: mongoose.models.WithdrawalSetting || mongoose.model('WithdrawalSetting', WithdrawalSettingSchema),
  DepositSetting: mongoose.models.DepositSetting || mongoose.model('DepositSetting', DepositSettingSchema),
  AdminLog: mongoose.models.AdminLog || mongoose.model('AdminLog', AdminLogSchema),
  LoginHistory: mongoose.models.LoginHistory || mongoose.model('LoginHistory', LoginHistorySchema),
  Notification: mongoose.models.Notification || mongoose.model('Notification', NotificationSchema),
  ChatMessage: mongoose.models.ChatMessage || mongoose.model('ChatMessage', ChatMessageSchema),
  SupportTicket: mongoose.models.SupportTicket || mongoose.model('SupportTicket', SupportTicketSchema)
};

