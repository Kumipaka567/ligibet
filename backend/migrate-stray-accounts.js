/**
 * migrate-stray-accounts.js  (one-off recovery, safe to re-run)
 * -------------------------------------------------------------
 * While production was pointed at the wrong cluster, real players registered
 * into a database nobody was serving. This moves those accounts back into the
 * live database, keeping their password hashes so they can log in normally.
 *
 * Rules:
 *   - Only role "user" is moved. Admin/superadmin roles are left behind so
 *     privileges are never granted by a migration; promote deliberately.
 *   - An account already present in the target (by username or phone) is
 *     skipped, so re-running cannot duplicate anyone.
 *   - New ids come from the target's own counter, never the source's, because
 *     the source ids (1..17) collide with real accounts in the target.
 *   - Diagnostic probe accounts are removed rather than migrated.
 */
// mongodb+srv resolution fails intermittently on the local resolver with
// "Server record does not share hostname with parent URI". server.js pins
// public DNS for the same reason.
const dns = require('dns');
try { dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']); } catch (e) {}

const mongoose = require('mongoose');

const SOURCE_URI = process.argv[2];
const TARGET_URI = process.argv[3];
const APPLY = process.argv.includes('--apply');

const PROBE_ACCOUNTS = ['+25479900253', '+25479915675', '+25479927033'];

async function nextUserId(db) {
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: 'users_id' },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  );
  return (result.value || result).seq;
}

async function run() {
  const source = await mongoose.createConnection(SOURCE_URI, { serverSelectionTimeoutMS: 20000 }).asPromise();
  const target = await mongoose.createConnection(TARGET_URI, { serverSelectionTimeoutMS: 20000 }).asPromise();

  console.log(`source: ${source.db.databaseName}   target: ${target.db.databaseName}`);
  console.log(APPLY ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n');

  const candidates = await source.db.collection('users').find({ role: 'user' }).toArray();
  const moved = [];
  const skipped = [];

  for (const user of candidates) {
    if (PROBE_ACCOUNTS.includes(user.username)) {
      skipped.push(`${user.username} (diagnostic probe)`);
      continue;
    }

    const clash = await target.db.collection('users').findOne({
      $or: [{ username: user.username }, { phone_number: user.phone_number }]
    });
    if (clash) {
      skipped.push(`${user.username} (already present as id=${clash.id})`);
      continue;
    }

    if (APPLY) {
      const id = await nextUserId(target.db);
      await target.db.collection('users').insertOne({
        id,
        username: user.username,
        phone_number: user.phone_number,
        password_hash: user.password_hash,
        role: 'user',
        balance: user.balance || 0,
        is_suspended: false,
        has_custom_withdrawal_popup: false,
        custom_withdrawal_title: null,
        custom_withdrawal_message: null,
        created_at: user.created_at || new Date()
      });
      moved.push(`${user.username} -> id=${id}`);
    } else {
      moved.push(`${user.username} (would move)`);
    }
  }

  console.log(`MIGRATED (${moved.length}):`);
  moved.forEach(m => console.log(`   ${m}`));
  console.log(`\nSKIPPED (${skipped.length}):`);
  skipped.forEach(s => console.log(`   ${s}`));

  // Remove the probe accounts this investigation created.
  const removal = APPLY
    ? await target.db.collection('users').deleteMany({ username: { $in: PROBE_ACCOUNTS } })
    : { deletedCount: await target.db.collection('users').countDocuments({ username: { $in: PROBE_ACCOUNTS } }) };
  console.log(`\nPROBE ACCOUNTS REMOVED FROM TARGET: ${removal.deletedCount}`);

  console.log(`\nTARGET USER TOTAL: ${await target.db.collection('users').countDocuments()}`);

  await source.close();
  await target.close();
}

run().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
