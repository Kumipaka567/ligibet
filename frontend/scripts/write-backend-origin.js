#!/usr/bin/env node
/**
 * write-backend-origin.js
 * -----------------------
 * Bakes the API origin into the bundle before `ng build` runs.
 *
 * Angular compiles to static files, so there is no runtime environment on the
 * CDN that serves them: the API origin has to be decided at build time. This
 * script writes BACKEND_ORIGIN into the generated config the app imports, which
 * is what lets the same commit deploy to Vercel (pointing at the Render API)
 * and to Render (pointing at itself) without a source edit in between.
 *
 * With BACKEND_ORIGIN unset the committed default is left exactly as it is, so
 * a local `npm run build` stays reproducible.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'src', 'app', 'core', 'config', 'backend-origin.generated.ts');
const raw = (process.env.BACKEND_ORIGIN || '').trim();

if (!raw) {
  const current = fs.readFileSync(target, 'utf8').match(/PRODUCTION_BACKEND_ORIGIN = '([^']*)'/);
  console.log(`BACKEND_ORIGIN not set; keeping committed default ${current ? current[1] : '(unknown)'}.`);
  process.exit(0);
}

// A trailing slash produces "https://api.example.com//api/login", which some
// proxies answer with a redirect that drops the Authorization header. Normalise
// it here rather than at every call site.
let origin;
try {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('must be http or https');
  origin = parsed.origin;
} catch (err) {
  console.error(`BACKEND_ORIGIN is not a valid http(s) URL: ${raw} (${err.message})`);
  process.exit(1);
}

const contents = fs.readFileSync(target, 'utf8')
  .replace(/PRODUCTION_BACKEND_ORIGIN = '[^']*'/, `PRODUCTION_BACKEND_ORIGIN = '${origin}'`);

fs.writeFileSync(target, contents);
console.log(`Backend origin set to ${origin}.`);
