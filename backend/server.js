const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const dns = require('dns');
try { dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']); } catch (e) {}

const express = require('express');
const fs = require('fs');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const axios = require('axios');

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Do not leave requests hanging in Mongoose's operation buffer when Atlas is
// unavailable. API routes below return an explicit 503 until the connection is
// ready instead.
mongoose.set('bufferCommands', false);

const {
  User,
  BonusClaim,
  GameRound,
  Bet,
  Transaction,
  Deposit,
  Withdrawal,
  WithdrawalSetting,
  DepositSetting,
  AdminLog,
  LoginHistory,
  Notification,
  ChatMessage,
  Counter
} = require('./models');

// Collected by the checks below and reported by /healthz. Declared here so the
// constants that follow can refuse to fall back to an unsafe default.
const startupConfigurationErrors = [];

let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    const message = 'JWT_SECRET is not set. Refusing to start with a default signing key in production.';
    startupConfigurationErrors.push(message);
    console.error(`FATAL: ${message}`);
  } else {
    JWT_SECRET = 'ligibet-local-development-secret-jwt-key-min-32-chars-safe';
    console.warn('⚠️ WARNING: JWT_SECRET not set in environment. Using default local development secret. Set a strong JWT_SECRET in production.');
  }
} else if (JWT_SECRET.length < 32 && process.env.NODE_ENV === 'production') {
  const message = 'JWT_SECRET is shorter than 32 characters. Use a long random value.';
  startupConfigurationErrors.push(message);
  console.error(`FATAL: ${message}`);
}

const PORT = process.env.PORT || 3000;
const PROVABLY_FAIR_CLIENT_SEED = '00000000000000000004d93766699d799042bd8f4f2203798cfe3e9d89280d0d';

// ---------- PAYHERO STK CONFIG (.env) ----------
const PAYHERO_BASE_URL    = process.env.PAYHERO_BASE_URL    || 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_AUTH_TOKEN  = process.env.PAYHERO_AUTH_TOKEN;
const PAYHERO_API_USERNAME = process.env.PAYHERO_API_USERNAME;
const PAYHERO_API_PASSWORD = process.env.PAYHERO_API_PASSWORD;
const PAYHERO_CHANNEL_ID = process.env.PAYHERO_CHANNEL_ID;
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL;
const PAYHERO_CALLBACK_TOKEN = process.env.PAYHERO_CALLBACK_TOKEN;

// ---------- MONGODB CONNECTION ----------
let observedUserCount = null;

function describeMongoUri(uri) {
  try {
    const [base] = String(uri).split('?');
    const url = new URL(base.replace(/^mongodb\+srv:/, 'mongodb:'));
    return { host: url.host, database: (url.pathname || '').replace(/^\//, '') || null };
  } catch (e) {
    return { host: null, database: null };
  }
}

function getEffectiveMongoUri() {
  const uri = (process.env.MONGODB_URI || '').trim();

  if (!uri) {
    if (process.env.NODE_ENV === 'production') {
      startupConfigurationErrors.push('MONGODB_URI is not set.');
      console.error('FATAL: MONGODB_URI is not set. Refusing to guess a database — set it in the environment.');
    } else {
      console.warn('⚠️ MONGODB_URI is not set. Server will allow local login with in-memory fallback until URI is provided.');
    }
    return '';
  }

  const { database } = describeMongoUri(uri);
  if (!database && process.env.NODE_ENV === 'production') {
    const message = 'MONGODB_URI has no database name. Add it before the "?" — for example .../test?retryWrites=true';
    startupConfigurationErrors.push(message);
    console.error(`FATAL: ${message}`);
  }

  return uri;
}

const MONGODB_URI = getEffectiveMongoUri();
const MONGODB_TARGET = describeMongoUri(MONGODB_URI);
const defaultCorsOrigins = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://ligibet.site',
  'https://www.ligibet.site',
  'https://*.vercel.app'
];
const envCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const configuredCorsOrigins = Array.from(new Set([...defaultCorsOrigins, ...envCorsOrigins]));

const allowedCorsOrigins = new Set(configuredCorsOrigins.filter(origin => !origin.includes('*')));
const allowedCorsPatterns = configuredCorsOrigins
  .filter(origin => origin.includes('*'))
  .map(origin => new RegExp('^' + origin.split('*').map(escapeRegExp).join('[a-z0-9-]+') + '$', 'i'));

const isAllowedCorsOrigin = origin => {
  if (!origin) return true;
  if (allowedCorsOrigins.has(origin)) return true;
  if (allowedCorsPatterns.some(pattern => pattern.test(origin))) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
};

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected; API requests will return 503 until it reconnects.');
});
mongoose.connection.on('reconnected', () => {
  console.log('MongoDB reconnected.');
});
mongoose.connection.on('error', (err) => {
  console.error(`MongoDB connection error: ${err.message}`);
});

// ---------- EXPRESS APP SETUP ----------
const app = express();

// Render's load balancer and Cloudflare both sit in front of this app. Express
// defaults to trust proxy = false, which makes req.ip the *proxy's* address —
// the same value for every visitor on the deployed site. The rate limiters below
// key on that, so without this the entire user base shares one bucket and a
// couple of dozen signups per minute lock out everybody. Locally there is no
// proxy, req.ip is the real client, and the fault is invisible.
app.set('trust proxy', true);

app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedCorsOrigin(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

app.get('/healthz', (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  const healthy = databaseConnected && startupConfigurationErrors.length === 0;
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'unavailable',
    database: databaseConnected ? 'connected' : 'disconnected',
    configuration: startupConfigurationErrors.length === 0 ? 'valid' : 'invalid',
    // Which database this process is actually serving. Two clusters both had a
    // "test" database, so the name alone is not enough to tell them apart —
    // the host is the part that makes drift visible without a login attempt.
    cluster: MONGODB_TARGET.host,
    databaseName: mongoose.connection.name || MONGODB_TARGET.database,
    userCount: observedUserCount,
    errors: startupConfigurationErrors.length ? startupConfigurationErrors : undefined
  });
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '50kb' }));

const distPath = fs.existsSync(path.join(__dirname, '../frontend/dist/frontend/browser'))
  ? path.join(__dirname, '../frontend/dist/frontend/browser')
  : path.join(__dirname, '../frontend/dist/frontend');
app.use(express.static(distPath));

// In-memory user table for local development when MongoDB is not connected
const localDevUsers = new Map();
const localDefaultAdmin = {
  id: 1,
  username: 'admin',
  phone_number: '+254792011285',
  password_hash: bcrypt.hashSync('SuperAdmin@2026', 10),
  role: 'superadmin',
  balance: 10000.00,
  bonus_claimed: false,
  is_suspended: false
};
localDevUsers.set('admin', localDefaultAdmin);
localDevUsers.set('+254792011285', localDefaultAdmin);
localDevUsers.set('0792011285', localDefaultAdmin);
localDevUsers.set('254792011285', localDefaultAdmin);

function findLocalDevUser(identifier) {
  if (!identifier) return null;
  const vars = generatePhoneVariations(String(identifier));
  for (const v of vars) {
    if (localDevUsers.has(v)) return localDevUsers.get(v);
  }
  return null;
}

// Authentication and wallet writes must fail clearly while MongoDB reconnects.
// In local development, auth requests are allowed through to support local login.
function requireDatabase(req, res, next) {
  if (mongoose.connection.readyState !== 1 && mongoose.connection.readyState !== 2) {
    if (process.env.NODE_ENV !== 'production' && req.path.startsWith('/auth')) {
      return next();
    }
    return res.status(503).json({ error: 'Database is temporarily unavailable. Please try again shortly.' });
  }
  return next();
}

app.use('/api', requireDatabase);

// ---------- RATE LIMITER ----------
function rateLimit(maxRequests = 30, windowMs = 60000) {
  const map = new Map();
  return (req, res, next) => {
    // Cloudflare rewrites CF-Connecting-IP on every request, so unlike a
    // forged X-Forwarded-For entry it cannot be spoofed by the caller.
    const ip = req.headers['cf-connecting-ip'] || req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = map.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 1;
      entry.resetAt = now + windowMs;
    } else {
      entry.count++;
    }
    map.set(ip, entry);

    // Now that buckets are keyed per real client rather than per proxy, the map
    // grows with every distinct visitor. Drop expired entries as we go.
    if (map.size > 5000) {
      for (const [key, value] of map) {
        if (now > value.resetAt) map.delete(key);
      }
    }

    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedCorsOrigin(origin)),
    methods: ['GET', 'POST'],
    credentials: true
  }
});
const adminNamespace = io.of('/admin');

