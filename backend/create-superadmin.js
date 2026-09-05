/**
 * create-superadmin.js
 * --------------------
 * Creates the first Superadmin account directly in MongoDB, or promotes an
 * existing user to Superadmin and resets their password.
 *
 * Usage:
 *   node create-superadmin.js <username> <phone_number> <password>
 *
 * Example:
 *   node create-superadmin.js admin 254712345678 'a long passphrase'
 *
 * All three arguments are required and MONGODB_URI must be set. There are
 * deliberately no defaults: this script mints an account that can approve
 * withdrawals, and a default username and password committed to the repository
 * is a published credential for every deployment that ever runs it bare.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { User, getNextSequenceValue } = require('./models');

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// No localhost fallback. Running this with MONGODB_URI unset would report
// complete success while writing the superadmin into a database nobody is
// serving, and the account would simply not exist when you tried to log in.
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
if (!MONGODB_URI) {
  fail('MONGODB_URI is not set. Refusing to guess a database.');
}

const [, , inputUsername, inputPhone, inputPassword] = process.argv;
if (!inputUsername || !inputPhone || !inputPassword) {
  fail('Usage: node create-superadmin.js <username> <phone_number> <password>');
}
if (inputPassword.length < 12) {
  fail('Choose a password of at least 12 characters. This account can approve withdrawals.');
}

async function run() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}.`);

    const username = inputUsername.trim();
    const phone = inputPhone.trim();

    // Check if user already exists
    let user = await User.findOne({
      $or: [
        { username: new RegExp(`^${escapeRegExp(username)}$`, 'i') },
        { phone_number: phone }
      ]
    });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(inputPassword, salt);

    if (user) {
      user.role = 'superadmin';
      user.password_hash = passwordHash;
      user.is_suspended = false;
      await user.save();
      console.log(`\n=======================================================`);
      console.log(`✅  Existing user "${user.username}" updated to SUPERADMIN!`);
      console.log(`=======================================================`);
    } else {
      const nextId = await getNextSequenceValue('users_id');
      user = await User.create({
        id: nextId,
        username,
        phone_number: phone,
        password_hash: passwordHash,
        role: 'superadmin',
        // Opens at zero. A starting balance here is money that entered the
        // ledger without a deposit behind it, which makes every payout
        // reconciliation afterwards disagree with what actually came in.
        balance: 0
      });
      console.log(`\n=======================================================`);
      console.log(`✅  New SUPERADMIN account created successfully!`);
      console.log(`=======================================================`);
    }

    console.log(`   Username: ${user.username}`);
    console.log(`   Phone:    ${user.phone_number}`);
    console.log(`   Password: [not shown]`);
    console.log(`   Role:     ${user.role}`);
    console.log(`   Balance:  KES ${user.balance}`);
    console.log(`=======================================================`);
    console.log(`👉 Log in at https://ligibet.site/login`);
    console.log(`👉 Admin dashboard at https://ligibet.site/admin\n`);

    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ Error creating superadmin:', err.message);
    process.exit(1);
  }
}

run();
