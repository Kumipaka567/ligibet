// Run privately on your own terminal. Raw key input is hidden and never saved.
const readline = require('readline');
const { Writable } = require('stream');
const bcrypt = require('bcryptjs');

if (!process.stdin.isTTY) {
  console.error('Run this command in an interactive terminal to enter your private owner key securely.');
  process.exit(1);
}

let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
function ask(prompt) {
  process.stdout.write(prompt);
  muted = true;
  return new Promise(resolve => rl.question('', answer => { muted = false; process.stdout.write('\n'); resolve(answer); }));
}
(async () => {
  try {
    const key = await ask('Choose your private owner key (4–72 characters): ');
    const confirmation = await ask('Confirm private owner key: ');
    if (key !== confirmation || key.length < 4 || Buffer.byteLength(key, 'utf8') > 72) throw new Error('Keys must match and contain 4–72 bytes.');
    const hash = await bcrypt.hash(key, 12);
    console.log('\nSet this environment variable on the backend server, then restart it:');
    console.log('ADMIN_PIN_SETUP_KEY_HASH=' + hash);
    console.log('\nKeep the original owner key private. Use it in Administrators > Private PIN setup.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { rl.close(); }
})();