// ---------- REAL-TIME EMIT HELPERS ----------
function realtimeLog(message, details = null) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[${new Date().toISOString()}] [REALTIME] ${message}${suffix}`);
}

function emitRealtimeMutation({
  action,
  userId = null,
  balance,
  transaction = null,
  deposits = false,
  withdrawals = false,
  user = false,
  dashboard = true,
  notifyPlayer = true
}) {
  const payload = {
    action,
    userId,
    occurredAt: new Date().toISOString()
  };

  if (userId && notifyPlayer) {
    const numBal = Number(balance);
    if (Number.isFinite(numBal)) {
      const walletPayload = { ...payload, balance: numBal };
      io.to(`user_${userId}`).emit('balance_update', { balance: numBal });
      io.to(`user_${userId}`).emit('balance_updated', { balance: numBal });
      io.to(`user_${userId}`).emit('balance', { balance: numBal });
      io.to(`user_${userId}`).emit('wallet_updated', walletPayload);
      io.to(`user_${String(userId)}`).emit('balance_update', { balance: numBal });
      io.to(`user_${String(userId)}`).emit('balance_updated', { balance: numBal });
      io.to(`user_${String(userId)}`).emit('wallet_updated', walletPayload);
    }
    io.to(`user_${userId}`).emit('transactions_updated', payload);
    io.to(`user_${userId}`).emit('user_updated', payload);
    if (transaction) io.to(`user_${userId}`).emit('transactions_updated', payload);
    if (deposits) io.to(`user_${userId}`).emit('deposits_updated', payload);
    if (withdrawals) io.to(`user_${userId}`).emit('withdrawals_updated', payload);
    if (user) io.to(`user_${userId}`).emit('user_updated', payload);
  }

  if (transaction) {
    adminNamespace.emit('admin_transaction_update', transaction);
    adminNamespace.emit('transactions_updated', payload);
  }
  if (Number.isFinite(Number(balance))) {
    adminNamespace.emit('wallet_updated', { ...payload, balance: Number(balance) });
  }
  if (deposits) adminNamespace.emit('deposits_updated', payload);
  if (withdrawals) adminNamespace.emit('withdrawals_updated', payload);
  if (user) adminNamespace.emit('user_updated', payload);
  if (dashboard) adminNamespace.emit('dashboard_stats_updated', payload);
  adminNamespace.emit('activity_updated', payload);
}

// ---------- SETTINGS HELPERS ----------
const DEFAULT_MINIMUM_TOTAL_WAGER = 2500.00;
const DEFAULT_WITHDRAWAL_INITIATION_TITLE = 'Withdrawal Notice';
const DEFAULT_WITHDRAWAL_INITIATION_MESSAGE = 'Your withdrawal request has been received and is awaiting review.';

const DEFAULT_MINIMUM_DEPOSIT = 999;
const MINIMUM_DEPOSIT_TTL_MS = 30000;

// The STK endpoint is on the hot deposit path, so the minimum is served from
// memory and refreshed in the background. Admin writes update the cache inline,
// which makes a change visible immediately on this instance.
let cachedMinimumDeposit = DEFAULT_MINIMUM_DEPOSIT;
let minimumDepositLoadedAt = 0;
let minimumDepositRefreshing = null;

function refreshMinimumDeposit() {
  if (minimumDepositRefreshing) return minimumDepositRefreshing;
  minimumDepositRefreshing = DepositSetting.findById('global_settings').lean()
    .then((doc) => {
      const value = Number(doc && doc.minimum_deposit);
      if (Number.isFinite(value) && value > 0) cachedMinimumDeposit = value;
      minimumDepositLoadedAt = Date.now();
      return cachedMinimumDeposit;
    })
    .catch((err) => {
      console.warn('refreshMinimumDeposit error:', err.message);
      return cachedMinimumDeposit;
    })
    .finally(() => { minimumDepositRefreshing = null; });
  return minimumDepositRefreshing;
}

// Synchronous read: never blocks a deposit on a database round trip.
function getMinimumDeposit() {
  if (Date.now() - minimumDepositLoadedAt > MINIMUM_DEPOSIT_TTL_MS) refreshMinimumDeposit();
  return cachedMinimumDeposit;
}

function setCachedMinimumDeposit(value) {
  const amount = Number(value);
  if (Number.isFinite(amount) && amount > 0) {
    cachedMinimumDeposit = amount;
    minimumDepositLoadedAt = Date.now();
  }
}

async function getWithdrawalSettings() {
  try {
    let settings = await WithdrawalSetting.findById('global_settings').lean();
    if (!settings) {
      settings = await WithdrawalSetting.create({
        _id: 'global_settings',
        minimum_total_wager: DEFAULT_MINIMUM_TOTAL_WAGER,
        initiation_title: DEFAULT_WITHDRAWAL_INITIATION_TITLE,
        initiation_message: DEFAULT_WITHDRAWAL_INITIATION_MESSAGE
      });
    }
    return {
      minimumTotalWager: settings.minimum_total_wager ?? DEFAULT_MINIMUM_TOTAL_WAGER,
      initiationTitle: settings.initiation_title || DEFAULT_WITHDRAWAL_INITIATION_TITLE,
      initiationMessage: settings.initiation_message || DEFAULT_WITHDRAWAL_INITIATION_MESSAGE,
      isSanitizedMode: Boolean(settings.is_sanitized_mode)
    };
  } catch (err) {
    return {
      minimumTotalWager: DEFAULT_MINIMUM_TOTAL_WAGER,
      initiationTitle: DEFAULT_WITHDRAWAL_INITIATION_TITLE,
      initiationMessage: DEFAULT_WITHDRAWAL_INITIATION_MESSAGE,
      isSanitizedMode: false
    };
  }
}

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatePhoneVariations(input) {
  if (!input || typeof input !== 'string') return [];
  const raw = input.trim();
  if (!raw) return [];

  const set = new Set();
  set.add(raw);
  set.add(raw.toLowerCase());

  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned) {
    set.add(cleaned);
    const countryCodes = ['+254', '+255', '+256', '+234', '+27'];
    for (const cc of countryCodes) {
      const digitsNoPlus = cc.replace('+', '');
      if (cleaned.startsWith(cc)) {
        const rest = cleaned.slice(cc.length).replace(/^0+/, '');
        set.add(`${cc}${rest}`);
        set.add(`0${rest}`);
        set.add(rest);
      } else if (cleaned.startsWith(digitsNoPlus)) {
        const rest = cleaned.slice(digitsNoPlus.length).replace(/^0+/, '');
        set.add(`+${digitsNoPlus}${rest}`);
        set.add(`0${rest}`);
        set.add(rest);
      }
    }

    if (cleaned.startsWith('0') && cleaned.length >= 10) {
      const localRest = cleaned.replace(/^0+/, '');
      set.add(`+254${localRest}`);
      set.add(localRest);
      set.add(`0${localRest}`);
    } else if (!cleaned.startsWith('+') && !cleaned.startsWith('0') && cleaned.length >= 9 && /^\d+$/.test(cleaned)) {
      set.add(`+254${cleaned}`);
      set.add(`0${cleaned}`);
      set.add(cleaned);
    }
  }

  return Array.from(set);
}

// Provably Fair Crash Generator using HMAC-SHA256
function generateProvablyFairRound() {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHmac('sha256', serverSeed).update(PROVABLY_FAIR_CLIENT_SEED).digest('hex');
  
  const subHash = hash.substring(0, 13);
  const hashInt = parseInt(subHash, 16);
  const e = Math.pow(2, 52);
  
  let rawPoint = (e * 100 - hashInt) / (e - hashInt);
  rawPoint = rawPoint * 0.97 / 100;
  
  const crashPoint = Math.max(1.00, Math.floor(rawPoint * 100) / 100);
  return { serverSeed, crashPoint, hash };
}

function buildTokenPayload(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role || 'user'
  };
}

function buildPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    phone_number: user.phone_number,
    balance: parseFloat(user.balance || 0) || 0.00,
    role: user.role || 'user',
    bonus_claimed: Boolean(user.bonus_claimed)
  };
}

function isAdminRole(role) {
  const r = String(role || '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}

function isSuperAdmin(role) {
  return String(role || '').toLowerCase() === 'superadmin';
}

// ---------- JWT MIDDLEWARE ----------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

async function authenticateAdminToken(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      let user = null;
      if (mongoose.connection.readyState === 1) {
        user = await User.findOne({
          $or: [
            { id: req.user?.id },
            { username: req.user?.username }
          ]
        }).lean();
      } else if (process.env.NODE_ENV !== 'production') {
        user = findLocalDevUser(req.user?.username) || (isAdminRole(req.user?.role) ? req.user : null);
      }

      if (!user || !isAdminRole(user.role)) {
        return res.status(403).json({ error: 'Admin privileges required' });
      }
      if (user.is_suspended) {
        return res.status(403).json({ error: 'Admin account is suspended' });
      }
      req.user.id = user.id || req.user?.id || 1;
      req.user.username = user.username || req.user?.username || 'admin';
      req.user.role = user.role;
      next();
    } catch (err) {
      console.error('authenticateAdminToken verification error:', err);
      return res.status(500).json({ error: 'Authorization verification failed' });
    }
  });
}

async function authenticateSuperAdminToken(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      let user = null;
      if (mongoose.connection.readyState === 1) {
        user = await User.findOne({
          $or: [
            { id: req.user?.id },
            { username: req.user?.username }
          ]
        }).lean();
      } else if (process.env.NODE_ENV !== 'production') {
        user = findLocalDevUser(req.user?.username) || (isSuperAdmin(req.user?.role) ? req.user : null);
      }

      if (!user || !isSuperAdmin(user.role)) {
        return res.status(403).json({ error: 'Superadmin privileges required' });
      }
      if (user.is_suspended) {
        return res.status(403).json({ error: 'Superadmin account is suspended' });
      }
      req.user.id = user.id || req.user?.id || 1;
      req.user.username = user.username || req.user?.username || 'superadmin';
      req.user.role = user.role;
      next();
    } catch (err) {
      console.error('authenticateSuperAdminToken verification error:', err);
      return res.status(500).json({ error: 'Authorization verification failed' });
    }
  });
}

// ---------- AUTH REST APIS ----------

// 1. Register
app.post('/api/auth/register', rateLimit(60, 60000), async (req, res) => {
  try {
    const { username, phone_number, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Phone number/username and password are required' });
    }

    const trimmedUsername = String(username).trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 50) {
      return res.status(400).json({ error: 'Phone number/username must be between 3 and 50 characters' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const usernameVars = generatePhoneVariations(trimmedUsername);
    const phoneVars = phone_number ? generatePhoneVariations(phone_number) : [];
    const allVars = Array.from(new Set([...usernameVars, ...phoneVars]));

    if (mongoose.connection.readyState === 1) {
      const existingUser = await User.findOne({
        $or: [
          { username: { $in: allVars } },
          { phone_number: { $in: allVars } }
        ]
      }).lean();

      if (existingUser) {
        return res.status(400).json({ error: 'Account with this phone number or username already exists' });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      const primaryPhone = phoneVars.find(v => v.startsWith('+')) || (phone_number ? phone_number.trim() : trimmedUsername);
      const primaryUsername = usernameVars.find(v => v.startsWith('+')) || trimmedUsername;

      const user = new User({
        username: primaryUsername,
        phone_number: primaryPhone,
        password_hash: passwordHash,
        balance: 0.00,
        role: 'user'
      });
      await user.save();

      const token = jwt.sign(buildTokenPayload(user), JWT_SECRET, { expiresIn: '7d' });
      emitRealtimeMutation({ action: 'user_registered', userId: user.id, user: true });

      return res.status(201).json({
        message: 'Registration successful',
        token,
        user: buildPublicUser(user)
      });
    } else if (process.env.NODE_ENV !== 'production') {
      const localExisting = findLocalDevUser(trimmedUsername) || (phone_number ? findLocalDevUser(phone_number) : null);
      if (localExisting) {
        return res.status(400).json({ error: 'Account with this phone number or username already exists' });
      }
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      const primaryPhone = phoneVars.find(v => v.startsWith('+')) || (phone_number ? phone_number.trim() : trimmedUsername);
      const newLocalUser = {
        id: localDevUsers.size + 1,
        username: trimmedUsername,
        phone_number: primaryPhone,
        password_hash: passwordHash,
        balance: 0.00,
        role: 'user',
        bonus_claimed: false,
        is_suspended: false
      };
      localDevUsers.set(trimmedUsername, newLocalUser);
      localDevUsers.set(primaryPhone, newLocalUser);
      const token = jwt.sign(buildTokenPayload(newLocalUser), JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({
        message: 'Registration successful',
        token,
        user: buildPublicUser(newLocalUser)
      });
    }

    return res.status(503).json({ error: 'Database is temporarily unavailable. Please try again shortly.' });
  } catch (err) {
    console.error('Registration Error:', err);
    return res.status(500).json({ error: 'Internal server error during registration' });
  }
});

// 2. Login
app.post('/api/auth/login', rateLimit(120, 60000), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Phone number/username and password are required' });
    }

    let user = null;

    if (mongoose.connection.readyState === 1) {
      const vars = generatePhoneVariations(String(username));
      user = await User.findOne({
        $or: [
          { username: { $in: vars } },
          { phone_number: { $in: vars } }
        ]
      }).lean();
    } else if (process.env.NODE_ENV !== 'production') {
      user = findLocalDevUser(username);
    } else {
      return res.status(503).json({ error: 'Database is temporarily unavailable. Please try again shortly.' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid phone number/username or password' });
    }
    if (user.is_suspended) {
      return res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid phone number/username or password' });
    }

    if (mongoose.connection.readyState === 1) {
      const bonusClaim = await BonusClaim.findOne({ user_id: user.id, bonus_code: 'welcome_3500' }).lean();
      user.bonus_claimed = Boolean(bonusClaim);

      LoginHistory.create({
        user_id: user.id,
        ip_address: req.ip || req.socket.remoteAddress || '127.0.0.1',
        user_agent: req.headers['user-agent'] || 'Unknown'
      }).catch(err => console.warn('Login history record error:', err.message));
    }

    const token = jwt.sign(buildTokenPayload(user), JWT_SECRET, { expiresIn: '7d' });

    return res.json({
      message: 'Login successful',
      token,
      user: buildPublicUser(user)
    });
  } catch (err) {
    console.error('Login Error:', err);
    return res.status(500).json({ error: 'Internal server error during login' });
  }
});

// 3. Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone_number, new_password } = req.body;
    if (!phone_number || !new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'Valid phone number and new password (min 6 chars) required' });
    }

    const vars = generatePhoneVariations(String(phone_number));
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(new_password, salt);

    if (mongoose.connection.readyState === 1) {
      const user = await User.findOneAndUpdate(
        {
          $or: [
            { username: { $in: vars.map(v => new RegExp(`^${escapeRegExp(v)}$`, 'i')) } },
            { phone_number: { $in: vars } }
          ]
        },
        { $set: { password_hash: passwordHash } },
        { new: true }
      );

      if (!user) return res.status(404).json({ error: 'Account not found with provided phone number' });

      emitRealtimeMutation({ action: 'password_reset', userId: user.id, user: true, dashboard: false });
      return res.json({ message: 'Password reset successful' });
    } else if (process.env.NODE_ENV !== 'production') {
      const user = findLocalDevUser(phone_number);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      user.password_hash = passwordHash;
      return res.json({ message: 'Password reset successful' });
    }

    return res.status(503).json({ error: 'Database is temporarily unavailable' });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error during password reset' });
  }
});

// 4. Me
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    let user = null;
    if (mongoose.connection.readyState === 1) {
      user = await User.findOne({ id: req.user.id }).lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      const bonusClaim = await BonusClaim.findOne({ user_id: user.id, bonus_code: 'welcome_3500' }).lean();
      user.bonus_claimed = Boolean(bonusClaim);
    } else if (process.env.NODE_ENV !== 'production') {
      user = findLocalDevUser(req.user.username) || {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role || 'user',
        balance: 10000.00
      };
    } else {
      return res.status(503).json({ error: 'Database is temporarily unavailable' });
    }

    return res.json({ user: buildPublicUser(user) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// 4b. Claim Welcome Bonus
app.post([
  '/api/auth/claim-welcome-bonus',
  '/api/bonus/claim',
  '/api/bonus/welcome',
  '/api/user/claim-bonus'
], authenticateToken, async (req, res) => {
  try {
    const bonusCode = 'welcome_3500';
    const bonusAmount = 3500.00;

    const currentUser = await User.findOne({ id: req.user.id }).lean();
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const existingClaim = await BonusClaim.findOne({ user_id: req.user.id, bonus_code: bonusCode }).lean();
    if (existingClaim) {
      return res.json({
        message: `Your KES ${bonusAmount.toLocaleString()} welcome bonus is active on your account.`,
        balance: currentUser.balance || 0,
        bonusClaimed: true,
        notification: {
          id: Date.now(),
          title: 'Bonus Active',
          message: `KES ${bonusAmount.toLocaleString()} welcome bonus is active in your wallet balance.`,
          type: 'bonus',
          createdAt: new Date().toISOString()
        }
      });
    }

    // The wallet balance right now is the only thing that qualifies a player.
    //
    // This previously also let anyone through who had ever completed a deposit
    // of 2,000 or more, so a player who deposited once and then spent it all
    // could still claim on an empty wallet — which made the requirement look
    // like it applied to nobody. No history bypass and no role bypass.
    const MIN_BONUS_BALANCE = 2000;
    const currentBalance = Number(currentUser.balance || 0);
    if (currentBalance < MIN_BONUS_BALANCE) {
      return res.status(400).json({
        error: `You need a wallet balance of at least KES ${MIN_BONUS_BALANCE.toLocaleString()} to claim this bonus. `
          + `Your balance is KES ${roundToMoney(currentBalance).toLocaleString()}.`
      });
    }

    // Re-check the balance as part of the write. Reading it and then crediting
    // in a separate step leaves a window where two requests both pass the check.
    const user = await User.findOneAndUpdate(
      { id: req.user.id, balance: { $gte: MIN_BONUS_BALANCE } },
      { $inc: { balance: bonusAmount } },
      { new: true }
    );
    if (!user) {
      const stillExists = await User.findOne({ id: req.user.id }, 'id').lean();
      if (!stillExists) return res.status(404).json({ error: 'User not found' });
      return res.status(400).json({
        error: `You need a wallet balance of at least KES ${MIN_BONUS_BALANCE.toLocaleString()} to claim this bonus.`
      });
    }

    await BonusClaim.create({
      user_id: req.user.id,
      bonus_code: bonusCode,
      bonus_amount: bonusAmount
    });

    const tx = await Transaction.create({
      user_id: req.user.id,
      type: 'bonus',
      amount: bonusAmount,
      status: 'completed',
      reference: `BONUS-${bonusCode.toUpperCase()}`
    });

    const notif = await Notification.create({
      user_id: req.user.id,
      title: 'Welcome Bonus Credited!',
      message: `KES ${bonusAmount.toLocaleString()} has been added to your wallet balance. Enjoy playing Aviator!`,
      type: 'bonus'
    });

    emitRealtimeMutation({
      action: 'welcome_bonus_claimed',
      userId: req.user.id,
      balance: user.balance,
      transaction: tx,
      deposits: true
    });

    return res.json({
      message: `Congratulations! KES ${bonusAmount.toLocaleString()} welcome bonus has been credited to your account.`,
      balance: user.balance,
      bonusClaimed: true,
      notification: {
        id: notif.id,
        title: notif.title,
        message: notif.message,
        type: 'bonus',
        createdAt: notif.created_at
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      const user = await User.findOne({ id: req.user.id }).lean();
      return res.json({
        message: 'Your KES 3,500 welcome bonus is active on your account.',
        balance: user ? user.balance : 0,
        bonusClaimed: true,
        notification: {
          id: Date.now(),
          title: 'Bonus Active',
          message: 'KES 3,500 welcome bonus is active in your wallet balance.',
          type: 'bonus',
          createdAt: new Date().toISOString()
        }
      });
    }
    return res.status(500).json({ error: 'Failed to claim welcome bonus' });
  }
});

// ---------- WALLET & USER PROFILE REST APIS ----------

// Balance
app.get('/api/wallet/balance', authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.id }, 'balance').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ balance: parseFloat(user.balance || 0) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Wallet Transactions
app.get('/api/wallet/transactions', authenticateToken, async (req, res) => {
  try {
    // Admin adjustments are an internal correction to the balance and must never
    // surface in a player's history. They used to be relabelled as a deposit or
    // withdrawal with a fabricated "DEP-" reference, which showed the player a
    // transaction that never happened. Excluded outright: the adjustment still
    // moves the balance, it simply is not a statement line.
    const transactions = await Transaction.find({
      user_id: req.user.id,
      type: { $ne: 'admin_adjustment' }
    }).sort({ created_at: -1 }).limit(50).lean();

    const bets = await Bet.find({ user_id: req.user.id })
      .sort({ created_at: -1 }).limit(50).lean();

    return res.json({
      transactions: transactions.map(t => ({
        id: t.id,
        type: t.type,
        amount: Math.abs(t.amount),
        status: t.status,
        reference: t.reference,
        created_at: t.created_at,
        failure_reason: t.failure_reason,
        mpesa_receipt_number: t.mpesa_receipt_number
      })),
      bets: bets.map(b => ({
        id: b.id,
        round_id: b.round_id,
        bet_amount: b.bet_amount,
        cashout_multiplier: b.cashout_multiplier,
        payout_amount: b.payout_amount,
        status: b.status,
        created_at: b.created_at
      }))
    });
  } catch (err) {
    console.error('Failed to fetch transaction history:', err);
    return res.status(500).json({ error: 'Failed to fetch transaction history' });
  }
});

// Deposits History
app.get('/api/wallet/deposits', authenticateToken, async (req, res) => {
  try {
    const deposits = await Deposit.find({
      user_id: req.user.id,
      status: { $ne: 'failed' }
    }).sort({ created_at: -1 }).limit(30).lean();

    return res.json({ deposits });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch deposit history' });
  }
});

// Submit Withdrawal
app.post(['/api/wallet/withdraw', '/api/payments/withdraw'], authenticateToken, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    const payment_method = req.body.payment_method || 'M-PESA';
    const account_details = req.body.phone || 'Registered payout account';

    if (isNaN(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is KES 10.00' });
    }

    const user = await User.findOne({ id: req.user.id }).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < amount) {
      const failedTx = await Transaction.create({
        user_id: req.user.id,
        type: 'withdrawal',
        amount,
        status: 'failed',
        reference: `WITHDRAW-FAILED-${Date.now()}`
      });

      emitRealtimeMutation({
        action: 'withdrawal_declined_insufficient_balance',
        userId: req.user.id,
        balance: user.balance,
        transaction: failedTx,
        withdrawals: true
      });
      const errorMsg = (user.balance || 0) <= 0
        ? 'Insufficient funds: Your balance is KES 0.00. Please deposit to your wallet before requesting a withdrawal.'
        : `Insufficient funds: Your balance is KES ${(user.balance || 0).toLocaleString()}. You requested KES ${amount.toLocaleString()}.`;
      return res.status(400).json({
        error: errorMsg,
        notification: {
          title: 'Insufficient Funds',
          message: errorMsg,
          type: 'rejected'
        }
      });
    }

    const isAdmin = user.role === 'admin' || user.role === 'superadmin';

    if (isAdmin) {
      // 1. Deduct balance from admin wallet immediately
      const newBalance = Math.max(0, parseFloat((user.balance - amount).toFixed(2)));
      await User.updateOne({ id: req.user.id }, { $set: { balance: newBalance } });

      // 2. Generate authentic 10-char M-Pesa receipt code
      const mpesaChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const rawPrefix = String(req.body.mpesaCodePrefix || 'LI8').trim().toUpperCase();
      const cleanPrefix = rawPrefix.slice(0, 3) || 'LI8';
      let adminMpesaCode = cleanPrefix;
      const remainingLength = Math.max(0, 10 - cleanPrefix.length);
      for (let i = 0; i < remainingLength; i++) {
        adminMpesaCode += mpesaChars.charAt(Math.floor(Math.random() * mpesaChars.length));
      }

      // 3. Create completed Withdrawal record
      const wd = await Withdrawal.create({
        user_id: req.user.id,
        amount,
        payment_method: 'M-Pesa Instant Payout',
        account_details: req.body.phone || user.phone_number || 'Admin M-PESA',
        status: 'completed',
        admin_note: 'Instant Admin M-PESA Payout'
      });

      // 4. Create completed Transaction record
      const tx = await Transaction.create({
        user_id: req.user.id,
        type: 'withdrawal',
        amount,
        status: 'completed',
        reference: adminMpesaCode,
        mpesa_receipt_number: adminMpesaCode
      });

      // 5. Emit real-time mutation and wallet update
      emitRealtimeMutation({
        action: 'withdrawal_completed',
        userId: req.user.id,
        balance: newBalance,
        transaction: tx,
        withdrawals: true,
        dashboard: true
      });
      io.to(`user_${req.user.id}`).emit('wallet:update', { balance: newBalance });

      // 6. Synchronize with MPESA App in BLABKA
      let mpesaMessage = null;
      let mpesaNewBalance = null;
      const targetPhone = req.body.phone || user.phone_number || '0792011285';

      try {
        const mpesaApiUrl = process.env.MPESA_API_URL || 'https://api.twoapp.site/api/v1/integrations/withdraw';
        const mpesaKey = process.env.MPESA_CONNECT_KEY || 'mpesa_connect_live_key';

        const mpesaRes = await axios.post(mpesaApiUrl, {
          app: 'ligibet',
          phone: targetPhone,
          adminPhone: targetPhone,
          amount,
          apiKey: mpesaKey,
          reference: adminMpesaCode,
          notes: 'Withdrawal payout from LIGIBET'
        }, { timeout: 4000 });

        if (mpesaRes.data && mpesaRes.data.success) {
          if (mpesaRes.data.smsReceipt) mpesaMessage = mpesaRes.data.smsReceipt;
          if (mpesaRes.data.newBalance !== undefined) mpesaNewBalance = mpesaRes.data.newBalance;
          console.log(`✅ [M-PESA SYNC] LigiBet admin withdrawal KES ${amount} credited to MPESA app (New balance: KES ${mpesaNewBalance})`);
        }
      } catch (syncErr) {
        console.warn('⚠️ [M-PESA SYNC] MPESA app sync error:', syncErr.response?.data || syncErr.message);
      }

      // 7. Fallback realistic M-PESA SMS text if integration was unreachable
      if (!mpesaMessage) {
        const now = new Date();
        const day = now.getDate();
        const month = now.getMonth() + 1;
        const year = String(now.getFullYear()).slice(-2);
        const dateStr = `${day}/${month}/${year}`;
        let hours = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const timeStr = `${hours}:${minutes} ${ampm}`;
        const formattedAmount = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const fallbackBal = mpesaNewBalance !== null
          ? Number(mpesaNewBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : (parseFloat(newBalance) + amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        mpesaMessage = `Congratulations! ${adminMpesaCode} confirmed.You have received Ksh${formattedAmount} from LIGIBET on ${dateStr} at ${timeStr}.New M-PESA balance is Ksh${fallbackBal}. Separate personal and business funds through Pochi la Biashara on *334#.`;
      }

      return res.json({
        success: true,
        message: 'Withdrawal has been submitted successfully. Please wait for an M-PESA message.',
        isAdmin: true,
        mpesaMessage,
        mpesaNewBalance,
        mpesaReceiptCode: adminMpesaCode,
        reference: adminMpesaCode,
        balance: newBalance,
        status: 'completed',
        notification: {
          title: 'Withdrawal Submitted',
          message: 'Withdrawal has been submitted successfully. Please wait for an M-PESA message.',
          type: 'success'
        },
        popup: {
          title: 'Withdrawal Submitted',
          message: 'Withdrawal has been submitted successfully. Please wait for an M-PESA message.',
          type: 'success'
        }
      });
    }

    // Regular Player Flow: Pending admin approval
    const globalSettings = await getWithdrawalSettings();
    const isCustomActive = Boolean(user.has_custom_withdrawal_popup && (user.custom_withdrawal_message || user.custom_withdrawal_title));
    const title = isCustomActive
      ? (user.custom_withdrawal_title || globalSettings.initiationTitle)
      : globalSettings.initiationTitle;

    const message = isCustomActive
      ? (user.custom_withdrawal_message || globalSettings.initiationMessage)
      : globalSettings.initiationMessage;

    const withdrawalStatus = 'pending';

    const wd = await Withdrawal.create({
      user_id: req.user.id,
      amount,
      payment_method,
      account_details,
      status: withdrawalStatus,
      admin_note: 'Pending admin review'
    });

    const tx = await Transaction.create({
      user_id: req.user.id,
      type: 'withdrawal',
      amount,
      status: withdrawalStatus,
      reference: `WITHDRAW-${wd.id}`
    });

    const notif = await Notification.create({
      user_id: req.user.id,
      title: title,
      message: message,
      type: 'pending'
    });

    emitRealtimeMutation({
      action: 'withdrawal_requested',
      userId: req.user.id,
      balance: user.balance,
      transaction: tx,
      withdrawals: true
    });

    const notificationPayload = {
      id: notif.id,
      title: title,
      message: message,
      type: 'pending',
      amount,
      status: withdrawalStatus,
      createdAt: notif.created_at
    };
    io.to(`user_${req.user.id}`).emit('withdrawal_notification', notificationPayload);

    return res.json({
      success: true,
      isAdmin: false,
      message: 'Withdrawal submitted and awaiting admin review',
      balance: user.balance,
      status: withdrawalStatus,
      notification: notificationPayload,
      popup: {
        title,
        message,
        type: 'pending'
      }
    });
  } catch (err) {
    console.error('Withdrawal error:', err.message);
    return res.status(500).json({ error: 'Withdrawal processing failed' });
  }
});

