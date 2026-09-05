/**
 * db-health.js
 * ------------
 * Read-mostly diagnostic for the three database faults that can break
 * login and/or registration while the rest of the site keeps working.
 *
 * Usage (from the backend folder):
 *   node db-health.js
 *
 * To check the DEPLOYED database rather than the one in .env, pass the
 * production URI from Render:
 *   node db-health.js "mongodb+srv://user:pass@cluster0.../ligibet"
 *
 * Never prints credentials.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.argv[2] || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ligibet';

function describeUri(uri) {
  // Strip credentials, keep host + database path so we can see which DB is targeted.
  const redacted = uri.replace(/\/\/[^@]*@/, '//<credentials>@');
  const afterHost = redacted.split('/').slice(3).join('/');
  const dbInPath = (afterHost.split('?')[0] || '').trim();
  return { redacted, dbInPath };
}

async function run() {
  const { redacted, dbInPath } = describeUri(MONGODB_URI);
  console.log('URI:            ', redacted);
  console.log('DB name in URI: ', dbInPath ? dbInPath : '(none — the driver will fall back to "test")');

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    tlsAllowInvalidCertificates: true
  });

  const db = mongoose.connection.db;
  console.log('\n--- CONNECTED ---');
  console.log('Actual database:', db.databaseName);

  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  console.log('Collections:    ', collections.length ? collections.join(', ') : '(empty database)');

  // ---- 1. Are the user records where the app is looking? -------------------
  const users = db.collection('users');
  const userCount = await users.countDocuments();
  console.log('\n--- USERS ---');
  console.log('User count:', userCount);
  if (userCount === 0) {
    console.log('>> EMPTY. Every login attempt will return "Invalid phone number or password",');
    console.log('>> because no account can ever be found. Usually means the URI points at the');
    console.log('>> wrong database (see "DB name in URI" above).');
  } else {
    const sample = await users
      .find({}, { projection: { id: 1, username: 1, role: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .limit(5)
      .toArray();
    console.log('Most recent accounts:');
    sample.forEach((u) => {
      console.log(`  id=${u.id}  username=${u.username}  role=${u.role}  created=${u.created_at}`);
    });
  }

  // ---- 2. Is the auto-increment counter behind the real max id? ------------
  // If it is, every registration dies on a duplicate-key error for `id`.
  const maxIdDoc = await users.find({}, { projection: { id: 1 } }).sort({ id: -1 }).limit(1).toArray();
  const maxId = maxIdDoc.length ? maxIdDoc[0].id : 0;
  const counter = await db.collection('counters').findOne({ _id: 'users_id' });
  const counterSeq = counter ? counter.seq : null;
  console.log('\n--- ID COUNTER ---');
  console.log('Highest existing user id:', maxId);
  console.log('counters.users_id.seq:   ', counterSeq === null ? '(missing)' : counterSeq);
  if (counterSeq === null || counterSeq < maxId) {
    console.log('>> BROKEN. The next registration will be assigned an id that already exists,');
    console.log('>> and the unique index on `id` will reject it with E11000 — the API returns');
    console.log('>> "Internal server error during registration" for every new signup.');
    console.log(`>> Fix: db.counters.updateOne({_id:"users_id"},{$set:{seq:${maxId}}},{upsert:true})`);
  } else {
    console.log('OK — counter is ahead of the highest existing id.');
  }

  // ---- 3. Does the cluster still accept writes? ----------------------------
  // Atlas M0 goes read-only once the 512MB storage quota is exceeded, which
  // breaks registration while leaving login (a pure read) working.
  console.log('\n--- WRITE TEST ---');
  try {
    const probe = db.collection('_write_probe');
    await probe.insertOne({ at: new Date() });
    await probe.deleteMany({});
    console.log('OK — the cluster accepts writes.');
  } catch (err) {
    console.log('>> WRITES ARE FAILING:', err.message);
    console.log('>> Registration cannot succeed. Check the Atlas storage quota (M0 is 512MB)');
    console.log('>> and whether the cluster has been placed in read-only mode.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('\nFAILED:', err.message);
  console.error('If this is a connection error, the database is unreachable from here —');
  console.error('check the Atlas IP allowlist and whether the cluster is paused.');
  process.exit(1);
});
