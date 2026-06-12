#!/usr/bin/env node
/**
 * Mechanical splitter for src/crm/routes.ts.
 *
 * Walks the file once, emits 11 domain files under src/crm/routes/, then
 * rewrites src/crm/routes.ts as a thin orchestrator that calls each
 * registerXRoutes(app) in the original registration order.
 *
 * Idempotent — re-running overwrites the routes/ folder. The .bak file
 * remains untouched.
 *
 * Run: node scripts/split-routes.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src', 'crm', 'routes.ts');
const SRC_BAK = path.resolve(__dirname, '..', 'src', 'crm', 'routes.ts.bak');
const OUT_DIR = path.resolve(__dirname, '..', 'src', 'crm', 'routes');

// Always read from the .bak (the immutable source of truth) so re-running
// the script is safe after the orchestrator has already replaced routes.ts.
const SOURCE_FILE = fs.existsSync(SRC_BAK) ? SRC_BAK : SRC;

// ──────────────────────────────────────────────────────────────────────
// 1) Read source and split into a header (everything before the first
//    app.<method> call after the helpers) and a tail of route blocks.
// ──────────────────────────────────────────────────────────────────────
const source = fs.readFileSync(SOURCE_FILE, 'utf-8');
const lines = source.split('\n');

// Find the first `app.<verb>(` AFTER our helpers — header ends here.
// We keep `app.use('*', ...)` middlewares in the orchestrator as-is.
let firstRouteIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^app\.(get|post|put|delete|patch|on)\(/.test(lines[i])) {
    firstRouteIdx = i;
    break;
  }
}
if (firstRouteIdx < 0) throw new Error('no app.<verb> calls found');

// We don't actually use a fixed "header" — we'll compute helpers and
// imports from the SET of lines that aren't inside any route block. That
// way inline helpers like actorOf/ipOf defined between route groups are
// also captured.

// ──────────────────────────────────────────────────────────────────────
// 2) Walk from firstRouteIdx to EOF, slicing into route blocks. A new
//    block starts every time we see a top-level `app.<verb>(` line.
//    A block ends one line before the next block, OR at the line of
//    `export default app;` (which we drop — orchestrator handles export).
// ──────────────────────────────────────────────────────────────────────
const blocks = []; // [{ method, path, startLine, endLine, content }]

const APP_VERB_RX = /^app\.(get|post|put|delete|patch|on)\(\s*['"]([^'"]+)['"]/;
const EXPORT_RX = /^export\s+default\s+app\s*;?\s*$/;

let cursor = firstRouteIdx;
while (cursor < lines.length) {
  const line = lines[cursor];
  if (EXPORT_RX.test(line)) break;
  const m = line.match(APP_VERB_RX);
  if (!m) {
    // Should not happen — the file is well-formed (app.<verb>'s are at
    // top level). Ignore stray comments / blank lines between blocks
    // (there aren't any in practice — every block starts with app.<verb>).
    cursor++;
    continue;
  }
  const method = m[1];
  const routePath = m[2];

  // Find end of THIS block: the line whose closing `});`/`)` lands at
  // column 0 — that's the closing of `app.<verb>('/path', handler)`.
  // Single-line routes (e.g. `app.get('/x', (c) => ok(c, store.foo()));`)
  // close on the start line itself.
  const startLine = lines[cursor];
  let end;
  if (/\)\s*;?\s*$/.test(startLine) && balancedOnLine(startLine)) {
    // One-liner — block is just this line.
    end = cursor + 1;
  } else {
    end = cursor + 1;
    while (end < lines.length) {
      const l = lines[end];
      // The closing `});` or `})` of the app.<verb>(...) call lives at
      // column 0 (it isn't indented like body code).
      if (/^\}\)\s*;?\s*$/.test(l)) {
        end++;            // include the closing line itself
        break;
      }
      if (APP_VERB_RX.test(l) || EXPORT_RX.test(l)) break;
      end++;
    }
  }
  blocks.push({
    method,
    path: routePath,
    startLine: cursor,
    endLine: end - 1,
    content: lines.slice(cursor, end).join('\n'),
  });
  cursor = end;
}

// Helper: check whether a single line has balanced parens (so the route
// fits on one line and doesn't span multiple).
function balancedOnLine(s) {
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return depth === 0;
}

console.log(`[split-routes] ${blocks.length} route blocks extracted`);

// ──────────────────────────────────────────────────────────────────────
// 3) Categorize each block into one of the 11 target files.
// ──────────────────────────────────────────────────────────────────────
function classify(routePath) {
  const seg = routePath.split('/').filter(Boolean)[0] ?? '';

  // Auth / onboarding
  if (routePath === '/init' || routePath === '/auth/exchange' || seg === 'auth') return 'auth-exchange';

  // Cards-cluster: anything that lives on the kanban card itself
  if (
    seg === 'cards' || seg === 'activities' || seg === 'tasks' ||
    seg === 'reminders' || seg === 'chat' || seg === 'appointments' ||
    seg === 'calendar' || seg === 'notes' || seg === 'card-comments' ||
    seg === 'comments' || seg === 'mentions'
  ) return 'cards';

  // Boards / columns
  if (seg === 'boards' || seg === 'columns' || seg === 'pipelines') return 'boards';

  // Contacts / segments / mass mailing
  if (
    seg === 'contacts' || seg === 'segments' || seg === 'forms' ||
    seg === 'campaigns' || seg === 'bulk' || seg === 'email-templates' ||
    seg === 'sequences' || seg === 'unsubscribes' || seg === 'landing'
  ) return 'contacts';

  // People / admin / security / compliance
  if (
    seg === 'agents' || seg === 'admin' || seg === 'security' ||
    seg === 'compliance' || seg === 'lgpd' || seg === 'audit' ||
    seg === 'sessions' || seg === '2fa' || seg === 'sso' ||
    seg === 'rbac' || seg === 'roles' || seg === 'permissions' ||
    seg === 'consents' || seg === 'data-subject'
  ) return 'agents';

  // Channels / integrations / inbound webhooks
  if (seg === 'channels' || seg === 'external-integrations' || seg === 'webhooks') return 'channels';

  // Subscriptions / billing-recurring
  if (seg === 'subscriptions' || seg === 'coupons' || seg === 'invoices' || seg === 'dunning') return 'subscriptions';

  // Inventory / docs / proposals
  if (
    seg === 'inventory' || seg === 'documents' || seg === 'proposals' ||
    seg === 'line-items' || seg === 'orders' || seg === 'document-templates' ||
    seg === 'signatures' || seg === 'movements' || seg === 'variants' ||
    seg === 'categories' || seg === 'stock'
  ) return 'inventory';

  // Automations / outbound webhooks / triggers
  if (
    seg === 'automations' || seg === 'outbound-webhooks' || seg === 'triggers' ||
    seg === 'rules' || seg === 'assignment-rules'
  ) return 'automations';

  // Media + AI
  if (seg === 'media' || seg === 'ai' || seg === 'insights') return 'media';

  // Reports / analytics / gamification / saved views
  if (
    seg === 'reports' || seg === 'scheduled-reports' || seg === 'analytics' ||
    seg === 'goals' || seg === 'leaderboard' || seg === 'badges' ||
    seg === 'saved-views' || seg === 'metrics' || seg === 'dashboard' ||
    seg === 'stats' || seg === 'health'
  ) return 'stats';

  // Settings, events stream, anything not yet matched: bucket into the
  // "agents" group (admin-shaped) since most are tenant-level config.
  if (seg === 'settings' || seg === 'events' || seg === '' || seg === 'channel-templates') return 'agents';

  console.warn(`[split-routes] unmatched path → falling back to "agents": ${routePath}`);
  return 'agents';
}

// ──────────────────────────────────────────────────────────────────────
// 4) Group blocks by target file, preserving original order within each.
// ──────────────────────────────────────────────────────────────────────
const TARGETS = [
  'auth-exchange', 'boards', 'cards', 'contacts', 'agents', 'channels',
  'subscriptions', 'inventory', 'automations', 'media', 'stats',
];
const grouped = Object.fromEntries(TARGETS.map((t) => [t, []]));
for (const b of blocks) grouped[classify(b.path)].push(b);

// ──────────────────────────────────────────────────────────────────────
// 5) Build file contents.
// ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

// All "outside-route" lines: everything that isn't inside any block,
// excluding the export default line we already strip.
const insideRoute = new Set();
for (const b of blocks) {
  for (let i = b.startLine; i <= b.endLine; i++) insideRoute.add(i);
}
const outside = lines
  .map((line, i) => ({ line, i }))
  .filter(({ i }) => !insideRoute.has(i))
  .filter(({ line }) => !EXPORT_RX.test(line))
  .map(({ line }) => line);

// The domain files live one directory deeper (src/crm/routes/), so all
// relative import paths need an extra `../`.
//   from './foo.js'        → from '../foo.js'
//   from '../tenancy/x.js'  → from '../../tenancy/x.js'
function rewriteImportPath(line) {
  return line.replace(/from\s+(['"])(\.\.?\/)/g, (_, q, prefix) => `from ${q}../${prefix}`);
}

const importBlock = outside
  .filter((l) => /^import\s/.test(l) || /^import\b/.test(l))
  .map(rewriteImportPath)
  .join('\n');

// Helpers = everything outside route blocks that isn't an import, the
// `const app = new Hono()` line, an `app.use(*)` middleware mount, the
// section banner comments (`// ═══ ...`), or blank lines we'd duplicate.
const helperBlock = outside
  .filter((l) => {
    if (/^import\s/.test(l)) return false;
    if (/^import\b/.test(l)) return false;
    if (/^const app = new Hono/.test(l)) return false;
    if (/^app\.use\(/.test(l)) return false;
    if (/^\/\/ ═══/.test(l)) return false;
    return true;
  })
  .join('\n')
  // Collapse runs of 3+ blank lines to 2 — keeps emitted files tidy.
  .replace(/\n{3,}/g, '\n\n');

function fileHeader(name) {
  return `// AUTO-GENERATED BY scripts/split-routes.cjs — do not edit by hand.
// Edit src/crm/routes.ts instead, then re-run \`node scripts/split-routes.cjs\`.
//
// Domain: ${name}
${importBlock}
${helperBlock}
`;
}

let totalRoutes = 0;
for (const target of TARGETS) {
  const blocksForTarget = grouped[target];
  totalRoutes += blocksForTarget.length;

  const fnName = `register${target
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')}Routes`;

  let body = '';
  for (const b of blocksForTarget) {
    // Rewrite relative paths in the block body too — handlers may use
    // `import('./foo.js')` or `await import('../tenancy/x.js')`. Same
    // shift as the static import rewrite above.
    const rewritten = b.content
      .replace(/\bimport\(\s*(['"])(\.\.?\/)/g, (_, q, prefix) => `import(${q}../${prefix}`)
      .replace(/\brequire\(\s*(['"])(\.\.?\/)/g, (_, q, prefix) => `require(${q}../${prefix}`);
    // Indent each line by 2 spaces inside the registerX function.
    const indented = rewritten
      .split('\n')
      .map((l) => (l.length ? '  ' + l : l))
      .join('\n');
    body += indented + '\n';
  }

  const fileBody = `${fileHeader(target)}
export function ${fnName}(app: Hono): void {
${body}}
`;

  fs.writeFileSync(path.join(OUT_DIR, `${target}.ts`), fileBody);
  console.log(`[split-routes] ${target}.ts: ${blocksForTarget.length} routes`);
}

console.log(`[split-routes] total: ${totalRoutes} routes (expected ${blocks.length})`);
if (totalRoutes !== blocks.length) {
  throw new Error(`route count mismatch — ${blocks.length} input vs ${totalRoutes} output`);
}

// ──────────────────────────────────────────────────────────────────────
// 6) Rewrite src/crm/routes.ts as a thin orchestrator. Imports the 11
//    register functions and calls them in the SAME ORDER as the original
//    file's first appearance of each domain (so route precedence matches
//    Hono's first-match-wins behavior).
// ──────────────────────────────────────────────────────────────────────
//
// Order = order in which a domain's first route appeared in the original
// file. We compute it from `blocks` in their original order.
const firstAppearance = new Map();
for (const b of blocks) {
  const t = classify(b.path);
  if (!firstAppearance.has(t)) firstAppearance.set(t, b.startLine);
}
const orderedTargets = [...firstAppearance.entries()]
  .sort((a, b) => a[1] - b[1])
  .map((e) => e[0]);

const orchestrator = `/**
 * CRM REST API routes — mounted at /v1/crm.
 *
 * This file is the ORCHESTRATOR. The actual endpoint handlers live in
 * src/crm/routes/{boards,cards,contacts,...}.ts and are wired up here in
 * the same order they appeared in the previous monolithic version, so
 * Hono's first-match-wins routing behavior is preserved exactly.
 *
 * To add a new route:
 *   - Add its handler to the appropriate domain file in src/crm/routes/
 *   - It will be picked up automatically (the registerX function loops
 *     are the entry points called below).
 */
import { Hono } from 'hono';
import * as rl from './rateLimiter.js';
import { fieldSelectionMiddleware } from './fieldSelector.js';

${orderedTargets.map((t) => {
  const fnName = `register${t.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}Routes`;
  return `import { ${fnName} } from './routes/${t}.js';`;
}).join('\n')}

const app = new Hono();

// ═══ ONDA 30: Rate limit + field selection middlewares ════════════════
app.use('*', rl.rateLimitMiddleware());
app.use('*', fieldSelectionMiddleware());

${orderedTargets.map((t) => {
  const fnName = `register${t.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}Routes`;
  return `${fnName}(app);`;
}).join('\n')}

export default app;
`;

fs.writeFileSync(SRC, orchestrator);
console.log(`[split-routes] orchestrator written, ${orderedTargets.length} domain modules wired up`);
