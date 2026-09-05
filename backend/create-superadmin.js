/**
 * create-superadmin.js
 * --------------------
 * Creates a brand-new Superadmin account directly in MongoDB.
 *
 * Usage:
 *   node create-superadmin.js <username> <phone_number> <password>
 *
 * Example:
 *   node create-superadmin.js superadmin 254712345678 Admin@2026
 *
 * If no arguments are provided, it creates a default Superadmin:
 *   Username: superadmin
 *   Phone:    +254700000000
 *   Password: SuperAdmin@2026
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { User, getNextSequenceValue } = require('./models');

function escapeRegExp(string) {
  return String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ligibet';

const inputUsername = process.argv[2] || 'superadmin';
const inputPhone = process.argv[3] || '+254700000000';
const inputPassword = process.argv[4] || 'SuperAdmin@2026';

async function run() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB.');

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
        balance: 10000.00
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
    console.log(`👉 You can now log in at http://localhost:4200/login`);
    console.log(`👉 Access dashboard at http://localhost:4200/admin\n`);

    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ Error creating superadmin:', err.message);
    process.exit(1);
  }
}

run();