// Change Password
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const user = await User.findOne({ id: req.user.id });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect' });

    const salt = await bcrypt.genSalt(10);
    user.password_hash = await bcrypt.hash(newPassword, salt);
    await user.save();

    emitRealtimeMutation({ action: 'password_changed', userId: req.user.id, user: true, dashboard: false });
    return res.json({ message: 'Password changed successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update password' });
  }
});

// Change Username
app.post('/api/user/change-username', authenticateToken, async (req, res) => {
  try {
    const { newUsername } = req.body;
    if (!newUsername || newUsername.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }

    const trimmed = newUsername.trim();
    const existing = await User.findOne({ username: new RegExp(`^${escapeRegExp(trimmed)}$`, 'i'), id: { $ne: req.user.id } }).lean();
    if (existing) return res.status(400).json({ error: 'Username is already taken' });

    await User.updateOne({ id: req.user.id }, { $set: { username: trimmed } });
    emitRealtimeMutation({ action: 'profile_updated', userId: req.user.id, user: true });
    return res.json({ message: 'Username updated successfully', username: trimmed });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update username' });
  }
});

// User Sessions
app.get('/api/user/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await LoginHistory.find({ user_id: req.user.id })
      .sort({ created_at: -1 }).limit(20).lean();
    return res.json({ sessions });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

// ---------- PAYHERO M-PESA & DEPOSIT HELPERS ----------
async function completePendingMpesaDeposit(externalRef, amount, receiptNumber, callbackPayload, secondaryRef = null) {
  try {
    const deposit = await Deposit.findOne({
      $or: [
        { external_reference: externalRef },
        { mpesa_checkout_request_id: externalRef },
        ...(secondaryRef ? [{ external_reference: secondaryRef }, { mpesa_checkout_request_id: secondaryRef }] : [])
      ]
    });

    if (!deposit) return null;
    if (deposit.status === 'completed') return deposit;

    deposit.status = 'completed';
    deposit.amount = amount || deposit.amount;
    deposit.mpesa_receipt_number = receiptNumber || deposit.mpesa_receipt_number;
    deposit.callback_payload = callbackPayload;
    deposit.updated_at = new Date();
    await deposit.save();

    const user = await User.findOneAndUpdate(
      { id: deposit.user_id },
      { $inc: { balance: deposit.amount } },
      { new: true }
    );

    const tx = await Transaction.create({
      user_id: deposit.user_id,
      type: 'deposit',
      amount: deposit.amount,
      status: 'completed',
      reference: `MPESA-${receiptNumber || deposit.external_reference}`,
      mpesa_receipt_number: receiptNumber
    });

    emitRealtimeMutation({
      action: 'mpesa_deposit_completed',
      userId: deposit.user_id,
      balance: user?.balance,
      transaction: tx,
      deposits: true
    });

    return deposit;
  } catch (err) {
    console.error('completePendingMpesaDeposit error:', err.message);
    return null;
  }
}

async function failPendingMpesaDeposit(externalRef, failureReason, callbackPayload, secondaryRef = null) {
  try {
    const deposit = await Deposit.findOne({
      $or: [
        { external_reference: externalRef },
        { mpesa_checkout_request_id: externalRef },
        ...(secondaryRef ? [{ external_reference: secondaryRef }, { mpesa_checkout_request_id: secondaryRef }] : [])
      ]
    });

    if (!deposit || deposit.status === 'completed') return deposit;

    deposit.status = 'failed';
    deposit.failure_reason = failureReason || 'Transaction cancelled or failed';
    deposit.callback_payload = callbackPayload;
    deposit.updated_at = new Date();
    await deposit.save();

    const tx = await Transaction.create({
      user_id: deposit.user_id,
      type: 'deposit',
      amount: deposit.amount,
      status: 'failed',
      reference: deposit.external_reference || `DEP-${deposit.id}`,
      failure_reason: deposit.failure_reason
    });

    emitRealtimeMutation({
      action: 'mpesa_deposit_failed',
      userId: deposit.user_id,
      transaction: tx,
      deposits: true,
      dashboard: true
    });

    return deposit;
  } catch (err) {
    console.error('failPendingMpesaDeposit error:', err.message);
    return null;
  }
}

async function reopenProcessingMpesaDeposits() {
  try {
    await Deposit.updateMany(
      { status: 'processing' },
      { $set: { status: 'pending', updated_at: new Date() } }
    );
  } catch (err) {
    console.warn('reopenProcessingMpesaDeposits error:', err.message);
  }
}

async function reconcilePendingMpesaDeposits() {
  try {
    // Safaricom STK Push prompts expire on the handset after 30 seconds
    const thirtyFiveSecAgo = new Date(Date.now() - 35 * 1000);
    const timedOutDeposits = await Deposit.find({
      status: 'pending',
      created_at: { $lt: thirtyFiveSecAgo }
    });

    for (const dep of timedOutDeposits) {
      dep.status = 'failed';
      dep.failure_reason = 'STK prompt timed out or cancelled on phone';
      dep.updated_at = new Date();
      await dep.save();

      const tx = await Transaction.create({
        user_id: dep.user_id,
        type: 'deposit',
        amount: dep.amount,
        status: 'failed',
        reference: dep.external_reference || `DEP-${dep.id}`,
        failure_reason: 'STK prompt timed out or cancelled on phone'
      });

      emitRealtimeMutation({
        action: 'mpesa_deposit_failed',
        userId: dep.user_id,
        transaction: tx,
        deposits: true,
        dashboard: true
      });
    }
  } catch (err) {
    console.warn('reconcilePendingMpesaDeposits error:', err.message);
  }
}

// ---------- DEPOSIT PROMPT COOLDOWN ----------
// PayHero throttles, and eventually blocks, merchants whose STK prompts keep
// going unanswered. A player stuck in a failing loop will tap Deposit over and
// over, and the penalty lands on the merchant account — which means on every
// other player at the same time.
//
// The streak is read back off the deposit records rather than tracked as the
// deposits happen. That keeps this entirely outside the deposit flow: nothing
// here hooks into how a deposit is created, completed or failed, so it cannot
// change what happens to a payment. It also means the count survives a restart
// and that a completed deposit clears the streak on its own, because the run of
// failures is no longer unbroken.
const DEPOSIT_COOLDOWN_STREAK = 3;             // consecutive failed prompts
const DEPOSIT_COOLDOWN_MS = 10 * 60 * 1000;    // lockout length

async function getDepositCooldown(userId) {
  const recent = await Deposit.find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(DEPOSIT_COOLDOWN_STREAK)
    .select('status created_at updated_at')
    .lean();

  // Fewer attempts than the streak, or anything in them that is not a failure
  // — a completed deposit, or one still in flight — means no unbroken run.
  if (recent.length < DEPOSIT_COOLDOWN_STREAK) return null;
  if (!recent.every(deposit => deposit.status === 'failed')) return null;

  // The clock runs from when the most recent prompt actually failed, not from
  // when it was requested; those are minutes apart for a prompt that sat
  // unanswered. Once it has run out the player is free again, and a further
  // failure starts a fresh lockout because it becomes the newest of three.
  const lastFailedAt = new Date(recent[0].updated_at || recent[0].created_at).getTime();
  const cooldownUntil = lastFailedAt + DEPOSIT_COOLDOWN_MS;
  const remainingMs = cooldownUntil - Date.now();
  if (remainingMs <= 0) return null;

  return { cooldownUntil, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

// Read-only. The deposit screen polls this so the player sees the countdown
// instead of discovering the lockout by being refused.
app.get(['/api/mpesa/cooldown', '/api/payments/cooldown'], authenticateToken, async (req, res) => {
  try {
    const cooldown = await getDepositCooldown(req.user.id);
    if (!cooldown) return res.json({ inCooldown: false });
    return res.json({ inCooldown: true, ...cooldown });
  } catch (err) {
    // Never let this decide anything on failure: report "not in cooldown" and
    // let the deposit endpoint be the authority.
    return res.json({ inCooldown: false });
  }
});

// PayHero & M-Pesa STK Push
app.post([
  '/api/payhero/stkpush',
  '/api/payhero/stk-push',
  '/api/mpesa/stkpush',
  '/api/mpesa/stk-push',
  '/api/wallet/mpesa/stkpush',
  '/api/wallet/mpesa/stk-push'
], authenticateToken, async (req, res) => {
  try {
    // Refuse ahead of the deposit flow, before anything is created or sent.
    // Everything below this point is unchanged.
    const cooldown = await getDepositCooldown(req.user.id);
    if (cooldown) {
      const minutes = Math.ceil(cooldown.retryAfterSeconds / 60);
      return res.status(429).json({
        error: `Too many deposit prompts went uncompleted. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        code: 'RATE_LIMIT_COOLDOWN',
        cooldownUntil: cooldown.cooldownUntil,
        retryAfterSeconds: cooldown.retryAfterSeconds
      });
    }

    const { amount, phone } = req.body;
    const numAmount = Math.round(parseFloat(amount));
    const minimumDeposit = getMinimumDeposit();
    if (isNaN(numAmount) || numAmount < minimumDeposit) {
      return res.status(400).json({ error: `Minimum deposit amount is KES ${minimumDeposit.toFixed(2)}` });
    }
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const cleanPhone = phone.replace(/[^\d+]/g, '');
    const formattedPhone = cleanPhone.startsWith('+') 
      ? cleanPhone.slice(1) 
      : (cleanPhone.startsWith('0') ? `254${cleanPhone.slice(1)}` : (cleanPhone.startsWith('254') ? cleanPhone : `254${cleanPhone}`));

    const checkoutRequestId = `LIGI-DEP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const deposit = await Deposit.create({
      user_id: req.user.id,
      amount: numAmount,
      payment_method: 'M-Pesa STK Push',
      status: 'pending',
      mpesa_checkout_request_id: checkoutRequestId,
      external_reference: checkoutRequestId,
      payer_phone: formattedPhone,
      provider: 'payhero'
    });

    const channelId = parseInt(process.env.PAYHERO_CHANNEL_ID || PAYHERO_CHANNEL_ID, 10);
    const authToken = process.env.PAYHERO_AUTH_TOKEN || PAYHERO_AUTH_TOKEN;
    const apiUser = process.env.PAYHERO_API_USERNAME || PAYHERO_API_USERNAME;
    const apiPass = process.env.PAYHERO_API_PASSWORD || PAYHERO_API_PASSWORD;

    let authHeader = null;
    if (authToken && authToken.trim()) {
      const cleanToken = authToken.trim();
      authHeader = (cleanToken.startsWith('Basic ') || cleanToken.startsWith('Bearer '))
        ? cleanToken
        : `Basic ${cleanToken}`;
    } else if (apiUser && apiPass) {
      authHeader = `Basic ${Buffer.from(`${apiUser.trim()}:${apiPass.trim()}`).toString('base64')}`;
    }

    if (authHeader && !isNaN(channelId)) {
      try {
        const payheroRes = await axios.post(`${PAYHERO_BASE_URL}/payments`, {
          amount: numAmount,
          phone_number: formattedPhone,
          channel_id: channelId,
          provider: 'm-pesa',
          external_reference: checkoutRequestId,
          customer_name: req.user?.username || 'LigiBet Customer',
          callback_url: process.env.PAYHERO_CALLBACK_URL || PAYHERO_CALLBACK_URL
        }, {
          headers: { 
            Authorization: authHeader,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });

        if (payheroRes.data?.CheckoutRequestID) {
          deposit.mpesa_checkout_request_id = payheroRes.data.CheckoutRequestID;
          await deposit.save();
        }

        return res.json({
          success: true,
          message: 'STK push prompt sent to your phone. Enter your M-Pesa PIN to complete payment.',
          checkoutRequestId,
          providerResponse: payheroRes.data
        });
      } catch (apiErr) {
        console.warn('PayHero API call response:', apiErr.response?.data || apiErr.message);
      }
    }

    return res.json({
      success: true,
      message: 'STK push prompt initialized. Enter PIN on your phone.',
      checkoutRequestId
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to initiate M-Pesa deposit' });
  }
});

// Anyone on the internet can POST to the callback route below, and that route
// credits wallets — a forged "Success" payload is free money. PAYHERO_CALLBACK_TOKEN
// is the shared secret that separates PayHero's callbacks from everyone else's.
//
// It is only enforced when set, so configuring it is a deliberate step rather
// than something that silently starts rejecting a working integration. Set it
// here and append "?token=<value>" to PAYHERO_CALLBACK_URL, or have PayHero send
// it as a bearer token.
function isAuthenticPayHeroCallback(req) {
  if (!PAYHERO_CALLBACK_TOKEN) return true;

  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const supplied = header || String(req.query.token || '').trim();
  if (!supplied) return false;

  // Compare in constant time: a plain === leaks the token one character at a
  // time to anyone willing to measure the response.
  const expected = Buffer.from(PAYHERO_CALLBACK_TOKEN);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// PayHero STK Callback (Handles exact PayHero nested response format)
app.post(['/api/payhero/callback', '/api/mpesa/callback'], async (req, res) => {
  try {
    if (!isAuthenticPayHeroCallback(req)) {
      console.warn(`Rejected M-Pesa callback with a missing or wrong token from ${req.ip}.`);
      return res.status(401).json({ status: false, message: 'Unauthorized' });
    }

    const payload = req.body || {};
    const resp = payload.response || payload;
    const ref = resp.ExternalReference || resp.external_reference || resp.CheckoutRequestID || resp.checkout_request_id || resp.MerchantRequestID || payload.external_reference || payload.CheckoutRequestID;
    const isSuccess = (resp.Status === 'Success' || resp.Status === 'SUCCESS' || resp.status === 'Success' || resp.status === 'SUCCESS' || resp.ResultCode === 0 || resp.ResultCode === '0') && (payload.status !== false);
    const amount = parseFloat(resp.Amount || resp.amount || payload.Amount || payload.amount || 0);
    const receipt = resp.MpesaReceiptNumber || resp.mpesa_reference || resp.receipt || payload.MpesaReceiptNumber || payload.mpesa_reference;
    const failureReason = resp.ResultDesc || resp.status_reason || resp.Status || 'Payment failed or was cancelled';

    if (ref) {
      if (isSuccess) {
        await completePendingMpesaDeposit(ref, amount, receipt, payload);
      } else {
        await failPendingMpesaDeposit(ref, failureReason, payload);
      }
    }
    return res.status(200).json({ status: true, message: 'Callback processed' });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Callback error' });
  }
});

async function queryPayHeroTransactionStatus(deposit) {
  const authToken = process.env.PAYHERO_AUTH_TOKEN || PAYHERO_AUTH_TOKEN;
  const apiUser = process.env.PAYHERO_API_USERNAME || PAYHERO_API_USERNAME;
  const apiPass = process.env.PAYHERO_API_PASSWORD || PAYHERO_API_PASSWORD;

  let authHeader = null;
  if (authToken && authToken.trim()) {
    const cleanToken = authToken.trim();
    authHeader = (cleanToken.startsWith('Basic ') || cleanToken.startsWith('Bearer ')) ? cleanToken : `Basic ${cleanToken}`;
  } else if (apiUser && apiPass) {
    authHeader = `Basic ${Buffer.from(`${apiUser.trim()}:${apiPass.trim()}`).toString('base64')}`;
  }

  if (!authHeader) return null;

  const externalRef = deposit.external_reference || deposit.mpesa_checkout_request_id;
  const checkoutRequestId = deposit.mpesa_checkout_request_id;
  const phoneSuffix = deposit.payer_phone ? deposit.payer_phone.slice(-9) : '';
  const depCreatedTime = new Date(deposit.created_at).getTime();

  try {
    const res = await axios.get(`${PAYHERO_BASE_URL}/transactions`, {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      timeout: 5000
    });

    const list = res.data?.response || res.data?.transactions || (Array.isArray(res.data) ? res.data : []);
    if (Array.isArray(list) && list.length > 0) {
      for (const t of list) {
        // Strict match on external reference or checkout request ID
        const refMatch = (
          (t.external_reference && (t.external_reference === externalRef || t.external_reference === checkoutRequestId)) ||
          (t.ExternalReference && (t.ExternalReference === externalRef || t.ExternalReference === checkoutRequestId)) ||
          (t.CheckoutRequestID && (t.CheckoutRequestID === checkoutRequestId || t.CheckoutRequestID === externalRef)) ||
          (t.checkout_request_id && (t.checkout_request_id === checkoutRequestId || t.checkout_request_id === externalRef))
        );

        if (refMatch) return t;

        // Or fresh inbound payment created strictly AFTER this deposit was requested
        if (t.transaction_type === 'inbound_payment' && Math.abs(parseFloat(t.amount) - deposit.amount) < 0.01) {
          const txTime = t.created_at ? new Date(t.created_at).getTime() : 0;
          if (txTime >= (depCreatedTime - 2000)) {
            const phoneMatches = phoneSuffix && t.description && t.description.includes(phoneSuffix);
            if (phoneMatches) {
              const receipt = t.provider_reference || t.mpesa_reference;
              if (receipt) {
                const existing = await Deposit.findOne({ mpesa_receipt_number: receipt, status: 'completed' });
                if (!existing) return t;
              } else {
                return t;
              }
            }
          }
        }
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

// STK Status Check with Instant PayHero Verification & 35s Handset Timeout
app.post(['/api/payhero/stk-status', '/api/mpesa/stk-status'], authenticateToken, async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;
    if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId required' });

    let deposit = await Deposit.findOne({
      user_id: req.user.id,
      $or: [{ mpesa_checkout_request_id: checkoutRequestId }, { external_reference: checkoutRequestId }]
    });

    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

    // Instant status inquiry to PayHero if still pending
    if (deposit.status === 'pending') {
      const payheroData = await queryPayHeroTransactionStatus(deposit);
      if (payheroData) {
        const pStatus = String(payheroData.status || payheroData.Status || payheroData.transaction_type || '').toLowerCase();
        const isSuccess = pStatus === 'success' || pStatus === 'completed' || pStatus === 'complete' || pStatus === 'inbound_payment' || payheroData.ResultCode === 0;
        const isFailed = pStatus === 'failed' || pStatus === 'cancelled' || pStatus === 'canceled' || pStatus === 'rejected' || (payheroData.ResultCode && payheroData.ResultCode !== 0);
        const receipt = payheroData.provider_reference || payheroData.mpesa_reference || payheroData.MpesaReceiptNumber || payheroData.receipt || null;
        const amount = parseFloat(payheroData.amount || payheroData.Amount || deposit.amount);

        if (isSuccess) {
          deposit = await completePendingMpesaDeposit(checkoutRequestId, amount, receipt, payheroData);
        } else if (isFailed) {
          deposit = await failPendingMpesaDeposit(checkoutRequestId, payheroData.status_reason || payheroData.ResultDesc || 'Payment failed or was cancelled on phone', payheroData);
        }
      } else {
        // If 35 seconds elapsed since STK was sent and no payment made, fail immediately (Safaricom STK timeout)
        const elapsedMs = Date.now() - new Date(deposit.created_at).getTime();
        if (elapsedMs > 35000) {
          deposit = await failPendingMpesaDeposit(checkoutRequestId, 'STK prompt timed out or was cancelled on phone');
        }
      }
    }

    const user = await User.findOne({ id: req.user.id }, 'balance').lean();
    return res.json({
      status: deposit.status,
      receiptNumber: deposit.mpesa_receipt_number || null,
      balance: deposit.status === 'completed' ? user?.balance : undefined,
      failure_reason: deposit.failure_reason || null
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check status' });
  }
});

// Cancel Pending STK
app.post(['/api/payhero/cancel-pending', '/api/mpesa/cancel-pending'], authenticateToken, async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;
    if (checkoutRequestId) {
      const deposit = await Deposit.findOneAndUpdate(
        { user_id: req.user.id, $or: [{ mpesa_checkout_request_id: checkoutRequestId }, { external_reference: checkoutRequestId }], status: 'pending' },
        { $set: { status: 'failed', failure_reason: 'Cancelled by user', updated_at: new Date() } },
        { new: true }
      );
      if (deposit) {
        const tx = await Transaction.create({
          user_id: deposit.user_id,
          type: 'deposit',
          amount: deposit.amount,
          status: 'failed',
          reference: deposit.external_reference || `DEP-${deposit.id}`,
          failure_reason: 'Cancelled by user'
        });
        emitRealtimeMutation({
          action: 'mpesa_deposit_failed',
          userId: deposit.user_id,
          transaction: tx,
          deposits: true,
          dashboard: true
        });
      }
    }
    return res.json({ success: true, message: 'Pending STK request cancelled' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to cancel STK' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAT SERVICE & SIMULATOR ENGINE (SPRIBE / BETIKA REAL-TIME CHAT)
// ═══════════════════════════════════════════════════════════════════════════

const CHAT_AVATARS = [
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23d8b4a0"/><circle cx="50" cy="46" r="28" fill="%23f8fafc"/><circle cx="40" cy="42" r="4" fill="%231e293b"/><circle cx="60" cy="42" r="4" fill="%231e293b"/><ellipse cx="50" cy="56" rx="10" ry="6" fill="%230f172a"/><path d="M30 84c0-14 9-20 20-20s20 6 20 20z" fill="%23334155"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%231e293b"/><circle cx="50" cy="40" r="22" fill="%23334155"/><path d="M18 90c0-18 14-26 32-26s32 8 32 26z" fill="%230f172a"/><circle cx="50" cy="38" r="14" fill="%23475569"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23606c38"/><circle cx="50" cy="48" r="26" fill="%23854d0e"/><circle cx="50" cy="52" r="18" fill="%23fef08a"/><circle cx="42" cy="46" r="4" fill="%23000"/><circle cx="58" cy="46" r="4" fill="%23000"/><ellipse cx="50" cy="58" rx="6" ry="3" fill="%23000"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23dc2626"/><circle cx="50" cy="50" r="32" fill="%23f8fafc"/><circle cx="50" cy="50" r="22" fill="%23b91c1c"/><circle cx="50" cy="50" r="12" fill="%23f8fafc"/><circle cx="50" cy="50" r="6" fill="%237f1d1d"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%232d6a4f"/><path d="M42 22l6 14v16h-14c-4 0-6-3-6-6v-18c0-3 3-6 6-6h8z" fill="%23d8f3dc"/><path d="M48 36h22c4 0 8 3 8 8v16c0 4-4 8-8 8H48z" fill="%23b7e4c7"/><path d="M28 72c0-12 10-18 22-18s22 6 22 18z" fill="%231b4332"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%2318181b"/><rect x="25" y="25" width="8" height="50" fill="%23f59e0b"/><rect x="40" y="18" width="8" height="64" fill="%23ef4444"/><rect x="55" y="28" width="8" height="44" fill="%233b82f6"/><rect x="70" y="35" width="8" height="30" fill="%2310b981"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%237c3aed"/><circle cx="50" cy="42" r="22" fill="%23ede9fe"/><circle cx="43" cy="40" r="3.5" fill="%234c1d95"/><circle cx="57" cy="40" r="3.5" fill="%234c1d95"/><path d="M25 86c0-14 12-22 25-22s25 8 25 22z" fill="%235b21b6"/></svg>',
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%230284c7"/><circle cx="50" cy="42" r="22" fill="%23e0f2fe"/><circle cx="43" cy="40" r="3.5" fill="%230369a1"/><circle cx="57" cy="40" r="3.5" fill="%230369a1"/><path d="M25 86c0-14 12-22 25-22s25 8 25 22z" fill="%23075985"/></svg>'
];

const CHAT_USER_COLORS = [
  '#38bdf8', '#f472b6', '#c084fc', '#60a5fa', '#e879f9', '#fb923c', '#4ade80'
];

function maskPhoneNumberForChat(phone) {
  if (!phone) return '2***' + Math.floor(Math.random() * 10);
  const clean = String(phone).replace(/[^\d]/g, '');
  if (clean.length >= 10) {
    const first = clean.startsWith('254') ? '2' : (clean.startsWith('0') ? '2' : clean[0]);
    const last = clean[clean.length - 1];
    return `${first}***${last}`;
  }
  return `${clean.slice(0, 1)}***${clean.slice(-1)}`;
}

async function userHasChatBalance(userId) {
  if (!userId) return false;
  try {
    const user = await User.findOne({ id: userId }).lean();
    if (!user) return false;

    // Chat access is restricted for anyone with wallet balance below 1000 KES
    return (Number(user.balance) || 0) >= 1000;
  } catch (err) {
    return false;
  }
}

// In-memory cache of recent 120 messages for instant high-speed delivery
const recentChatMessages = [];

const REALISTIC_KENYAN_CHAT_MESSAGES = [
  "Surely",
  "Watu wameona hiyo 24.8x? Nimekula 12,000 safi",
  "Cashed out at 5.2x! Weekend sorted",
  "Hii 100x ilikuwa kali sana! Who caught it?",
  "KES 25,000 imeland kwa M-Pesa saa hii!!",
  "Toa mapema bro, 2.0x inatosha leo usikue greedy",
  "Leo nimepata mtaji yangu yote back plus profit",
  "Nilikaa ngumu mpaka 8.0x nikatoa 16k",
  "Hii round inaenda mbali sana trust me",
  "Odd kubwa inakuja sasa hivi, round 3 zilizopita zilikuwa low",
  "Wait for round after this one, pattern ya pink odds inaingia",
  "Wasiwasi ya nini weka tu KES 100 auto cashout 2.0x",
  "Imetoka mapema 1.05x wueh",
  "Nani ako ready for the next flight?",
  "Game iko na form leo usiku",
  "Patience pays in this game guys",
  "Tumshukuru huyu admin wa tips nimewin 45k leo",
  "Hawa watu wa tips wanasaidia kweli ama?",
  "Mimi I use my own strategy 2x na 3x tu",
  "Deposit imeingia in 3 seconds, nice!",
  "Ngoja round tatu kwanza ndio uweke stake kubwa",
  "Bro rule number one: don't be greedy",
  "Leo niko na 15k profit, nimefunga biashara ya leo",
  "Nice flight!",
  "Boom!!",
  "Hapo sawa",
  "Let's gooo",
  "Wazi bro",
  "Kwani mnakula pesa hivi",
  "Safe landing!",
  "Round hii ni yetu",
  "Acha ndege iruke juu",
  "Wueh leo Aviator inalipa safi sana",
  "Nani mwingine ametoa kwa 15x?",
  "Bana niliogopa nikatoka 1.90x ingeenda 30x",
  "Kesho tutakula tena mtaji ipo",
  "Admin ongeza odds za juu usiku huu",
  "Hii game inataka nidhamu tu, ukikula toka",
  "Nani anajua bot ya Aviator signals?",
  "Tumia akili usitumie tamaa utashinda tu",
  "Withdrawal yangu ya 10k imeingia instant kwa M-Pesa",
  "Hapa leo hakuna kulala!",
  "Keep flying high Aviator",
  "Niliweka 1000 nikatoka 2.85x safi sana",
  "Bora uhai kesho game iko tena",
  "Hii ndege imepanda juu kama rocket",
  "KES 3,800 imeingia instant kwa simu",
  "Discipline ndio siri ya hii game",
  "Nani ako na tips za kesho asubuhi?",
  "Hapo sawa kabisa, safi sana!",
  "Nimekula 8k kwa 1.50x auto cashout",
  "Usishike stress, weka stake ndogo ndogo",
  "Round hii inaenda 50x mark my words",
  "Tuko pamoja bro, leo ni kushinda tu"
];

function generateSimulatedChatMessage() {
  const lastDigits = [1, 0, 9, 4, 2, 5, 7, 3, 8];
  const lastDigit = lastDigits[Math.floor(Math.random() * lastDigits.length)];
  const displayName = `2***${lastDigit}`;
  const randomColor = CHAT_USER_COLORS[Math.floor(Math.random() * CHAT_USER_COLORS.length)];
  const randomAvatar = CHAT_AVATARS[Math.floor(Math.random() * CHAT_AVATARS.length)];
  const messageText = REALISTIC_KENYAN_CHAT_MESSAGES[Math.floor(Math.random() * REALISTIC_KENYAN_CHAT_MESSAGES.length)];
  const likes = Math.random() > 0.7 ? Math.floor(Math.random() * 6) + 1 : 0;

  const now = new Date();
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    userId: null,
    username: displayName,
    displayName: displayName,
    avatarColor: randomColor,
    avatarIcon: randomAvatar,
    message: messageText,
    likes: likes,
    createdAt: now.toISOString()
  };
}


// Dynamic fluctuating online player count
let currentOnlineUsers = 4826;
setInterval(() => {
  const delta = (Math.floor(Math.random() * 11) - 5); // between -5 and +5
  currentOnlineUsers = Math.max(4650, Math.min(5380, currentOnlineUsers + delta));
  io.emit('online_users_count', { count: currentOnlineUsers });
}, 3500);

// Active Rain Drops Map
const activeRainDrops = new Map();

function createChatRainDrop(options = {}) {
  const amountPerClaim = options.amountPerClaim || 20.00;
  const quantityTotal = options.quantityTotal || 125;
  const quantityClaimed = options.quantityClaimed || Math.min(quantityTotal - 5, Math.floor(quantityTotal * 0.79)); // e.g. 99 / 125
  const totalAmount = amountPerClaim * quantityTotal;
  const minBalanceRequired = options.minBalanceRequired || 200.00;
  const rainId = 'rain_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  const sampleAvatars = CHAT_AVATARS.slice(0, 12);

  const rainObj = {
    id: rainId,
    type: 'rain',
    userId: 'system_captain',
    username: 'captain',
    displayName: 'captain',
    avatarIcon: 'B',
    avatarBadge: 'Bot',
    avatarColor: '#0284c7',
    message: 'Rain Promo',
    rainData: {
      id: rainId,
      title: 'Rain',
      amountPerClaim: amountPerClaim,
      currency: 'KES',
      quantityTotal: quantityTotal,
      quantityClaimed: quantityClaimed,
      totalAmount: totalAmount,
      minBalanceRequired: minBalanceRequired,
      claimedUserIds: [],
      claimedAvatars: sampleAvatars,
      extraClaimantsCount: 13,
      isExpired: false
    },
    likes: 18,
    createdAt: new Date().toISOString()
  };

  activeRainDrops.set(rainId, rainObj);
  return rainObj;
}

// Seed initial history so chat is immediately populated and active with a Rain card
async function seedInitialChat() {
  try {
    const existing = await ChatMessage.find().sort({ created_at: -1 }).limit(45).lean();
    if (existing && existing.length >= 15) {
      existing.reverse().forEach((m, idx) => {
        recentChatMessages.push({
          id: m.id,
          type: 'text',
          userId: m.user_id,
          username: m.username,
          displayName: m.display_name,
          avatarColor: m.avatar_color || CHAT_USER_COLORS[idx % CHAT_USER_COLORS.length],
          avatarIcon: m.avatar_icon || CHAT_AVATARS[idx % CHAT_AVATARS.length],
          message: m.message,
          likes: m.likes || 0,
          createdAt: m.created_at
        });
      });
    } else {
      const startTime = Date.now() - 40 * 6000;
      for (let i = 0; i < 40; i++) {
        const item = generateSimulatedChatMessage();
        item.createdAt = new Date(startTime + i * 6000).toISOString();
        recentChatMessages.push(item);
      }
    }

    // Insert an active Rain card into the recent chat stream (at the bottom so players immediately see & can claim it!)
    const initialRain = createChatRainDrop({
      amountPerClaim: 20.00,
      quantityTotal: 125,
      quantityClaimed: 99,
      minBalanceRequired: 200.00
    });
    recentChatMessages.push(initialRain);
  } catch (err) {
    console.error('Initial chat seeding error:', err.message);
  }
}

// Continuous real-time chat stream engine (Rapid & realistic stream + periodic Rain drop)
let lastChatSimTime = Date.now();
let nextChatSimInterval = 1500 + Math.random() * 1500;
let lastRainDropTime = Date.now();

setInterval(async () => {
  const now = Date.now();
  if (now - lastChatSimTime >= nextChatSimInterval) {
    lastChatSimTime = now;
    nextChatSimInterval = 1400 + Math.random() * 1800; // between 1.4s and 3.2s

    // Check if it's time for a Rain drop (every ~3.5 to 5 minutes)
    if (now - lastRainDropTime > 220000 && Math.random() > 0.4) {
      lastRainDropTime = now;
      const newRain = createChatRainDrop({
        amountPerClaim: Math.random() > 0.6 ? 50.00 : 20.00,
        quantityTotal: 100 + Math.floor(Math.random() * 50),
        quantityClaimed: 25 + Math.floor(Math.random() * 30),
        minBalanceRequired: 200.00
      });
      recentChatMessages.push(newRain);
      if (recentChatMessages.length > 120) recentChatMessages.shift();

      io.emit('chat_message', newRain);
      io.emit('chatMessage', newRain);
      return;
    }

    // Normal simulated message
    const newMsg = generateSimulatedChatMessage();
    recentChatMessages.push(newMsg);
    if (recentChatMessages.length > 120) recentChatMessages.shift();

    // Broadcast to all active players
    io.emit('chat_message', newMsg);
    io.emit('chatMessage', newMsg);

    // Occasionally like a recent message (to simulate live community likes)
    if (Math.random() > 0.55 && recentChatMessages.length > 2) {
      const randomIdx = Math.max(0, recentChatMessages.length - 1 - Math.floor(Math.random() * 6));
      const targetMsg = recentChatMessages[randomIdx];
      if (targetMsg) {
        targetMsg.likes = (targetMsg.likes || 0) + 1;
        io.emit('chat_liked', { id: targetMsg.id, likes: targetMsg.likes });
      }
    }
  }

  // Naturally advance active Rain claims over time (simulating community claiming)
  activeRainDrops.forEach((rain) => {
    if (rain.rainData && rain.rainData.quantityClaimed < rain.rainData.quantityTotal && Math.random() > 0.65) {
      rain.rainData.quantityClaimed = Math.min(rain.rainData.quantityTotal, rain.rainData.quantityClaimed + 1);
      io.emit('chat_rain_updated', {
        rainId: rain.id,
        quantityClaimed: rain.rainData.quantityClaimed,
        quantityTotal: rain.rainData.quantityTotal
      });
    }
  });
}, 800);

// ---------- CHAT REST ENDPOINTS ----------

// 1. Get recent chat messages & active online count
app.get('/api/chat/messages', async (req, res) => {
  try {
    return res.json({
      messages: recentChatMessages,
      onlineCount: currentOnlineUsers
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load chat messages' });
  }
});

// 2. Check player chat eligibility (Minimum wallet balance of 1,000 KES required)
app.get('/api/chat/status', authenticateToken, async (req, res) => {
  try {
    const canChat = await userHasChatBalance(req.user.id);
    const user = await User.findOne({ id: req.user.id }).lean();
    const currentBalance = Number(user?.balance || 0);
    return res.json({
      canChat,
      requiredBalance: 1000,
      currentBalance,
      message: canChat
        ? 'Chat enabled'
        : 'Chat access is restricted for players with balance below 1000 KES'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify chat status' });
  }
});

// 3. Claim Rain Bonus
app.post('/api/chat/rain/claim', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rainId } = req.body;
    if (!rainId) return res.status(400).json({ error: 'Rain ID is required' });

    let rain = activeRainDrops.get(rainId);
    if (!rain) {
      rain = recentChatMessages.find(m => m.id === rainId || m.rainData?.id === rainId);
    }
    if (!rain || !rain.rainData) {
      return res.status(404).json({ error: 'Rain promotion has expired or ended.' });
    }

    const rData = rain.rainData;
    if (rData.claimedUserIds && rData.claimedUserIds.includes(String(userId))) {
      return res.status(400).json({ error: 'You have already claimed this Rain bonus!' });
    }

    if (rData.quantityClaimed >= rData.quantityTotal) {
      return res.status(400).json({ error: 'All Rain rewards for this drop have been claimed!' });
    }

    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Verify required balance (e.g. at least KES 200 balance)
    const currentBalance = Number(user.balance || 0);
    const minRequired = Number(rData.minBalanceRequired || 200);

    if (currentBalance < minRequired && !isAdminRole(user.role)) {
      return res.status(403).json({
        error: `A minimum balance of KES ${minRequired.toFixed(2)} is required to claim this Rain promo. Your current balance is KES ${currentBalance.toFixed(2)}.`,
        requiresDeposit: true,
        currentBalance: currentBalance,
        minBalanceRequired: minRequired
      });
    }

    // Credit reward amount directly to user's balance
    const rewardAmount = Number(rData.amountPerClaim || 20.00);
    user.balance = Number((user.balance + rewardAmount).toFixed(2));
    await user.save();

    // Create bonus transaction record
    try {
      await Transaction.create({
        id: 'tx_rain_' + Date.now(),
        user_id: userId,
        type: 'bonus',
        amount: rewardAmount,
        balance_after: user.balance,
        description: `Aviator Chat Rain bonus (+KES ${rewardAmount.toFixed(2)})`,
        status: 'completed',
        created_at: new Date()
      });
    } catch (e) {}

    // Record that user claimed
    if (!rData.claimedUserIds) rData.claimedUserIds = [];
    rData.claimedUserIds.push(String(userId));
    rData.quantityClaimed = Math.min(rData.quantityTotal, rData.quantityClaimed + 1);

    // Broadcast updated Rain quantity
    io.emit('chat_rain_updated', {
      rainId: rainId,
      quantityClaimed: rData.quantityClaimed,
      quantityTotal: rData.quantityTotal
    });

    // Notify wallet balance change
    notifyStateChanges({
      userId: user.id,
      balance: user.balance,
      user: user
    });

    return res.json({
      success: true,
      rewardAmount: rewardAmount,
      newBalance: user.balance,
      message: `🎉 KES ${rewardAmount.toFixed(2)} Rain bonus successfully added to your balance!`
    });
  } catch (err) {
    console.error('Rain claim error:', err);
    return res.status(500).json({ error: err.message || 'Failed to claim Rain' });
  }
});

// 4. Send chat message (Restricted to players with >= 1,000 KES wallet balance)
app.post('/api/chat/send', authenticateToken, rateLimit(30, 60000), async (req, res) => {
  try {
    const text = String(req.body.message || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    if (text.length > 200) {
      return res.status(400).json({ error: 'Message exceeds maximum length of 200 characters' });
    }

    const canChat = await userHasChatBalance(req.user.id);
    if (!canChat) {
      return res.status(403).json({
        error: 'Chat access is restricted for players with balance below 1000 KES',
        requiresBalance: true,
        requiredBalance: 1000
      });
    }

    const user = await User.findOne({ id: req.user.id }).lean();
    const phone = user?.phone_number || user?.username || `Player_${req.user.id}`;
    const displayName = maskPhoneNumberForChat(phone);
    const avatarColor = CHAT_USER_COLORS[Math.abs(Number(req.user.id) || 0) % CHAT_USER_COLORS.length];
    const avatarImg = CHAT_AVATARS[Math.abs(Number(req.user.id) || 0) % CHAT_AVATARS.length];

    const chatDoc = await ChatMessage.create({
      user_id: req.user.id,
      username: user?.username || `Player_${req.user.id}`,
      display_name: displayName,
      avatar_color: avatarColor,
      avatar_icon: avatarImg,
      message: text,
      likes: 0
    });

    const payload = {
      id: chatDoc.id,
      type: 'text',
      userId: req.user.id,
      username: chatDoc.username,
      displayName: chatDoc.display_name,
      avatarColor: chatDoc.avatar_color,
      avatarIcon: avatarImg,
      message: chatDoc.message,
      likes: 0,
      createdAt: chatDoc.created_at
    };

    recentChatMessages.push(payload);
    if (recentChatMessages.length > 120) recentChatMessages.shift();

    io.emit('chat_message', payload);
    io.emit('chatMessage', payload);

    return res.json({ success: true, message: payload });
  } catch (err) {
    console.error('Chat send error:', err.message);
    return res.status(500).json({ error: 'Failed to send chat message' });
  }
});

// 5. Like chat message
app.post('/api/chat/like/:id', async (req, res) => {
  try {
    const msgId = Number(req.params.id);
    const target = recentChatMessages.find(m => m.id === msgId);
    if (target) {
      target.likes = (target.likes || 0) + 1;
      io.emit('chat_liked', { id: target.id, likes: target.likes });
      return res.json({ success: true, likes: target.likes });
    }

    const updated = await ChatMessage.findOneAndUpdate(
      { id: msgId },
      { $inc: { likes: 1 } },
      { new: true }
    );
    if (updated) {
      io.emit('chat_liked', { id: updated.id, likes: updated.likes });
      return res.json({ success: true, likes: updated.likes });
    }

    return res.status(404).json({ error: 'Message not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to like message' });
  }
});

// ---------- ADMIN REST APIS ----------

// Admin Overview Stats
app.get('/api/admin/stats', authenticateAdminToken, async (req, res) => {
  try {
    // Aggregate inside MongoDB rather than loading the entire bets collection
    // into the Node process every time a dashboard update is emitted.
    const [totalUsers, betAgg, depAgg, wdAgg] = await Promise.all([
      User.countDocuments(),
      Bet.aggregate([
        { $group: {
          _id: null,
          totalBets: { $sum: 1 },
          totalVolume: { $sum: '$bet_amount' },
          totalPayout: { $sum: '$payout_amount' }
        } }
      ]),
      Deposit.aggregate([
        { $match: { status: 'completed', provider: 'payhero' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Withdrawal.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);
    const betTotals = betAgg[0] || {};

    return res.json({
      totalUsers,
      totalBets: betTotals.totalBets || 0,
      totalVolume: roundToMoney(betTotals.totalVolume || 0),
      totalPayout: roundToMoney(betTotals.totalPayout || 0),
      totalDeposits: roundToMoney(depAgg[0]?.total || 0),
      totalWithdrawals: roundToMoney(wdAgg[0]?.total || 0),
      connectedPlayers: connectedPlayerSockets,
      onlineUsers: connectedUserCounts.size
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load admin stats' });
  }
});

// Admin Users List
/**
 * One round trip that fills every admin tab at once.
 *
 * The tables were not slow because of the database — the collections are small
 * and each query measures around a tenth of a second, essentially one network
 * hop. They were slow because opening each tab cost its own request. Fetching
 * the lot together lets the dashboard render every tab immediately.
 */
app.get('/api/admin/overview', authenticateAdminToken, async (req, res) => {
  try {
    const [users, transactions, betAgg, depAgg, wdAgg, totalUsers, logs] = await Promise.all([
      User.find({}).select('-password_hash -__v -_id').sort({ created_at: -1, id: -1 }).limit(100).lean(),
      Transaction.find({}).select('id user_id type amount status reference created_at').sort({ created_at: -1 }).limit(100).lean(),
      Bet.aggregate([{ $group: { _id: null, totalBets: { $sum: 1 }, totalVolume: { $sum: '$bet_amount' }, totalPayout: { $sum: '$payout_amount' } } }]),
      Deposit.aggregate([{ $match: { status: 'completed', provider: 'payhero' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Withdrawal.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      User.countDocuments(),
      AdminLog.find({}).sort({ created_at: -1 }).limit(50).lean()
    ]);

    // Resolve the usernames for the transaction rows from the page of users we
    // already have, and only query for the few that are missing.
    const userMap = new Map(users.map(u => [u.id, u]));
    const missing = [...new Set(transactions.map(t => t.user_id))].filter(id => !userMap.has(id));
    if (missing.length) {
      const extra = await User.find({ id: { $in: missing } }, 'id username phone_number').lean();
      extra.forEach(u => userMap.set(u.id, u));
    }

    const betTotals = betAgg[0] || {};

    return res.json({
      stats: {
        totalUsers,
        totalBets: betTotals.totalBets || 0,
        totalVolume: roundToMoney(betTotals.totalVolume || 0),
        totalPayout: roundToMoney(betTotals.totalPayout || 0),
        totalDeposits: roundToMoney(depAgg[0]?.total || 0),
        totalWithdrawals: roundToMoney(wdAgg[0]?.total || 0),
        connectedPlayers: connectedPlayerSockets,
        onlineUsers: connectedUserCounts.size
      },
      users: users.map(u => ({ ...u, balance: parseFloat(u.balance || 0) })),
      transactions: transactions.map(t => {
        const u = userMap.get(t.user_id) || {};
        return {
          id: t.id,
          user_id: t.user_id,
          username: u.username || 'Unknown',
          phone_number: u.phone_number || '',
          type: t.type,
          amount: t.amount,
          status: t.status,
          reference: t.reference || '',
          created_at: t.created_at
        };
      }),
      logs
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    return res.status(500).json({ error: 'Failed to load admin overview' });
  }
});

app.get('/api/admin/users', authenticateAdminToken, async (req, res) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const role = req.query.role || 'all';

    const filter = {};
    if (search) {
      filter.$or = [
        { username: new RegExp(escapeRegExp(search), 'i') },
        { phone_number: new RegExp(escapeRegExp(search), 'i') }
      ];
    }
    if (role !== 'all') filter.role = role;

    // Never ship password hashes to a browser, and halve the payload while we
    // are at it — the unprojected query measured twice as slow as this one.
    const users = await User.find(filter)
      .select('-password_hash -__v -_id')
      .sort({ created_at: -1, id: -1 })
      .limit(100)
      .lean();

    return res.json({ users: users.map(u => ({ ...u, balance: parseFloat(u.balance || 0) })) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user list' });
  }
});

// Toggle Suspend User
app.post('/api/admin/users/:id/suspend', authenticateAdminToken, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    const { suspend } = req.body;

    const user = await User.findOneAndUpdate(
      { id: targetUserId },
      { $set: { is_suspended: Boolean(suspend) } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    await AdminLog.create({
      admin_id: req.user.id,
      action: suspend ? 'SUSPEND_USER' : 'ACTIVATE_USER',
      details: `User ID ${targetUserId} status changed to ${suspend ? 'suspended' : 'active'}`,
      target_user_id: targetUserId
    });

    emitRealtimeMutation({ action: suspend ? 'user_suspended' : 'user_activated', userId: targetUserId, user: true });
    return res.json({ message: `User ${suspend ? 'suspended' : 'activated'} successfully` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update user status' });
  }
});

// Adjust Balance
app.post('/api/admin/users/:id/balance', authenticateAdminToken, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount)) return res.status(400).json({ error: 'Invalid balance amount' });

    let updatedUser = await User.findOneAndUpdate(
      { id: targetUserId },
      { $inc: { balance: amount } },
      { new: true }
    );
    if (!updatedUser) return res.status(404).json({ error: 'User not found' });

    if (updatedUser.balance < 0) {
      updatedUser.balance = 0;
      await updatedUser.save();
    }

    const tx = await Transaction.create({
      user_id: targetUserId,
      type: 'admin_adjustment',
      amount,
      status: 'completed',
      reference: `ADMIN-ADJUST-${req.user.id}-${Date.now()}`
    });

    await AdminLog.create({
      admin_id: req.user.id,
      action: 'ADJUST_BALANCE',
      details: `Adjusted user balance by KES ${amount}. New balance: KES ${updatedUser.balance}`,
      target_user_id: targetUserId
    });

    emitRealtimeMutation({
      action: amount >= 0 ? 'admin_wallet_credit' : 'admin_wallet_debit',
      userId: targetUserId,
      balance: updatedUser.balance,
      transaction: tx,
      user: true
    });

    // Also emit balance update directly to all player sockets for this user
    io.to(`user_${targetUserId}`).emit('balance_updated', { balance: updatedUser.balance });
    io.to(`user_${targetUserId}`).emit('mpesa_deposit_completed', { balance: updatedUser.balance });

    return res.json({ message: 'Balance adjusted successfully', newBalance: updatedUser.balance });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to adjust user balance' });
  }
});

// Reset User Password
app.post('/api/admin/users/:id/reset-password', authenticateAdminToken, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    const user = await User.findOneAndUpdate(
      { id: targetUserId },
      { $set: { password_hash: passwordHash } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    await AdminLog.create({
      admin_id: req.user.id,
      action: 'RESET_PASSWORD',
      details: `Reset password for user ID ${targetUserId}`,
      target_user_id: targetUserId
    });

    emitRealtimeMutation({ action: 'admin_password_reset', userId: targetUserId, user: true, dashboard: false });
    return res.json({ message: 'User password reset successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Delete User
app.delete('/api/admin/users/:id', authenticateAdminToken, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    if (targetUserId === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

    const targetUser = await User.findOne({ id: targetUserId });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (isAdminRole(targetUser.role) && !isSuperAdmin(req.user.role)) {
      return res.status(403).json({ error: 'Only a superadmin can remove admin accounts' });
    }

    await User.deleteOne({ id: targetUserId });
    await AdminLog.create({
      admin_id: req.user.id,
      action: 'DELETE_USER',
      details: `Deleted user ID ${targetUserId} (role: ${targetUser.role})`,
      target_user_id: targetUserId
    });

    emitRealtimeMutation({ action: 'user_deleted', userId: targetUserId, user: true });
    return res.json({ message: 'User deleted successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Admin Logs
app.get('/api/admin/logs', authenticateAdminToken, async (req, res) => {
  try {
    const logs = await AdminLog.find({})
      .sort({ created_at: -1 })
      .limit(100)
      .lean();

    const adminIds = [...new Set(logs.map(l => l.admin_id))];
    const admins = await User.find({ id: { $in: adminIds } }, 'id username').lean();
    const adminMap = new Map(admins.map(a => [a.id, a.username]));

    return res.json({
      logs: logs.map(l => ({
        ...l,
        admin_username: adminMap.get(l.admin_id) || 'Unknown Admin'
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch admin logs' });
  }
});

// Admin All Transactions
app.get('/api/admin/transactions', authenticateAdminToken, async (req, res) => {
  try {
    const requestedType = String(req.query.type || 'all');
    const requestedStatus = String(req.query.status || 'all');
    const typeFilter = ['all', 'deposit', 'withdrawal'].includes(requestedType) ? requestedType : 'all';
    const statusFilter = ['all', 'pending', 'completed', 'failed'].includes(requestedStatus) ? requestedStatus : 'all';
    const search = req.query.search ? String(req.query.search).trim() : '';

    let userIds = null;
    if (search) {
      const users = await User.find({
        $or: [
          { username: new RegExp(escapeRegExp(search), 'i') },
          { phone_number: new RegExp(escapeRegExp(search), 'i') }
        ]
      }, 'id username phone_number').lean();
      userIds = users.map(u => u.id);
    }

    const filter = {};
    if (userIds !== null) filter.user_id = { $in: userIds };
    if (typeFilter !== 'all') filter.type = typeFilter;
    if (statusFilter !== 'all') filter.status = statusFilter;

    const transactions = await Transaction.find(filter)
      .select('id user_id type amount status reference created_at')
      .sort({ created_at: -1 })
      .limit(100)
      .lean();

    const allUserIds = [...new Set(transactions.map(t => t.user_id))];
    const users = await User.find({ id: { $in: allUserIds } }, 'id username phone_number').lean();
    const userMap = new Map(users.map(u => [u.id, u]));

    const result = transactions.map(t => {
      const u = userMap.get(t.user_id) || {};
      return {
        id: t.id,
        user_id: t.user_id,
        username: u.username || 'Unknown',
        phone_number: u.phone_number || '',
        type: t.type,
        amount: t.amount,
        status: t.status,
        reference: t.reference || '',
        created_at: t.created_at
      };
    });

    return res.json({ transactions: result });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch admin transactions' });
  }
});

// Admin List Admins
app.get('/api/admin/admins', authenticateSuperAdminToken, async (req, res) => {
  try {
    const admins = await User.find({ role: { $in: ['admin', 'superadmin'] } })
      .sort({ role: -1, id: 1 })
      .lean();
    return res.json({ admins });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch admins list' });
  }
});

// Admin Create Admin
app.post('/api/admin/create-admin', authenticateSuperAdminToken, async (req, res) => {
  try {
    const { username, phone_number, password } = req.body;
    if (!username || !password || password.length < 6) {
      return res.status(400).json({ error: 'Username and password (min 6 chars) are required' });
    }

    const trimmed = username.trim();
    const existing = await User.findOne({ username: new RegExp(`^${escapeRegExp(trimmed)}$`, 'i') }).lean();
    if (existing) return res.status(400).json({ error: 'Username is already taken' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newAdmin = await User.create({
      username: trimmed,
      phone_number: phone_number || null,
      password_hash: passwordHash,
      role: 'admin',
      balance: 0.00
    });

    await AdminLog.create({
      admin_id: req.user.id,
      action: 'CREATE_ADMIN',
      details: `Created admin account for ${trimmed}`,
      target_user_id: newAdmin.id
    });

    emitRealtimeMutation({ action: 'admin_created', userId: newAdmin.id, user: true });
    return res.status(201).json({ message: `Admin user ${trimmed} created successfully`, user: newAdmin });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create admin user' });
  }
});

// Admin Set User Role
app.post('/api/admin/users/:id/set-role', authenticateSuperAdminToken, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: "Role must be 'user' or 'admin'" });
    }
    if (targetUserId === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own superadmin role' });
    }

    const targetUser = await User.findOne({ id: targetUserId });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (isSuperAdmin(targetUser.role)) {
      return res.status(403).json({ error: 'Cannot change role of a superadmin' });
    }

    targetUser.role = role;
    await targetUser.save();

    await AdminLog.create({
      admin_id: req.user.id,
      action: 'SET_ROLE',
      details: `Changed role of ${targetUser.username} to '${role}'`,
      target_user_id: targetUserId
    });

    emitRealtimeMutation({ action: 'user_role_updated', userId: targetUserId, user: true });
    return res.json({ message: `User role updated to '${role}' successfully` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Admin Withdrawal Settings
// ---------- DEPOSIT SETTINGS ----------
// Public: the player apps read the live minimum so the client-side hint and the
// server-side rule can never drift apart.
app.get('/api/settings/deposit', async (req, res) => {
  try {
    await refreshMinimumDeposit();
    return res.json({ minimum_deposit: getMinimumDeposit() });
  } catch (err) {
    return res.json({ minimum_deposit: DEFAULT_MINIMUM_DEPOSIT });
  }
});

app.get('/api/admin/deposit-settings', authenticateAdminToken, async (req, res) => {
  try {
    await refreshMinimumDeposit();
    return res.json({ minimum_deposit: getMinimumDeposit() });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch deposit settings' });
  }
});

app.put('/api/admin/deposit-settings', authenticateAdminToken, async (req, res) => {
  try {
    const minimumDeposit = Math.round(Number(req.body.minimum_deposit));

    if (!Number.isFinite(minimumDeposit) || minimumDeposit < 1 || minimumDeposit > 1000000) {
      return res.status(400).json({ error: 'Minimum deposit must be between 1 and 1,000,000 KES' });
    }

    const updated = await DepositSetting.findByIdAndUpdate(
      'global_settings',
      {
        minimum_deposit: minimumDeposit,
        updated_by: req.user.id,
        updated_at: new Date()
      },
      { new: true, upsert: true }
    ).lean();

    setCachedMinimumDeposit(updated.minimum_deposit);

    // Audit entry and fan-out are side effects; keep them off the response path.
    AdminLog.create({
      admin_id: req.user.id,
      action: 'UPDATE_DEPOSIT_SETTINGS',
      details: `Set minimum deposit to KES ${minimumDeposit.toFixed(2)}`
    }).catch(logErr => console.warn('AdminLog error:', logErr.message));

    setImmediate(() => emitRealtimeMutation({ action: 'deposit_settings_updated', dashboard: false }));

    return res.json({
      message: 'Minimum deposit updated',
      minimum_deposit: updated.minimum_deposit,
      updated_at: updated.updated_at
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update deposit settings' });
  }
});

app.get('/api/admin/withdrawal-settings', authenticateAdminToken, async (req, res) => {
  try {
    const settings = await getWithdrawalSettings();
    return res.json({
      minimum_total_wager: settings.minimumTotalWager,
      initiation_title: settings.initiationTitle,
      initiation_message: settings.initiationMessage
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch withdrawal settings' });
  }
});

app.put('/api/admin/withdrawal-settings', authenticateAdminToken, async (req, res) => {
  try {
    const minimumTotalWager = Number(req.body.minimum_total_wager);
    const initiationTitle = typeof req.body.initiation_title === 'string' ? req.body.initiation_title.trim() : '';
    const initiationMessage = typeof req.body.initiation_message === 'string' ? req.body.initiation_message.trim() : '';

    if (!Number.isFinite(minimumTotalWager) || minimumTotalWager < 0 || minimumTotalWager > 100000000) {
      return res.status(400).json({ error: 'Minimum total wager must be between 0 and 100,000,000 KES' });
    }
    if (!initiationTitle || initiationTitle.length > 100) {
      return res.status(400).json({ error: 'Popup title is required and cannot exceed 100 characters' });
    }
    if (!initiationMessage || initiationMessage.length > 2000) {
      return res.status(400).json({ error: 'Popup message is required and cannot exceed 2,000 characters' });
    }

    const updated = await WithdrawalSetting.findByIdAndUpdate(
      'global_settings',
      {
        minimum_total_wager: minimumTotalWager,
        initiation_title: initiationTitle,
        initiation_message: initiationMessage,
        updated_by: req.user.id,
        updated_at: new Date()
      },
      { new: true, upsert: true }
    );

    // Audit entry and fan-out are side effects; keep them off the response path.
    AdminLog.create({
      admin_id: req.user.id,
      action: 'UPDATE_WITHDRAWAL_SETTINGS',
      details: `Set minimum total wager to KES ${minimumTotalWager.toFixed(2)} and updated withdrawal popup template`
    }).catch(logErr => console.warn('AdminLog error:', logErr.message));

    setImmediate(() => emitRealtimeMutation({ action: 'withdrawal_settings_updated', dashboard: false }));

    return res.json({
      message: 'Withdrawal wager requirement updated',
      minimum_total_wager: updated.minimum_total_wager,
      initiation_title: updated.initiation_title,
      initiation_message: updated.initiation_message,
      updated_at: updated.updated_at
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update withdrawal settings' });
  }
});

// ---------- SANITIZED / STEALTH MODE ENDPOINTS ----------
app.get('/api/admin/sanitized-mode', authenticateAdminToken, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.id }).lean();
    const settings = await getWithdrawalSettings();
    const isSanitized = user?.is_sanitized_mode !== undefined
      ? Boolean(user.is_sanitized_mode)
      : Boolean(settings.isSanitizedMode);
    return res.json({ success: true, is_sanitized_mode: isSanitized });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve sanitized mode status' });
  }
});

app.post('/api/admin/sanitized-mode', authenticateAdminToken, async (req, res) => {
  try {
    const enabled = Boolean(req.body.is_sanitized_mode);
    await User.updateOne({ id: req.user.id }, { $set: { is_sanitized_mode: enabled } });
    await WithdrawalSetting.updateOne({ _id: 'global_settings' }, { $set: { is_sanitized_mode: enabled } }, { upsert: true });
    
    // Broadcast real-time update to admin socket & user
    adminNamespace.emit('sanitized_mode_updated', { is_sanitized_mode: enabled, admin_id: req.user.id });
    io.to(`user_${req.user.id}`).emit('sanitized_mode_updated', { is_sanitized_mode: enabled });

    AdminLog.create({
      admin_id: req.user.id,
      action: 'TOGGLE_SANITIZED_MODE',
      details: `Turned sanitized view mode ${enabled ? 'ON' : 'OFF'}`
    }).catch(() => {});

    return res.json({
      success: true,
      message: `Sanitized mode turned ${enabled ? 'ON' : 'OFF'}`,
      is_sanitized_mode: enabled
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update sanitized mode' });
  }
});

// Admin Active Users & Pending Withdrawals
app.get('/api/admin/active-users', authenticateAdminToken, async (req, res) => {
  try {
    const onlineUserIds = Array.from(connectedUserCounts.keys()).filter(id => (connectedUserCounts.get(id) || 0) > 0);

    // Retrieve all registered accounts (including admin accounts so admin can test popups)
    const users = await User.find({})
      .sort({ balance: -1, id: 1 })
      .lean();

    const userIds = users.map(u => u.id);

    const depTotals = await Deposit.aggregate([
      { $match: { user_id: { $in: userIds }, status: 'completed' } },
      { $group: { _id: '$user_id', total: { $sum: '$amount' } } }
    ]);
    const depMap = new Map(depTotals.map(d => [d._id, d.total]));

    const betTotals = await Bet.aggregate([
      { $match: { user_id: { $in: userIds } } },
      { $group: { _id: '$user_id', total: { $sum: '$bet_amount' } } }
    ]);
    const betMap = new Map(betTotals.map(b => [b._id, b.total]));

    // Map active users and sort online players to the top
    const activeUsers = users.map(u => ({
      ...u,
      balance: parseFloat(u.balance || 0),
      total_deposits: parseFloat(depMap.get(u.id) || 0),
      total_wagers: parseFloat(betMap.get(u.id) || 0),
      has_custom_withdrawal_popup: Boolean(u.has_custom_withdrawal_popup),
      custom_withdrawal_title: u.custom_withdrawal_title || '',
      custom_withdrawal_message: u.custom_withdrawal_message || '',
      is_online: onlineUserIds.includes(u.id)
    })).sort((a, b) => (b.is_online ? 1 : 0) - (a.is_online ? 1 : 0) || b.balance - a.balance);

    const pendingWds = await Withdrawal.find({ status: 'pending' })
      .sort({ created_at: -1 })
      .lean();

    const userMap = new Map(users.map(u => [u.id, u]));

    const pendingWithdrawals = pendingWds.map(w => {
      const u = userMap.get(w.user_id) || {};
      return {
        ...w,
        username: u.username || 'Unknown',
        phone_number: u.phone_number || '',
        user_current_balance: parseFloat(u.balance || 0),
        user_total_deposits: parseFloat(depMap.get(w.user_id) || 0),
        user_total_wagers: parseFloat(betMap.get(w.user_id) || 0),
        is_online: onlineUserIds.includes(w.user_id)
      };
    });

    return res.json({
      activeUsers,
      pendingWithdrawals,
      withdrawalWagerRequirement: (await getWithdrawalSettings()).minimum_total_wager,
      onlineCount: onlineUserIds.length
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch active users' });
  }
});

// Admin Set or Reset Personal Withdrawal Popup for a specific player
app.post('/api/admin/users/:id/withdrawal-popup', authenticateAdminToken, async (req, res) => {
  try {
    const rawId = req.params.id;
    const isNum = !isNaN(Number(rawId));
    const userId = isNum ? Number(rawId) : rawId;
    const userQuery = isNum ? { id: userId } : { _id: rawId };

    const { title, message, enabled } = req.body;

    const clearing = enabled === false || (!title && !message);
    const patch = clearing
      ? { has_custom_withdrawal_popup: false, custom_withdrawal_title: null, custom_withdrawal_message: null }
      : {
          has_custom_withdrawal_popup: true,
          custom_withdrawal_title: title ? String(title).trim() : null,
          custom_withdrawal_message: message ? String(message).trim() : null
        };

    let user = await User.findOneAndUpdate(userQuery, { $set: patch }, { new: true })
      .select('id username has_custom_withdrawal_popup custom_withdrawal_title custom_withdrawal_message')
      .lean();
    if (!user && !isNum) {
      const parsedNum = parseInt(rawId, 10);
      if (!isNaN(parsedNum)) {
        user = await User.findOneAndUpdate({ id: parsedNum }, { $set: patch }, { new: true })
          .select('id username has_custom_withdrawal_popup custom_withdrawal_title custom_withdrawal_message')
          .lean();
      }
    }
    if (!user) return res.status(404).json({ error: 'User account not found' });

    // The audit entry and the socket fan-out are side effects. Awaiting them
    // added two more round trips — a counter increment and an insert — to every
    // save, which is what made the button sit on "Saving..." for seconds.
    AdminLog.create({
      admin_id: req.user?.id || 1,
      action: 'SET_USER_WITHDRAWAL_POPUP',
      details: user.has_custom_withdrawal_popup
        ? `Configured personal withdrawal popup for @${user.username}`
        : `Reverted withdrawal popup to global default for @${user.username}`,
      target_user_id: userId
    }).catch(logErr => console.warn('AdminLog error:', logErr.message));

    setImmediate(() => emitRealtimeMutation({ action: 'user_withdrawal_popup_updated', userId, dashboard: true }));

    return res.json({
      success: true,
      message: user.has_custom_withdrawal_popup
        ? `Personal withdrawal popup configured for @${user.username}. It will appear whenever this player attempts withdrawal.`
        : `Personal popup cleared for @${user.username}. Player will now see the global default withdrawal notice.`,
      user: {
        id: user.id,
        has_custom_withdrawal_popup: user.has_custom_withdrawal_popup,
        custom_withdrawal_title: user.custom_withdrawal_title,
        custom_withdrawal_message: user.custom_withdrawal_message
      }
    });
  } catch (err) {
    console.error('Error updating personal withdrawal popup:', err);
    return res.status(500).json({ error: 'Failed to update personal withdrawal popup' });
  }
});

// Admin Deposits List
app.get('/api/admin/deposits', authenticateAdminToken, async (req, res) => {
  try {
    const deposits = await Deposit.find({})
      .sort({ created_at: -1 })
      .limit(100)
      .lean();

    const userIds = [...new Set(deposits.map(d => d.user_id))];
    const users = await User.find({ id: { $in: userIds } }, 'id username phone_number').lean();
    const userMap = new Map(users.map(u => [u.id, u]));

    return res.json({
      deposits: deposits.map(d => {
        const u = userMap.get(d.user_id) || {};
        return {
          ...d,
          username: u.username || 'Unknown',
          phone_number: u.phone_number || ''
        };
      })
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

// Admin Reset Total Deposits Table
app.post('/api/admin/deposits/reset', authenticateAdminToken, async (req, res) => {
  try {
    // Delete deposit records and deposit transactions to reset the table & volume to zero
    await Deposit.deleteMany({});
    await Transaction.deleteMany({ type: 'deposit' });

    await AdminLog.create({
      admin_id: req.user.id,
      action: 'RESET_TOTAL_DEPOSITS',
      details: `Total deposits table was reset to zero by ${req.user.username || 'Admin'}`
    });

    emitRealtimeMutation({
      action: 'deposits_reset',
      dashboard: true,
      deposits: true
    });

    return res.json({
      success: true,
      message: 'Total deposits table has been reset to zero successfully.',
      totalDeposits: 0.00
    });
  } catch (err) {
    console.error('Reset deposits error:', err.message);
    return res.status(500).json({ error: 'Failed to reset total deposits table' });
  }
});

// Admin Process Withdrawal Action (Approve / Reject)
app.post('/api/admin/withdrawals/:id/action', authenticateAdminToken, async (req, res) => {
  try {
    const withdrawalId = parseInt(req.params.id, 10);
    const { action, note } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: "Action must be 'approve' or 'reject'" });
    }

    const wd = await Withdrawal.findOne({ id: withdrawalId });
    if (!wd) return res.status(404).json({ error: 'Withdrawal not found' });
    if (wd.status !== 'pending') return res.status(400).json({ error: `Withdrawal is already ${wd.status}` });

    const user = await User.findOne({ id: wd.user_id });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (action === 'approve') {
      if (user.balance < wd.amount) {
        return res.status(400).json({ error: 'User has insufficient balance for approval' });
      }

      user.balance = parseFloat((user.balance - wd.amount).toFixed(2));
      await user.save();

      wd.status = 'completed';
      wd.admin_note = note || 'Approved by admin';
      await wd.save();

      const tx = await Transaction.findOneAndUpdate(
        { user_id: wd.user_id, reference: `WITHDRAW-${wd.id}` },
        { $set: { status: 'completed' } },
        { new: true }
      );

      const notif = await Notification.create({
        user_id: wd.user_id,
        title: 'Withdrawal Approved',
        message: `Your withdrawal of KES ${wd.amount.toLocaleString()} has been approved and dispatched.`,
        type: 'completed'
      });

      emitRealtimeMutation({
        action: 'admin_withdrawal_approved',
        userId: wd.user_id,
        balance: user.balance,
        transaction: tx,
        withdrawals: true
      });

      io.to(`user_${wd.user_id}`).emit('withdrawal_notification', {
        id: notif.id,
        title: notif.title,
        message: notif.message,
        type: 'completed',
        amount: wd.amount,
        status: 'completed',
        createdAt: notif.created_at
      });

      return res.json({ message: 'Withdrawal approved and processed', withdrawal: wd, newBalance: user.balance });
    } else {
      wd.status = 'rejected';
      wd.admin_note = note || 'Rejected by admin';
      await wd.save();

      const tx = await Transaction.findOneAndUpdate(
        { user_id: wd.user_id, reference: `WITHDRAW-${wd.id}` },
        { $set: { status: 'failed' } },
        { new: true }
      );

      const notif = await Notification.create({
        user_id: wd.user_id,
        title: 'Withdrawal Declined',
        message: `Your withdrawal of KES ${wd.amount.toLocaleString()} was declined. Reason: ${note || 'Admin review'}`,
        type: 'rejected'
      });

      emitRealtimeMutation({
        action: 'admin_withdrawal_rejected',
        userId: wd.user_id,
        balance: user.balance,
        transaction: tx,
        withdrawals: true
      });

      io.to(`user_${wd.user_id}`).emit('withdrawal_notification', {
        id: notif.id,
        title: notif.title,
        message: notif.message,
        type: 'rejected',
        amount: wd.amount,
        status: 'rejected',
        createdAt: notif.created_at
      });

      return res.json({ message: 'Withdrawal rejected', withdrawal: wd });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process withdrawal action' });
  }
});

// Admin Process Withdrawal (Alternate body format)
app.post('/api/admin/withdrawals/process', authenticateAdminToken, async (req, res) => {
  try {
    const withdrawalId = parseInt(req.body.withdrawal_id, 10);
    const action = req.body.action;
    const note = req.body.custom_message || req.body.note || '';
    const title = req.body.custom_title || '';

    if (!['complete', 'reject', 'approve'].includes(action)) {
      return res.status(400).json({ error: "Action must be 'complete' or 'reject'" });
    }

    const wd = await Withdrawal.findOne({ id: withdrawalId });
    if (!wd) return res.status(404).json({ error: 'Withdrawal not found' });
    if (wd.status !== 'pending') return res.status(400).json({ error: `Withdrawal is already ${wd.status}` });

    const user = await User.findOne({ id: wd.user_id });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (action === 'complete' || action === 'approve') {
      if (user.balance < wd.amount) {
        return res.status(400).json({ error: 'User has insufficient balance for approval' });
      }

      user.balance = parseFloat((user.balance - wd.amount).toFixed(2));
      await user.save();

      wd.status = 'completed';
      wd.admin_note = note || 'Approved by admin';
      await wd.save();

      const tx = await Transaction.findOneAndUpdate(
        { user_id: wd.user_id, reference: `WITHDRAW-${wd.id}` },
        { $set: { status: 'completed' } },
        { new: true }
      );

      const notif = await Notification.create({
        user_id: wd.user_id,
        title: title || 'Withdrawal Approved',
        message: note || `Your withdrawal of KES ${wd.amount.toLocaleString()} has been approved and dispatched.`,
        type: 'completed'
      });

      emitRealtimeMutation({
        action: 'admin_withdrawal_approved',
        userId: wd.user_id,
        balance: user.balance,
        transaction: tx,
        withdrawals: true
      });

      io.to(`user_${wd.user_id}`).emit('withdrawal_notification', {
        id: notif.id,
        title: notif.title,
        message: notif.message,
        type: 'completed',
        amount: wd.amount,
        status: 'completed',
        createdAt: notif.created_at
      });

      return res.json({ message: 'Withdrawal approved and processed', status: 'completed', newBalance: user.balance });
    } else {
      wd.status = 'rejected';
      wd.admin_note = note || 'Rejected by admin';
      await wd.save();

      const tx = await Transaction.findOneAndUpdate(
        { user_id: wd.user_id, reference: `WITHDRAW-${wd.id}` },
        { $set: { status: 'failed' } },
        { new: true }
      );

      const notif = await Notification.create({
        user_id: wd.user_id,
        title: title || 'Withdrawal Declined',
        message: note || `Your withdrawal of KES ${wd.amount.toLocaleString()} was declined.`,
        type: 'rejected'
      });

      emitRealtimeMutation({
        action: 'admin_withdrawal_rejected',
        userId: wd.user_id,
        balance: user.balance,
        transaction: tx,
        withdrawals: true
      });

      io.to(`user_${wd.user_id}`).emit('withdrawal_notification', {
        id: notif.id,
        title: notif.title,
        message: notif.message,
        type: 'rejected',
        amount: wd.amount,
        status: 'rejected',
        createdAt: notif.created_at
      });

      return res.json({ message: 'Withdrawal rejected', status: 'rejected' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

// Admin Direct Notification to User
app.post('/api/admin/notifications/send', authenticateAdminToken, async (req, res) => {
  try {
    const { target_user_id, title, message } = req.body;
    const userId = parseInt(target_user_id, 10);
    if (!userId || !message) {
      return res.status(400).json({ error: 'Target user ID and message are required' });
    }

    const notif = await Notification.create({
      user_id: userId,
      title: title || 'Administrator Notification',
      message: message.trim(),
      type: 'custom'
    });

    io.to(`user_${userId}`).emit('withdrawal_notification', {
      id: notif.id,
      title: notif.title,
      message: notif.message,
      type: 'custom',
      createdAt: notif.created_at
    });

    try {
      await AdminLog.create({
        admin_id: req.user?.id || 1,
        action: 'SEND_NOTIFICATION',
        details: `Sent direct popup notification to user #${userId}: "${notif.title}"`,
        target_user_id: userId
      });
    } catch (logErr) {
      console.warn('AdminLog error:', logErr.message);
    }

    return res.json({ message: 'Notification sent successfully', notification: notif });
  } catch (err) {
    console.error('Send notification error:', err);
    return res.status(500).json({ error: 'Failed to send notification: ' + (err.message || 'Server error') });
  }
});

// Admin Reset Total Deposits
app.post('/api/admin/deposits/reset', authenticateAdminToken, async (req, res) => {
  try {
    await Deposit.deleteMany({});
    await Transaction.deleteMany({ type: 'deposit' });

    try {
      await AdminLog.create({
        admin_id: req.user?.id || 1,
        action: 'RESET_TOTAL_DEPOSITS',
        details: `Total deposits ledger was reset to 0.00 KES by ${req.user?.username || 'Admin'}`
      });
    } catch (logErr) {
      console.warn('AdminLog error during deposit reset:', logErr.message);
    }

    emitRealtimeMutation({
      action: 'deposits_reset',
      dashboard: true,
      deposits: true
    });

    return res.json({
      success: true,
      message: 'Total deposits ledger has been reset to 0.00 KES successfully.',
      totalDeposits: 0.00
    });
  } catch (err) {
    console.error('Reset deposits error:', err);
    return res.status(500).json({ error: 'Failed to reset total deposits table: ' + (err.message || 'Server error') });
  }
});

// Admin Rounds List
app.get('/api/admin/rounds', authenticateAdminToken, async (req, res) => {
  try {
    const rounds = await GameRound.find({})
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    return res.json({ rounds });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch rounds' });
  }
});

// ---------- REAL-TIME GAME ENGINE & STATE MACHINE ----------
const BETTING_DURATION_MS = 5000;
const TICK_MS = 50;

let currentRound = {
  id: null,
  serverSeed: null,
  hash: null,
  crashPoint: 1.00,
  status: 'betting',
  startedAt: null,
  generatedAt: null
};

let gamePhase = 'betting';
let currentMultiplier = 1.00;
let flightInterval = null;
let countdownInterval = null;
let roundHistory = [];
let activeBets = new Map(); // Key: "room:userId:slot"
let previousRoundSummary = null;
let adminRoundHistory = [];
let bettingClosesAt = null;
let connectedPlayerSockets = 0;
let connectedUserCounts = new Map();

const secondaryRoomEngines = new Map(
  [2, 3].map((room) => [room, {
    room,
    currentRound: { id: null, serverSeed: null, hash: null, crashPoint: 1.00, status: 'betting', startedAt: null, generatedAt: null },
    phase: 'betting',
    multiplier: 1.00,
    history: [],
    flightInterval: null,
    restartTimeout: null,
    bettingClosesAt: null
  }])
);

function playerRoomName(room) {
  return `game_room_${room}`;
}

function parseGameRoom(room) {
  const parsed = Number(room);
  return parsed === 1 || parsed === 2 || parsed === 3 ? parsed : null;
}

function activeBetKey(userId, slot, room = 1) {
  return `${room}:${userId}:${slot}`;
}

function parseBetSlot(slot) {
  const parsed = Number(slot);
  return parsed === 1 || parsed === 2 ? parsed : null;
}

function roundToMoney(value) {
  return parseFloat((Number(value || 0)).toFixed(2));
}

function currentCountdownMs() {
  if (gamePhase !== 'betting' || !bettingClosesAt) return 0;
  return Math.max(0, bettingClosesAt - Date.now());
}

function adminStatusFromRoundStatus(status) {
  if (status === 'flying') return 'Running';
  if (status === 'crashed') return 'Crashed';
  return 'Waiting';
}

function getConnectedPlayerStats() {
  const roomOneSockets = io.sockets.adapter.rooms.get(playerRoomName(1));
  const roomOneUsers = new Set(
    Array.from(io.sockets.sockets.values())
      .filter((socket) => socket.data?.gameRoom === 1)
      .map((socket) => socket.user?.id)
      .filter(Boolean)
  );
  return {
    connectedPlayers: roomOneSockets?.size || 0,
    onlineUsers: roomOneUsers.size
  };
}

/**
 * Next crash point for every room, so the console can show rooms 2 and 3
 * alongside room 1 rather than only the primary engine's value.
 */
function getRoomsOverview() {
  const rooms = [{
    room: 1,
    isPrimary: true,
    roundId: currentRound.id,
    nextCrashPoint: currentRound.crashPoint,
    phase: gamePhase,
    multiplier: currentMultiplier,
    activeBets: Array.from(activeBets.values()).filter(bet => bet.room === 1).length
  }];

  for (const [room, engine] of secondaryRoomEngines.entries()) {
    rooms.push({
      room,
      isPrimary: false,
      roundId: engine.currentRound.id,
      nextCrashPoint: engine.currentRound.crashPoint,
      phase: engine.phase,
      multiplier: engine.multiplier,
      activeBets: Array.from(activeBets.values()).filter(bet => bet.room === room).length
    });
  }

  return rooms.sort((a, b) => a.room - b.room);
}

function getAdminNextRoundPayload() {
  return {
    roundId: currentRound.id,
    nextRoundId: currentRound.id,
    nextCrashPoint: currentRound.crashPoint,
    rooms: getRoomsOverview(),
    serverSeed: currentRound.serverSeed,
    hash: currentRound.hash,
    generatedAt: currentRound.generatedAt,
    timeGenerated: currentRound.generatedAt,
    bettingDurationMs: BETTING_DURATION_MS,
    bettingClosesAt,
    countdownMs: currentCountdownMs(),
    status: adminStatusFromRoundStatus(currentRound.status)
  };
}

function getCurrentRoundAdminStats() {
  const bets = Array.from(activeBets.values()).filter((bet) => bet.room === 1);
  const totalStake = bets.reduce((sum, bet) => sum + Number(bet.betAmount || 0), 0);
  const paidOut = bets.reduce((sum, bet) => sum + Number(bet.payoutAmount || 0), 0);
  const liveLiability = bets
    .filter((bet) => bet.status === 'placed')
    .reduce((sum, bet) => sum + Number(bet.betAmount || 0) * currentMultiplier, 0);
  const playerStats = getConnectedPlayerStats();

  return {
    roundId: currentRound.id,
    phase: gamePhase,
    status: adminStatusFromRoundStatus(currentRound.status),
    currentMultiplier,
    numberOfBets: bets.length,
    totalStake: roundToMoney(totalStake),
    estimatedPayout: roundToMoney(paidOut + liveLiability),
    connectedPlayers: playerStats.connectedPlayers,
    onlineUsers: playerStats.onlineUsers
  };
}

function getAdminSnapshot() {
  return {
    nextRound: getAdminNextRoundPayload(),
    previousRound: previousRoundSummary || {
      roundId: null,
      crashPoint: null,
      totalBets: 0,
      totalStake: 0,
      totalPayout: 0,
      winnerCount: 0,
      loserCount: 0,
      winners: [],
      losers: []
    },
    currentRound: getCurrentRoundAdminStats(),
    history: adminRoundHistory
  };
}

function emitAdminCurrentRound() {
  adminNamespace.emit('admin_current_round', getCurrentRoundAdminStats());
}

async function loadRoundHistory() {
  try {
    const rounds = await GameRound.find({ room_number: 1, status: 'crashed' })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();
    roundHistory = rounds.map(r => parseFloat(r.crash_point)).reverse();
    if (roundHistory.length === 0) {
      roundHistory = [1.17, 2.98, 1.28, 3.03, 1.57, 1.46, 2.13, 1.72, 2.93, 1.00];
    }
  } catch (err) {
    roundHistory = [1.17, 2.98, 1.28, 3.03, 1.57, 1.46, 2.13, 1.72, 2.93, 1.00];
  }
}

async function loadSecondaryRoomHistories() {
  for (const [room, engine] of secondaryRoomEngines.entries()) {
    try {
      const rounds = await GameRound.find({ room_number: room, status: 'crashed' })
        .sort({ created_at: -1 })
        .limit(20)
        .lean();
      engine.history = rounds.map(r => parseFloat(r.crash_point)).reverse();
      if (engine.history.length === 0) {
        engine.history = [1.05, 1.44, 2.36, 1.73, 1.21, 3.12, 1.08, 2.03, 1.54, 4.28];
      }
    } catch (err) {
      engine.history = [1.05, 1.44, 2.36, 1.73, 1.21, 3.12, 1.08, 2.03, 1.54, 4.28];
    }
  }
}

async function loadAdminRoundHistory() {
  try {
    const rounds = await GameRound.find({ room_number: 1 })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();
    adminRoundHistory = rounds.map(r => ({
      roundId: r.id,
      nextCrashPoint: parseFloat(r.crash_point),
      generatedAt: r.created_at,
      status: adminStatusFromRoundStatus(r.status)
    }));
  } catch (err) {
    adminRoundHistory = [];
  }
}

async function loadPreviousRoundSummary() {
  try {
    const lastRound = await GameRound.findOne({ room_number: 1, status: 'crashed' })
      .sort({ created_at: -1 })
      .lean();
    if (lastRound) {
      const bets = await Bet.find({ round_id: lastRound.id }).lean();
      const userIds = [...new Set(bets.map(b => b.user_id))];
      const users = await User.find({ id: { $in: userIds } }, 'id username').lean();
      const userMap = new Map(users.map(u => [u.id, u.username]));

      const winners = bets.filter(b => b.status === 'cashed_out').map(b => ({
        username: userMap.get(b.user_id) || 'Player',
        betAmount: b.bet_amount,
        cashoutMultiplier: b.cashout_multiplier,
        payoutAmount: b.payout_amount
      }));
      const losers = bets.filter(b => b.status === 'lost').map(b => ({
        username: userMap.get(b.user_id) || 'Player',
        betAmount: b.bet_amount,
        cashoutMultiplier: null,
        payoutAmount: 0
      }));

      previousRoundSummary = {
        roundId: lastRound.id,
        crashPoint: parseFloat(lastRound.crash_point),
        totalBets: bets.length,
        totalStake: roundToMoney(bets.reduce((s, b) => s + b.bet_amount, 0)),
        totalPayout: roundToMoney(bets.reduce((s, b) => s + b.payout_amount, 0)),
        winnerCount: winners.length,
        loserCount: losers.length,
        winners,
        losers
      };
    }
  } catch (err) {
    previousRoundSummary = null;
  }
}

// Start Betting Phase for Room 1
async function startBettingPhase() {
  const { serverSeed, crashPoint, hash } = generateProvablyFairRound();
  
  try {
    const roundDoc = await GameRound.create({
      room_number: 1,
      server_seed: serverSeed,
      hash,
      crash_point: crashPoint,
      status: 'betting'
    });
    currentRound.id = roundDoc.id;
  } catch (err) {
    currentRound.id = Date.now();
  }

  currentRound.serverSeed = serverSeed;
  currentRound.hash = hash;
  currentRound.crashPoint = crashPoint;
  currentRound.status = 'betting';
  currentRound.generatedAt = new Date().toISOString();

  gamePhase = 'betting';
  currentMultiplier = 1.00;
  bettingClosesAt = Date.now() + BETTING_DURATION_MS;

  // Clear bets for Room 1
  for (const [key, bet] of activeBets.entries()) {
    if (bet.room === 1) activeBets.delete(key);
  }

  const phasePayload = {
    phase: 'betting',
    durationMs: BETTING_DURATION_MS,
    roundId: currentRound.id,
    multiplier: 1.00,
    room: 1
  };

  io.to(playerRoomName(1)).emit('phase_update', phasePayload);
  io.to(playerRoomName(1)).emit('phase', phasePayload);
  io.to(playerRoomName(1)).emit('game_phase', phasePayload);
  io.to(playerRoomName(1)).emit('history_update', { history: roundHistory, room: 1 });

  adminNamespace.emit('admin_snapshot', getAdminSnapshot());
  adminNamespace.emit('admin_round_generated', getAdminSnapshot());
  adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());
  adminNamespace.emit('admin_round_status', {
    roundId: currentRound.id,
    status: 'Waiting',
    phase: 'betting',
    currentMultiplier: 1.00,
    crashPoint: null,
    history: adminRoundHistory
  });
  emitAdminCurrentRound();

  // Betting countdown for admin
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const cd = currentCountdownMs();
    adminNamespace.emit('admin_betting_countdown', {
      roundId: currentRound.id,
      countdownMs: cd,
      bettingClosesAt
    });
    if (cd <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }, 200);

  setTimeout(launchFlight, BETTING_DURATION_MS);
}

// Launch Flight Phase for Room 1
async function launchFlight() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  gamePhase = 'flying';
  currentRound.status = 'flying';
  currentRound.startedAt = Date.now();
  currentMultiplier = 1.00;
  bettingClosesAt = null;

  try {
    await GameRound.updateOne({ id: currentRound.id }, { $set: { status: 'flying' } });
  } catch (err) {}

  const phasePayload = { phase: 'flying', roundId: currentRound.id, multiplier: 1.00, room: 1 };
  io.to(playerRoomName(1)).emit('phase_update', phasePayload);
  io.to(playerRoomName(1)).emit('phase', phasePayload);
  io.to(playerRoomName(1)).emit('game_phase', phasePayload);

  adminNamespace.emit('admin_round_status', {
    roundId: currentRound.id,
    status: 'Running',
    phase: 'flying',
    currentMultiplier: 1.00,
    crashPoint: null,
    history: adminRoundHistory
  });
  emitAdminCurrentRound();

  const startTime = Date.now();
  flightInterval = setInterval(async () => {
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    currentMultiplier = parseFloat(Math.max(1.00, Math.exp(0.06 * elapsedSeconds)).toFixed(2));

    if (currentMultiplier >= currentRound.crashPoint) {
      clearInterval(flightInterval);
      flightInterval = null;
      await handleCrash();
    } else {
      io.to(playerRoomName(1)).emit('multiplier_tick', { multiplier: currentMultiplier, roundId: currentRound.id, room: 1 });
      io.to(playerRoomName(1)).emit('multiplier', { multiplier: currentMultiplier, room: 1 });
      io.to(playerRoomName(1)).emit('game_multiplier', { multiplier: currentMultiplier, room: 1 });
      emitAdminCurrentRound();
    }
  }, TICK_MS);
}

// Crash Phase for Room 1
async function handleCrash() {
  gamePhase = 'crashed';
  currentRound.status = 'crashed';
  currentMultiplier = currentRound.crashPoint;

  try {
    await GameRound.updateOne({ id: currentRound.id }, { $set: { status: 'crashed' } });
  } catch (err) {}

  const lostBets = Array.from(activeBets.values()).filter(b => b.room === 1 && b.status === 'placed');
  for (const bet of lostBets) {
    bet.status = 'lost';
    Bet.updateOne({ id: bet.id }, { $set: { status: 'lost' } }).catch(() => {});
  }

  roundHistory.push(currentRound.crashPoint);
  if (roundHistory.length > 20) roundHistory.shift();

  adminRoundHistory.unshift({
    roundId: currentRound.id,
    nextCrashPoint: currentRound.crashPoint,
    generatedAt: new Date().toISOString(),
    status: 'Crashed'
  });
  if (adminRoundHistory.length > 20) adminRoundHistory.pop();

  const crashedPayload = {
    phase: 'crashed',
    multiplier: currentRound.crashPoint,
    roundId: currentRound.id,
    room: 1
  };

  io.to(playerRoomName(1)).emit('round_crashed', { crashPoint: currentRound.crashPoint, roundId: currentRound.id, room: 1 });
  io.to(playerRoomName(1)).emit('phase_update', crashedPayload);
  io.to(playerRoomName(1)).emit('phase', crashedPayload);
  io.to(playerRoomName(1)).emit('game_phase', crashedPayload);
  io.to(playerRoomName(1)).emit('history_update', { history: roundHistory, room: 1 });
  io.to(playerRoomName(1)).emit('roundHistory', roundHistory);

  adminNamespace.emit('admin_round_status', {
    roundId: currentRound.id,
    status: 'Crashed',
    phase: 'crashed',
    currentMultiplier: currentRound.crashPoint,
    crashPoint: currentRound.crashPoint,
    history: adminRoundHistory
  });

  loadPreviousRoundSummary();
  emitAdminCurrentRound();

  setTimeout(startBettingPhase, 3000);
}

// Start Secondary Room Engine (Room 2 & 3)
function startSecondaryBettingPhase(room, initialDelay = 0) {
  const engine = secondaryRoomEngines.get(room);
  if (!engine) return;

  const run = async () => {
    const { serverSeed, crashPoint, hash } = generateProvablyFairRound();
    try {
      const doc = await GameRound.create({
        room_number: room,
        server_seed: serverSeed,
        hash,
        crash_point: crashPoint,
        status: 'betting'
      });
      engine.currentRound.id = doc.id;
    } catch (e) {
      engine.currentRound.id = Date.now();
    }
    engine.currentRound.serverSeed = serverSeed;
    engine.currentRound.hash = hash;
    engine.currentRound.crashPoint = crashPoint;
    engine.currentRound.status = 'betting';
    engine.phase = 'betting';
    engine.multiplier = 1.00;
    engine.bettingClosesAt = Date.now() + BETTING_DURATION_MS;

    for (const [key, bet] of activeBets.entries()) {
      if (bet.room === room) activeBets.delete(key);
    }

    const payload = { phase: 'betting', durationMs: BETTING_DURATION_MS, roundId: engine.currentRound.id, multiplier: 1.00, room };
    io.to(playerRoomName(room)).emit('phase_update', payload);
    io.to(playerRoomName(room)).emit('phase', payload);
    io.to(playerRoomName(room)).emit('history_update', { history: engine.history, room });

    // Keep the console's per-room readout current as this room rolls over.
    adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());
    adminNamespace.emit('admin_snapshot', getAdminSnapshot());

    setTimeout(() => launchSecondaryFlight(room), BETTING_DURATION_MS);
  };

  if (initialDelay > 0) {
    setTimeout(run, initialDelay);
  } else {
    run();
  }
}

function launchSecondaryFlight(room) {
  const engine = secondaryRoomEngines.get(room);
  if (!engine) return;

  engine.phase = 'flying';
  engine.currentRound.status = 'flying';
  engine.multiplier = 1.00;

  const payload = { phase: 'flying', roundId: engine.currentRound.id, multiplier: 1.00, room };
  io.to(playerRoomName(room)).emit('phase_update', payload);
  io.to(playerRoomName(room)).emit('phase', payload);
  adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());

  const startTime = Date.now();
  let lastAdminTick = 0;
  engine.flightInterval = setInterval(async () => {
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    engine.multiplier = parseFloat(Math.max(1.00, Math.exp(0.06 * elapsedSeconds)).toFixed(2));

    if (engine.multiplier >= engine.currentRound.crashPoint) {
      clearInterval(engine.flightInterval);
      engine.flightInterval = null;
      await handleSecondaryCrash(room);
    } else {
      io.to(playerRoomName(room)).emit('multiplier_tick', { multiplier: engine.multiplier, roundId: engine.currentRound.id, room });
      io.to(playerRoomName(room)).emit('multiplier', { multiplier: engine.multiplier, room });

      // Throttle live admin room multiplier update to twice a second
      const now = Date.now();
      if (now - lastAdminTick >= 500) {
        lastAdminTick = now;
        adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());
      }
    }
  }, TICK_MS);
}

async function handleSecondaryCrash(room) {
  const engine = secondaryRoomEngines.get(room);
  if (!engine) return;

  engine.phase = 'crashed';
  engine.currentRound.status = 'crashed';
  engine.multiplier = engine.currentRound.crashPoint;

  try {
    await GameRound.updateOne({ id: engine.currentRound.id }, { $set: { status: 'crashed' } });
  } catch (e) {}

  const lostBets = Array.from(activeBets.values()).filter(b => b.room === room && b.status === 'placed');
  for (const bet of lostBets) {
    bet.status = 'lost';
    Bet.updateOne({ id: bet.id }, { $set: { status: 'lost' } }).catch(() => {});
  }

  engine.history.push(engine.currentRound.crashPoint);
  if (engine.history.length > 20) engine.history.shift();

  io.to(playerRoomName(room)).emit('round_crashed', { crashPoint: engine.currentRound.crashPoint, roundId: engine.currentRound.id, room });
  io.to(playerRoomName(room)).emit('phase_update', { phase: 'crashed', multiplier: engine.currentRound.crashPoint, roundId: engine.currentRound.id, room });
  io.to(playerRoomName(room)).emit('history_update', { history: engine.history, room });
  adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());

  setTimeout(() => startSecondaryBettingPhase(room), 3000);
}

// ---------- SOCKET.IO CLIENT HANDLERS ----------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next();

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (!err && decoded) {
      socket.user = decoded;
    }
    next();
  });
});

io.on('connection', (socket) => {
  connectedPlayerSockets++;
  const user = socket.user;
  if (user?.id) {
    const prev = connectedUserCounts.get(user.id) || 0;
    connectedUserCounts.set(user.id, prev + 1);
    socket.join(`user_${user.id}`);
    socket.join(`user_${String(user.id)}`);

    // Immediately push latest authoritative DB balance to the connected socket
    User.findOne({ id: user.id }).lean().then(dbUser => {
      if (dbUser) {
        const bal = parseFloat(dbUser.balance || 0) || 0.00;
        socket.emit('balance_update', { balance: bal });
        socket.emit('balance_updated', { balance: bal });
        socket.emit('balance', { balance: bal });
        socket.emit('wallet_updated', { balance: bal });
      }
    }).catch(err => console.warn('Sync balance on connection error:', err?.message));
  }

  socket.data = { gameRoom: 1 };
  socket.join(playerRoomName(1));

  // Send initial room state
  socket.emit('room_state', {
    room: 1,
    phase: gamePhase,
    multiplier: currentMultiplier,
    durationMs: currentCountdownMs(),
    roundId: currentRound.id,
    history: roundHistory,
    activeBets: []
  });

  socket.emit('phase_update', {
    phase: gamePhase,
    durationMs: currentCountdownMs(),
    roundId: currentRound.id,
    multiplier: currentMultiplier,
    room: 1
  });
  socket.emit('history_update', { history: roundHistory, room: 1 });
  socket.emit('roundHistory', roundHistory);

  // Switch / Join room
  const handleRoomChange = (data) => {
    const room = parseGameRoom(data?.room || data) || 1;
    socket.leave(playerRoomName(socket.data.gameRoom || 1));
    socket.data.gameRoom = room;
    socket.join(playerRoomName(room));

    const engine = room === 1
      ? { phase: gamePhase, multiplier: currentMultiplier, roundId: currentRound.id, history: roundHistory, countdown: currentCountdownMs() }
      : {
          phase: secondaryRoomEngines.get(room)?.phase || 'betting',
          multiplier: secondaryRoomEngines.get(room)?.multiplier || 1.00,
          roundId: secondaryRoomEngines.get(room)?.currentRound?.id,
          history: secondaryRoomEngines.get(room)?.history || [],
          countdown: 0
        };

    const statePayload = {
      room,
      phase: engine.phase,
      multiplier: engine.multiplier,
      durationMs: engine.countdown,
      roundId: engine.roundId,
      history: engine.history,
      activeBets: []
    };

    socket.emit('room_state', statePayload);
    socket.emit('phase_update', statePayload);
    socket.emit('history_update', { history: engine.history, room });
  };

  socket.on('change_room', handleRoomChange);
  socket.on('joinRoom', handleRoomChange);

  // Place Bet Handler
  const handlePlaceBet = async (data) => {
    if (!socket.user?.id) {
      return socket.emit('bet_error', { message: 'Please log in to place a bet' });
    }

    const slot = parseBetSlot(data?.slot) || 1;
    const room = parseGameRoom(data?.room || socket.data?.gameRoom) || 1;
    const amount = parseFloat(data?.amount);

    if (isNaN(amount) || amount <= 0) {
      return socket.emit('bet_error', { message: 'Invalid bet amount', slot, room });
    }

    const currentEnginePhase = room === 1 ? gamePhase : (secondaryRoomEngines.get(room)?.phase || 'betting');
    if (currentEnginePhase !== 'betting') {
      return socket.emit('bet_error', { message: 'Betting is closed for this round', slot, room });
    }

    const key = activeBetKey(socket.user.id, slot, room);
    if (activeBets.has(key)) {
      return socket.emit('bet_error', { message: 'You already have an active bet in this panel', slot, room });
    }

    try {
      const updatedUser = await User.findOneAndUpdate(
        { id: socket.user.id, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true }
      );

      if (!updatedUser) {
        return socket.emit('bet_error', { message: 'Insufficient balance to place bet', slot, room });
      }

      const activeRoundId = room === 1 ? currentRound.id : secondaryRoomEngines.get(room)?.currentRound?.id;
      const betDoc = await Bet.create({
        user_id: socket.user.id,
        round_id: activeRoundId || 0,
        bet_amount: amount,
        status: 'placed'
      });

      const betState = {
        id: betDoc.id,
        userId: socket.user.id,
        username: socket.user.username,
        slot,
        room,
        betAmount: amount,
        payoutAmount: 0,
        status: 'placed',
        cashoutMultiplier: null
      };
      activeBets.set(key, betState);

      const confirmedPayload = { betId: betDoc.id, amount, slot, room };
      socket.emit('bet_confirmed', confirmedPayload);
      socket.emit('betConfirmed', confirmedPayload);
      socket.emit('balance_update', { balance: updatedUser.balance });

      const broadcastPayload = {
        id: betDoc.id,
        player: socket.user.username,
        bet: amount,
        multiplier: null,
        win: 0,
        cashedOut: false,
        userId: socket.user.id,
        slot,
        room
      };
      io.to(playerRoomName(room)).emit('bet_placed_broadcast', broadcastPayload);
      io.to(playerRoomName(room)).emit('liveBet', broadcastPayload);

      emitAdminCurrentRound();
    } catch (err) {
      console.error('Place bet error:', err.message);
      socket.emit('bet_error', { message: 'Failed to place bet', slot, room });
    }
  };

  socket.on('place_bet', handlePlaceBet);
  socket.on('placeBet', handlePlaceBet);

  // Cancel Bet Handler (allowed during 'betting' phase)
  const handleCancelBet = async (data) => {
    if (!socket.user?.id) return;
    const slot = parseBetSlot(data?.slot) || 1;
    const room = parseGameRoom(data?.room || socket.data?.gameRoom) || 1;
    const currentEnginePhase = room === 1 ? gamePhase : (secondaryRoomEngines.get(room)?.phase || 'betting');

    if (currentEnginePhase !== 'betting') {
      return socket.emit('cancel_error', { message: 'Bet cannot be cancelled once flight starts', slot, room });
    }

    const key = activeBetKey(socket.user.id, slot, room);
    const activeBet = activeBets.get(key);
    if (!activeBet || activeBet.status !== 'placed') {
      return;
    }

    try {
      activeBets.delete(key);
      await Bet.updateOne({ id: activeBet.id }, { $set: { status: 'cancelled' } });

      // Refund balance
      const updatedUser = await User.findOneAndUpdate(
        { id: socket.user.id },
        { $inc: { balance: activeBet.betAmount } },
        { new: true }
      );

      socket.emit('bet_cancelled', { betId: activeBet.id, amount: activeBet.betAmount, slot, room });
      if (updatedUser) {
        socket.emit('balance_update', { balance: updatedUser.balance });
      }

      io.to(playerRoomName(room)).emit('bet_cancelled_broadcast', {
        id: activeBet.id,
        userId: socket.user.id,
        slot,
        room
      });

      emitAdminCurrentRound();
    } catch (err) {
      console.error('Cancel bet error:', err.message);
    }
  };

  socket.on('cancel_bet', handleCancelBet);
  socket.on('cancelBet', handleCancelBet);

  // Cash Out Handler
  const handleCashOut = async (data) => {
    if (!socket.user?.id) return;
    const slot = parseBetSlot(data?.slot) || 1;
    const room = parseGameRoom(data?.room || socket.data?.gameRoom) || 1;
    const key = activeBetKey(socket.user.id, slot, room);

    const activeBet = activeBets.get(key);
    if (!activeBet || activeBet.status !== 'placed') {
      return socket.emit('cashout_error', { message: 'No active bet to cash out', slot, room });
    }

    const currentEnginePhase = room === 1 ? gamePhase : (secondaryRoomEngines.get(room)?.phase || 'betting');
    const mult = room === 1 ? currentMultiplier : (secondaryRoomEngines.get(room)?.multiplier || 1.00);

    if (currentEnginePhase !== 'flying') {
      return socket.emit('cashout_error', { message: 'Cannot cash out right now', slot, room });
    }

    const cashoutMult = mult;
    const payout = parseFloat((activeBet.betAmount * cashoutMult).toFixed(2));

    try {
      activeBet.status = 'cashed_out';
      activeBet.cashoutMultiplier = cashoutMult;
      activeBet.payoutAmount = payout;

      await Bet.updateOne(
        { id: activeBet.id },
        { $set: { status: 'cashed_out', cashout_multiplier: cashoutMult, payout_amount: payout } }
      );

      const user = await User.findOneAndUpdate(
        { id: socket.user.id },
        { $inc: { balance: payout } },
        { new: true }
      );

      await Transaction.create({
        user_id: socket.user.id,
        type: 'bet_payout',
        amount: payout,
        status: 'completed',
        reference: `PAYOUT-BET-${activeBet.id}`
      });

      const successPayload = { multiplier: cashoutMult, payoutAmount: payout, slot, room };
      socket.emit('cash_out_success', successPayload);
      socket.emit('cashOutSuccess', successPayload);
      socket.emit('balance_update', { balance: user?.balance });

      const cashedOutBroadcast = {
        id: activeBet.id,
        player: socket.user.username,
        bet: activeBet.betAmount,
        multiplier: cashoutMult,
        win: payout,
        cashedOut: true,
        userId: socket.user.id,
        slot,
        room
      };
      io.to(playerRoomName(room)).emit('bet_cashed_out_broadcast', cashedOutBroadcast);
      io.to(playerRoomName(room)).emit('liveBet', cashedOutBroadcast);

      emitAdminCurrentRound();
    } catch (err) {
      console.error('Cashout error:', err.message);
      socket.emit('cashout_error', { message: 'Cashout failed', slot, room });
    }
  };

  socket.on('cash_out', handleCashOut);
  socket.on('cashOut', handleCashOut);

  // Chat Handlers via Socket
  socket.on('send_chat', async (data) => {
    if (!socket.user?.id) {
      return socket.emit('chat_error', { message: 'Please log in to send chat messages' });
    }
    const text = String(data?.message || '').trim();
    if (!text || text.length > 200) return;

    const canChat = await userHasChatBalance(socket.user.id);
    if (!canChat) {
      return socket.emit('chat_error', {
        message: 'Chat access is restricted for players with balance below\n1000 KES',
        requiresBalance: true,
        requiredBalance: 1000
      });
    }

    const user = await User.findOne({ id: socket.user.id }).lean();
    const phone = user?.phone_number || user?.username || `Player_${socket.user.id}`;
    const displayName = maskPhoneNumberForChat(phone);
    const avatarColor = CHAT_USER_COLORS[Math.abs(Number(socket.user.id) || 0) % CHAT_USER_COLORS.length];
    const avatarImg = CHAT_AVATARS[Math.abs(Number(socket.user.id) || 0) % CHAT_AVATARS.length];

    const chatDoc = await ChatMessage.create({
      user_id: socket.user.id,
      username: user?.username || `Player_${socket.user.id}`,
      display_name: displayName,
      avatar_color: avatarColor,
      avatar_icon: avatarImg,
      message: text,
      likes: 0
    });

    const payload = {
      id: chatDoc.id,
      type: 'text',
      userId: socket.user.id,
      username: chatDoc.username,
      displayName: chatDoc.display_name,
      avatarColor: chatDoc.avatar_color,
      avatarIcon: avatarImg,
      message: chatDoc.message,
      likes: 0,
      createdAt: chatDoc.created_at
    };

    recentChatMessages.push(payload);
    if (recentChatMessages.length > 120) recentChatMessages.shift();

    io.emit('chat_message', payload);
    io.emit('chatMessage', payload);
  });

  socket.on('like_chat', (data) => {
    const msgId = Number(data?.id);
    const target = recentChatMessages.find(m => m.id === msgId);
    if (target) {
      target.likes = (target.likes || 0) + 1;
      io.emit('chat_liked', { id: target.id, likes: target.likes });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    connectedPlayerSockets = Math.max(0, connectedPlayerSockets - 1);
    if (user?.id) {
      const count = (connectedUserCounts.get(user.id) || 1) - 1;
      if (count <= 0) connectedUserCounts.delete(user.id);
      else connectedUserCounts.set(user.id, count);
    }
    emitAdminCurrentRound();
  });
});

// ---------- ADMIN SOCKET NAMESPACE ----------
adminNamespace.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication token required'));

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err || !decoded) return next(new Error('Invalid token'));
    try {
      const user = await User.findOne({ id: decoded.id }).lean();
      if (!user || !isAdminRole(user.role)) return next(new Error('Admin privileges required'));
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('Database verification failed'));
    }
  });
});

adminNamespace.on('connection', (socket) => {
  socket.emit('admin_snapshot', getAdminSnapshot());
  socket.emit('admin_current_round', getCurrentRoundAdminStats());
  socket.emit('admin_next_round', getAdminNextRoundPayload());

  /**
   * Resolves the round an admin override should write to.
   *
   * Room 1 stays on the primary engine exactly as before — this only routes the
   * override to the right round object. Rooms 2 and 3 already run their own
   * engines whose flight loop compares against `engine.currentRound.crashPoint`,
   * so setting that field steers them the same way room 1 is steered.
   */
  const resolveRoomRound = (value) => {
    const room = Number(value) || 1;
    if (room === 1) return { room: 1, round: currentRound };
    const engine = secondaryRoomEngines.get(room);
    return engine ? { room, round: engine.currentRound } : null;
  };

  socket.on('admin_override_crash_point', (data) => {
    const target = parseFloat(data?.crashPoint);
    if (isNaN(target) || target < 1.00) return;

    const resolved = resolveRoomRound(data?.room);
    if (!resolved) {
      socket.emit('admin_override_failed', { error: 'Unknown room', room: data?.room });
      return;
    }

    const { room, round } = resolved;
    round.crashPoint = parseFloat(target.toFixed(2));
    if (round.id) {
      GameRound.updateOne({ id: round.id }, { $set: { crash_point: round.crashPoint } }).catch(() => {});
    }

    socket.emit('admin_override_confirmed', { crashPoint: round.crashPoint, room });
    adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());
    adminNamespace.emit('admin_snapshot', getAdminSnapshot());
    emitAdminCurrentRound();
  });

  socket.on('admin_reset_crash_point', (data) => {
    const resolved = resolveRoomRound(data?.room);
    if (!resolved) {
      socket.emit('admin_override_failed', { error: 'Unknown room', room: data?.room });
      return;
    }

    const { room, round } = resolved;
    const { serverSeed, crashPoint, hash } = generateProvablyFairRound();
    round.crashPoint = crashPoint;
    round.serverSeed = serverSeed;
    round.hash = hash;
    if (round.id) {
      GameRound.updateOne({ id: round.id }, { $set: { crash_point: crashPoint, server_seed: serverSeed, hash } }).catch(() => {});
    }

    socket.emit('admin_override_confirmed', { crashPoint, room });
    adminNamespace.emit('admin_next_round', getAdminNextRoundPayload());
    adminNamespace.emit('admin_snapshot', getAdminSnapshot());
    emitAdminCurrentRound();
  });
});

// ---------- START SERVER ----------
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use.`);
  } else {
    console.error('Server error:', err);
  }
});

// ---------- SPA WILDCARD FALLBACK ----------
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }
  const indexPath = path.join(distPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

async function startServer() {
  // Keep the process reachable for deployment diagnostics, but report 503 from
  // /healthz and all API routes until the database is genuinely ready.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 Anti-Gravity Aviator Engine active on http://0.0.0.0:${PORT}`);
    console.log(`=======================================================`);
  });


  // Connect only to the environment-provided production database. Alternating
  // between a hidden fallback and the configured URI can split users and
  // transactions across databases.
  // A misconfigured URI can never succeed, so retrying it just hides the reason
  // in a scrolling log. Stop here and let /healthz report 503 with the cause.
  if (startupConfigurationErrors.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error('=======================================================');
      console.error('❌ Refusing to connect. Fix the configuration and redeploy:');
      startupConfigurationErrors.forEach(message => console.error(`   • ${message}`));
      console.error('=======================================================');
      return;
    } else {
      console.warn('⚠️  Running with startup notices in development mode:');
      startupConfigurationErrors.forEach(message => console.warn(`   • ${message}`));
    }
  }

  if (!MONGODB_URI) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('=======================================================');
      console.warn('⚠️  MONGODB_URI not set. Running with LOCAL IN-MEMORY AUTH.');
      console.warn('👉  Log in with:');
      console.warn('    Username: admin (or +254792011285)');
      console.warn('    Password: SuperAdmin@2026');
      console.warn('👉  Add MONGODB_URI to backend/.env when ready to connect.');
      console.warn('=======================================================');
      startBettingPhase();
      startSecondaryBettingPhase(2, 3600);
      startSecondaryBettingPhase(3, 6800);
      return;
    }
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        minPoolSize: 1
      });
      console.log('✅ Connected to MongoDB.');
      // Warm the deposit minimum so the first deposit of the process reads a
      // configured value rather than the built-in default.
      refreshMinimumDeposit().then((min) => console.log(`💰 Minimum deposit: KES ${min}`));
      break;
    } catch (err) {
      console.warn(`MongoDB connection notice: ${err.message}. Retrying in 5s...`);
      if (process.env.NODE_ENV !== 'production' && attempt >= 2) {
        console.warn('⚠️ Continuing in local development mode with in-memory auth fallback while DB reconnects.');
        startBettingPhase();
        startSecondaryBettingPhase(2, 3600);
        startSecondaryBettingPhase(3, 6800);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Say out loud which database this is, then sanity-check that it is populated.
  try {
    observedUserCount = await User.estimatedDocumentCount();
  } catch (err) {
    observedUserCount = null;
  }

  console.log('=======================================================');
  console.log(`📂 Database: ${MONGODB_TARGET.host || 'local'}/${mongoose.connection.name || 'test'}`);
  console.log(`👥 User accounts: ${observedUserCount === null ? 'unknown' : observedUserCount}`);
  console.log('=======================================================');

  // If this is a brand new database with no accounts, automatically seed the initial superadmin
  if (observedUserCount === 0) {
    try {
      const defaultPassword = process.env.INITIAL_SUPERADMIN_PASSWORD || 'SuperAdmin@2026';
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(defaultPassword, salt);
      const initialAdmin = await User.create({
        id: 1,
        username: 'admin',
        phone_number: '+254792011285',
        password_hash: passwordHash,
        role: 'superadmin',
        balance: 1000.00
      });
      await Counter.findByIdAndUpdate('users_id', { $set: { seq: 1 } }, { upsert: true });
      observedUserCount = 1;
      console.log('=======================================================');
      console.log('🎉 Initialized fresh database with default SUPERADMIN:');
      console.log(`   Username: ${initialAdmin.username}`);
      console.log(`   Phone:    ${initialAdmin.phone_number}`);
      console.log(`   Password: ${defaultPassword}`);
      console.log(`   Role:     ${initialAdmin.role}`);
      console.log('=======================================================');
    } catch (seedErr) {
      console.warn('Notice during superadmin auto-seed:', seedErr.message);
    }
  }

  try {
    await Promise.all([
      User.createIndexes(),
      Transaction.createIndexes(),
      Deposit.createIndexes(),
      Withdrawal.createIndexes(),
      LoginHistory.createIndexes()
    ]);
    console.log('✅ Database indexes verified.');
  } catch (err) {
    // The service can still operate with existing indexes; preserve the error
    // in deployment logs so Atlas permissions or malformed indexes are visible.
    console.error(`Database index setup failed: ${err.message}`);
  }

  try {
    await seedInitialChat();
    await reopenProcessingMpesaDeposits();
    await loadRoundHistory();
    await loadSecondaryRoomHistories();
    await loadAdminRoundHistory();
    await loadPreviousRoundSummary();
  } catch (e) {}

  setInterval(reconcilePendingMpesaDeposits, 10000).unref();

  startBettingPhase();
  startSecondaryBettingPhase(2, 3600);
  startSecondaryBettingPhase(3, 6800);
}

startServer();
