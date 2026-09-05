/**
 * make-superadmin.js
 * -------------------
 * Promotes an existing user to the 'superadmin' role.
 *
 * Usage:
 *   node make-superadmin.js <username_or_phone>
 *
 * Example:
 *   node make-superadmin.js 254712345678
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('./models');

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatePhoneVariations(input) {
  if (!input || typeof input !== 'string') return [];
  const raw = input.trim();
  if (!raw) return [];
  const set = new Set([raw, raw.toLowerCase()]);
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

const inputIdentifier = process.argv[2];
if (!inputIdentifier) {
  console.error('❌  Usage: node make-superadmin.js <username_or_phone>');
  process.exit(1);
}

const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Refusing to guess a database — a localhost fallback would report success against a database nobody is serving.');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(MONGODB_URI);

    const vars = generatePhoneVariations(inputIdentifier);
    const user = await User.findOneAndUpdate(
      {
        $or: [
          { username: { $in: vars.map(v => new RegExp(`^${escapeRegExp(v)}$`, 'i')) } },
          { phone_number: { $in: vars } }
        ]
      },
      { $set: { role: 'superadmin', is_suspended: false } },
      { new: true }
    );

    if (!user) {
      console.error(`❌  User "${inputIdentifier}" not found. Make sure you register an account first.`);
      process.exit(1);
    }

    console.log(`\n✅  Success! User "${user.username}" (ID: ${user.id}) is now a SUPERADMIN.\n`);
    console.log('   • Role:', user.role);
    console.log('   • Dashboard access unlocked at: http://localhost:4200/admin\n');

    await mongoose.disconnect();
  } catch (err) {
    console.error('❌  Database error:', err.message);
    process.exit(1);
  }
})();
