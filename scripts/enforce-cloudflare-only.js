// Choice Properties — Cloudflare-Only Environment Enforcer
// Runs automatically as the `preinstall` npm hook.
// Blocks execution if a Replit or non-Cloudflare environment is detected.
// This script uses only Node.js built-ins (no npm dependencies).

const fs   = require('fs');
const path = require('path');

const errors   = [];
const warnings = [];

// ── 1. Detect Replit runtime ──────────────────────────────────────────────
const replitSignals = [
  'REPL_ID',
  'REPL_SLUG',
  'REPL_OWNER',
  'REPLIT_DB_URL',
  'REPLIT_CLUSTER',
  'REPLIT_DEPLOYMENT',
];

const foundReplitVars = replitSignals.filter(v => process.env[v]);
if (foundReplitVars.length > 0) {
  errors.push(
    `Replit runtime detected via environment variables: ${foundReplitVars.join(', ')}`,
    'This project runs ONLY on Cloudflare Pages.',
    'Do not run npm install or npm start inside Replit.',
    'Edit files here and push to GitHub — Cloudflare Pages builds automatically.'
  );
}

// ── 2. Detect forbidden Replit files in the repo ──────────────────────────
// Skip this check inside a Cloudflare Pages build (CF_PAGES=1 is set automatically).
// replit.md / serve.js may be git-tracked from before the .gitignore rule was added;
// blocking on file presence would break every Cloudflare build.  The Replit env-var
// check above (REPL_ID etc.) is the authoritative signal for blocking Replit installs.
const isCloudflareBuild = process.env.CF_PAGES === '1';

if (!isCloudflareBuild) {
  const forbiddenFiles = [
    'replit.nix',
    'replit.md',
    'REPLIT_SAFETY.md',
    'server.js',
    'scripts/generate-config-replit.js',
  ];

  for (const f of forbiddenFiles) {
    if (fs.existsSync(path.join(process.cwd(), f))) {
      errors.push(`Forbidden file found in repository: ${f}`);
    }
  }
}

// ── 3. Detect forbidden local-database environment variables ─────────────
const forbiddenEnvVars = ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT'];
const foundDbVars = forbiddenEnvVars.filter(v => process.env[v]);
if (foundDbVars.length > 0) {
  errors.push(
    `Local database environment variables detected: ${foundDbVars.join(', ')}`,
    'This project uses Supabase cloud — no local database is used or permitted.'
  );
}

// ── 4. Detect forbidden npm packages ─────────────────────────────────────
const forbiddenPackages = [
  'express', 'fastify', 'koa', 'hapi',
  'pg', 'postgres', 'mysql', 'mysql2', 'sqlite', 'better-sqlite3',
  'prisma', 'drizzle-orm', 'sequelize', 'typeorm', 'knex',
  '@neondatabase/serverless', 'neon',
];

let pkgJson = {};
try {
  pkgJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
} catch (_) {}

const allDeps = {
  ...pkgJson.dependencies,
  ...pkgJson.devDependencies,
};

const foundForbiddenPkgs = forbiddenPackages.filter(p => allDeps[p]);
if (foundForbiddenPkgs.length > 0) {
  errors.push(
    `Forbidden packages found in package.json: ${foundForbiddenPkgs.join(', ')}`,
    'This project uses no backend packages. Hosting is Cloudflare Pages, backend is Supabase.'
  );
}

// ── Output ────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  console.warn('\n⚠  Choice Properties — Cloudflare-Only Warnings:');
  warnings.forEach(w => console.warn('   ' + w));
}

if (errors.length > 0) {
  console.error('\n❌ Choice Properties — Cloudflare-Only Enforcement FAILED\n');
  errors.forEach(e => console.error('   ' + e));
  console.error('\n   Correct workflow:');
  console.error('     1. Edit files in your editor');
  console.error('     2. git push to GitHub');
  console.error('     3. Cloudflare Pages builds and deploys automatically');
  console.error('     4. Supabase remains the only backend\n');
  process.exit(1);
}

console.log('✅ Choice Properties — Cloudflare-only environment check passed.');
