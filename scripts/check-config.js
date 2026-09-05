#!/usr/bin/env node
/**
 * check-config.js
 * ---------------
 * Fails the build on the deployment-configuration mistakes that have taken
 * this site down before. Each one shares a nasty property: nothing errors at
 * the time, the damage only shows up as broken behaviour hours later.
 *
 *   1. A UTF-8 BOM (or any syntax error) in vercel.json. Vercel silently stops
 *      applying the config, so deploys quietly stop landing and the live site
 *      keeps serving an old build.
 *   2. A hardcoded MongoDB URI in source. One of these sat in server.js as a
 *      "fallback", so an unset MONGODB_URI connected to an unrelated cluster
 *      instead of failing, and every account lookup missed.
 *   3. A vercel.json that caches the app shell. Hashed assets are immutable for
 *      a year, so a cached shell keeps naming chunk files the next deploy
 *      deleted and the app cannot boot.
 *
 * Usage: node scripts/check-config.js
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const problems = [];

function readIfPresent(relativePath) {
  const full = path.join(repoRoot, relativePath);
  return fs.existsSync(full) ? { full, buffer: fs.readFileSync(full) } : null;
}

// ---- 1 & 3. vercel.json parses, and does not cache the shell ---------------
for (const relativePath of ['vercel.json', 'frontend/vercel.json']) {
  const file = readIfPresent(relativePath);
  if (!file) continue;

  if (file.buffer[0] === 0xEF && file.buffer[1] === 0xBB && file.buffer[2] === 0xBF) {
    problems.push(`${relativePath} starts with a UTF-8 BOM, which makes it invalid JSON. Vercel will ignore the whole config and deploys will stop landing.`);
    continue;
  }

  let config;
  try {
    config = JSON.parse(file.buffer.toString('utf8'));
  } catch (err) {
    problems.push(`${relativePath} is not valid JSON: ${err.message}`);
    continue;
  }

  const headers = Array.isArray(config.headers) ? config.headers : [];
  const shellRule = headers.find(rule => rule.source === '/');
  if (!shellRule) {
    problems.push(`${relativePath} has no cache rule for "/". Browsers request the shell as "/", not "/index.html", so it will be served from cache and keep asking for chunk files that a later deploy removed.`);
  } else {
    const cacheControl = (shellRule.headers || []).find(h => String(h.key).toLowerCase() === 'cache-control');
    if (!cacheControl || !/no-store/.test(cacheControl.value)) {
      problems.push(`${relativePath} caches "/". The app shell must be no-store so it can never outlive the hashed assets it names.`);
    }
  }
}

// ---- 2. No credentials baked into source -----------------------------------
const sourceFiles = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.angular'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (/\.(js|ts)$/.test(entry.name)) sourceFiles.push(full);
  }
})(repoRoot);

for (const full of sourceFiles) {
  // Comments legitimately carry example URIs (usage docs, placeholders), so
  // only real code counts.
  const code = fs.readFileSync(full, 'utf8')
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');

  // A connection string carrying credentials, rather than one read from env.
  const match = code.match(/mongodb(?:\+srv)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
  if (match) {
    problems.push(`${path.relative(repoRoot, full)} contains a hardcoded MongoDB URI with credentials. Read it from MONGODB_URI instead — a fallback connection string means a missing variable fails silently against the wrong cluster.`);
  }
}

if (problems.length > 0) {
  console.error('\nConfiguration check failed:\n');
  problems.forEach(problem => console.error(`  • ${problem}\n`));
  process.exit(1);
}

console.log('Configuration check passed.');
