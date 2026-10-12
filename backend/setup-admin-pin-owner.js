// Run privately. Hidden input is hashed and saved directly to the configured database.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const readline = require('readline');
const { Writable } = require('stream');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const models = require('./models');
const { migratePinSettings } = require('./admin-pin-database');

if (!process.stdin.isTTY && !process.argv.includes('--migrate')) {
  console.error('Run this command in an interactive terminal to enter your private owner key securely.');
  process.exit(1);
}

let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const rl = process.argv.includes('--migrate') ? null : readline.createInterface({ input: process.stdin, output, terminal: true });
function ask(prompt) {
  process.stdout.write(prompt);
  muted = true;
  return new Promise(resolve => rl.question('', answer => { muted = false; process.stdout.write('\n'); resolve(answer); }));
}
(async () => {
  try {
    const uri = (process.env.MONGODB_URI || '').trim();
    if (!/^mongodb(?:\+srv)?:\/\/[^/]+\/[^?\s]+/.test(uri)) throw new Error('Configure MONGODB_URI with an explicit database name first.');
    if (process.argv.includes('--migrate')) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      if (!await migratePinSettings(models, process.env)) throw new Error('No existing owner-key hash was found. Run setup-pin-owner interactively.');
      console.log('Owner key and any legacy admin PIN hashes are saved in MongoDB.');
      return;
    }
    const key = await ask('Choose your private owner key (4–72 characters): ');
    const confirmation = await ask('Confirm private owner key: ');
    if (key !== confirmation || key.length < 4 || Buffer.byteLength(key, 'utf8') > 72) throw new Error('Keys must match and contain 4–72 bytes.');
    const hash = await bcrypt.hash(key, 12);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    await models.AdminPinSettings.updateOne({ _id: 'owner' }, { $set: { owner_key_hash: hash, updated_at: new Date() } }, { upsert: true });
    await models.AdminPinAttempt.deleteOne({ _id: 'owner-setup' });
    console.log('Private owner key saved in MongoDB. Use it in Administrators > Private PIN setup.');
  } catch (error) {
    console.error(error.name === 'Error' ? error.message : 'Database owner-key setup failed. Check the configured MongoDB connection and access.');
    process.exitCode = 1;
  }
  finally { rl?.close(); await mongoose.disconnect(); }
})();
