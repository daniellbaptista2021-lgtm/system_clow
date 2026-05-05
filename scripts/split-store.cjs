#!/usr/bin/env node
/**
 * Mechanical splitter for src/crm/store.ts.
 *
 *  - Reads src/crm/store.ts.bak (immutable source of truth)
 *  - Extracts every `export function ...` block
 *  - Categorizes by function name → 8 entity files under src/crm/store/
 *  - Pulls module-level state (lazy emitter caches, helpers like nid/J)
 *    into src/crm/store/_internals.ts so all entity files share ONE
 *    cache instance (critical: duplicating the lazy import caches would
 *    multiply re-imports under load).
 *  - Rewrites src/crm/store.ts as a barrel that re-exports everything,
 *    preserving backward-compat for any import { foo } from './store.js'.
 *
 * Idempotent — safe to re-run.
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src', 'crm', 'store.ts');
const SRC_BAK = path.resolve(__dirname, '..', 'src', 'crm', 'store.ts.bak');
const OUT_DIR = path.resolve(__dirname, '..', 'src', 'crm', 'store');
const SOURCE_FILE = fs.existsSync(SRC_BAK) ? SRC_BAK : SRC;

const source = fs.readFileSync(SOURCE_FILE, 'utf-8');
const lines = source.split('\n');

// ──────────────────────────────────────────────────────────────────────
// 1) Walk the file, extracting every TOP-LEVEL function declaration —
//    both `export function` (the public API) and `function` (private
//    helpers used by the exported ones). Each block starts at the
//    declaration line and ends at the first column-0 `}`.
// ──────────────────────────────────────────────────────────────────────
const FN_DECL_RX = /^(export\s+async\s+function|export\s+function|async\s+function|function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// These lazy emitter accessor functions stay in _internals.ts together
// with their backing `_*` cache vars. Moving them to entity files would
// orphan the caches, so we deliberately skip them during block extraction.
const KEEP_IN_INTERNALS = new Set([
  'getEmit', 'getAutoAssign', 'getCommitStock', 'getPublish',
]);

const blocks = []; // [{ name, isExported, startLine, endLine, content }]
let cursor = 0;
while (cursor < lines.length) {
  const m = lines[cursor].match(FN_DECL_RX);
  if (!m) {
    cursor++;
    continue;
  }
  const isExported = m[1].includes('export');
  const name = m[2];
  const startLine = cursor;
  let end = cursor + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (/^\}\s*$/.test(l)) { end++; break; }
    if (FN_DECL_RX.test(l)) break;
    end++;
  }

  // Lazy getters stay in _internals (alongside their cache variables);
  // we don't add them to the per-entity blocks. Their lines remain in
  // the "outside" set and flow into _internals.ts automatically.
  if (KEEP_IN_INTERNALS.has(name)) {
    cursor = end;
    continue;
  }

  blocks.push({
    name,
    isExported,
    startLine,
    endLine: end - 1,
    content: lines.slice(startLine, end).join('\n'),
  });
  cursor = end;
}

const exportedCount = blocks.filter((b) => b.isExported).length;
const privateCount = blocks.length - exportedCount;
console.log(`[split-store] ${blocks.length} function blocks extracted (${exportedCount} exported, ${privateCount} private helpers)`);

// ──────────────────────────────────────────────────────────────────────
// 2) Categorize each export by name.
// ──────────────────────────────────────────────────────────────────────
function classify(name) {
  // FIRST: functions that operate on Cards (regardless of filter dim).
  // listCardsByColumn/Board/Contact return Card[] and belong here even
  // though their names mention other entities.
  if (
    /^(list|get|count|search)Cards?(By|For|In)?[A-Z]?/.test(name) ||
    /^(create|update|delete|move|reorder|archive|unarchive|markCardRead)/.test(name) && /Card/.test(name)
  ) return 'cardsStore';

  // Boards: boards + columns + swimlanes + checklists
  if (
    /Board/.test(name) ||
    /Column/.test(name) ||
    /Swimlane/.test(name) ||
    /Checklist/.test(name) ||
    /Wip|wip/.test(name)
  ) return 'boardsStore';

  // Cards: cards + activities + reminders + labels + quick-replies
  if (
    /Card$|cards?[A-Z]|^get?Card|^list?Card|Card[A-Z]/.test(name) ||
    /Activity|Activities/.test(name) ||
    /Reminder/.test(name) ||
    /Label/.test(name) ||
    /QuickReply|QuickReplies/.test(name) ||
    /Mention/.test(name)
  ) return 'cardsStore';

  // Contacts: contacts + segments + inbox-rules + import/export
  if (
    /Contact/.test(name) ||
    /Segment/.test(name) ||
    /InboxRule/.test(name) ||
    /Duplicate/.test(name) ||
    /\bMerge\b|^merge[A-Z]/.test(name) ||
    /Csv|csv/.test(name) ||
    /^bulk[A-Z]/.test(name) ||
    /^buildHeaderMap$|^cleanPhone$|^normalizeHeader$/.test(name)
  ) return 'contactsStore';

  // Agents: agents + teams + roles + assignment + SLA
  if (
    /Agent/.test(name) ||
    /Team/.test(name) ||
    /sla|Sla|SLA/.test(name) ||
    /[Aa]ssignment/.test(name) ||
    /escalate/.test(name) ||
    /^rowToAsRule$|^matchCondition$/.test(name)
  ) return 'agentsStore';

  // Channels (incl templates + metrics + Meta sync)
  if (
    /[Cc]hannel/.test(name) ||
    /^upsertChannel|^incChannel/.test(name) ||
    /^syncMetaTemplates$/.test(name)
  ) return 'channelsStore';

  // Subscriptions: subs + invoices + coupons + dunning + stripe + MRR
  if (
    /Subscription/.test(name) ||
    /Invoice/.test(name) ||
    /Coupon/.test(name) ||
    /Dunning/.test(name) ||
    /StripeConnect|stripeConnect/.test(name) ||
    /Mrr|MRR/.test(name) ||
    /PaymentLink|TrialEnd|trial/i.test(name)
  ) return 'subscriptionsStore';

  // Inventory: items + variants + categories + movements + proposals
  if (
    /Inventory|Inv[A-Z]/.test(name) ||
    /Variant/.test(name) ||
    /Movement/.test(name) ||
    /lowStock|Stock/.test(name) ||
    /Proposal/.test(name)
  ) return 'inventoryStore';

  // Automations: schedules, webhooks, runs
  if (
    /Automation/.test(name) ||
    /Schedule/.test(name) ||
    /Webhook/.test(name) && !/Channel/.test(name)
  ) return 'automationsStore';

  console.warn(`[split-store] unmatched function "${name}" → falling back to cardsStore`);
  return 'cardsStore';
}

const TARGETS = [
  'boardsStore', 'cardsStore', 'contactsStore', 'agentsStore',
  'channelsStore', 'subscriptionsStore', 'inventoryStore', 'automationsStore',
];
const grouped = Object.fromEntries(TARGETS.map((t) => [t, []]));
for (const b of blocks) grouped[classify(b.name)].push(b);

// ──────────────────────────────────────────────────────────────────────
// 3) Extract module-level state and helpers (everything outside blocks).
//    These go into _internals.ts (NOT duplicated per file — the lazy
//    caches must be singletons).
// ──────────────────────────────────────────────────────────────────────
const insideBlock = new Set();
for (const b of blocks) {
  for (let i = b.startLine; i <= b.endLine; i++) insideBlock.add(i);
}
const outsideLines = lines
  .map((line, i) => ({ line, i }))
  .filter(({ i }) => !insideBlock.has(i))
  .map(({ line }) => line);

// Domain files live one level deeper (src/crm/store/), so relative paths
// from the original need an extra `../`. Same logic as the routes splitter.
function rewritePath(line) {
  return line
    .replace(/from\s+(['"])(\.\.?\/)/g, (_, q, prefix) => `from ${q}../${prefix}`)
    .replace(/\bimport\(\s*(['"])(\.\.?\/)/g, (_, q, prefix) => `import(${q}../${prefix}`)
    .replace(/\brequire\(\s*(['"])(\.\.?\/)/g, (_, q, prefix) => `require(${q}../${prefix}`);
}

const importsAndHelpersBlock = outsideLines
  .map(rewritePath)
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');

// ──────────────────────────────────────────────────────────────────────
// 4) Build _internals.ts — the shared imports + module-level state.
//    Re-exports everything so the entity files import from a single
//    place. Note that lazy-emitter caches stay private to this module
//    (the entity files only use the GETTERS).
// ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

// Strip the leading file header comment and re-export `now` etc. as
// named exports. We KEEP the file structure literal — `nid`, `J`, `now`,
// `getEmit/getAutoAssign/...` were already top-level in the source.
const internalsHeader = `/**
 * Internal helpers shared by every src/crm/store/*Store.ts entity file.
 *
 * Lazy-emitter caches (\`_emit\`, \`_autoAssign\`, \`_commitStock\`,
 * \`_publishEvent\`) live HERE and only here — duplicating them across
 * entity files would create separate cache instances and re-trigger
 * dynamic imports under load.
 *
 * This module is the single source of truth for nid/J/now too.
 */
`;

// Convert top-level declarations whose name doesn't start with an
// underscore into exports. Underscore-prefixed names (_emit,
// _autoAssign, _commitStock, _publishEvent) stay module-private — they
// are CACHE variables shared only via the getter wrappers.
const internalsBody = importsAndHelpersBlock.replace(
  /^(async\s+function|function|const|let|var)\s+([a-zA-Z][a-zA-Z0-9_]*)/gm,
  (_m, kw, ident) => `export ${kw} ${ident}`,
);

// Strip stray re-export lines whose identifier is a private function we
// moved into an entity file (e.g. `export { getTopCardPosition };` in
// the source pulls a function that now lives in cardsStore).
const PRIVATE_HELPERS_MOVED = new Set(blocks.filter((b) => !b.isExported).map((b) => b.name));
const internalsBodyClean = internalsBody.replace(
  /^export\s*\{\s*([^}]+)\s*\}\s*;?\s*$/gm,
  (line, names) => {
    const kept = names.split(',').map((s) => s.trim()).filter((n) => n && !PRIVATE_HELPERS_MOVED.has(n));
    if (kept.length === 0) return '';
    return `export { ${kept.join(', ')} };`;
  },
);

fs.writeFileSync(
  path.join(OUT_DIR, '_internals.ts'),
  `${internalsHeader}${internalsBodyClean}\n`,
);
const internalsExports = discoverInternalsExports(path.join(OUT_DIR, '_internals.ts'));
console.log(
  `[split-store] _internals.ts written — exports ${internalsExports.values.length} values, ${internalsExports.types.length} types`,
);

// ──────────────────────────────────────────────────────────────────────
// 5) Build each entity file. They import from _internals (which holds
//    the lazy caches + helpers + types).
// ──────────────────────────────────────────────────────────────────────
//
// What does each entity file need to import? Everything that the
// helper block defined: now, nid, J, getEmit, getAutoAssign,
// getCommitStock, getPublish — plus any TYPE imports from ./types.js
// that are declared in the top-of-file `import type { ... }`. Since we
// don't introspect, we re-export everything from _internals via a
// re-export, and each entity file does:
//
//   import { now, nid, J, getEmit, getAutoAssign, getCommitStock,
//            getPublish } from './_internals.js';
//   import type { ... } from '../types.js';
//   import { getCrmDb } from '../schema.js';
//   import { randomUUID } from 'crypto';
//
// Since copying the import list is mechanical, we just inline the
// helpers block (read-only, no caches) directly into each file —
// EXCEPT the lazy caches and getters, which live ONLY in _internals.

// Auto-discover everything exported from _internals.ts so the entity
// files can import all shared symbols (helpers, lazy getters, top-level
// data consts like HEADER_ALIASES, and types like EvalContext /
// ImportResult). Captured AFTER we write _internals.ts.
function discoverInternalsExports(filepath) {
  const txt = fs.readFileSync(filepath, 'utf-8');
  const values = new Set();
  const types = new Set();
  // export const/let/var/function NAME — runtime values
  for (const m of txt.matchAll(/^export\s+(?:async\s+function|function|const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm)) {
    values.add(m[1]);
  }
  // export { a, b, c } — runtime values
  for (const m of txt.matchAll(/^export\s*\{\s*([^}]+)\s*\}\s*;?$/gm)) {
    for (const ident of m[1].split(',').map((s) => s.trim()).filter(Boolean)) values.add(ident);
  }
  // export interface/type NAME — types
  for (const m of txt.matchAll(/^export\s+(?:interface|type)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm)) {
    types.add(m[1]);
  }
  return { values: [...values], types: [...types] };
}

// Extract `import …` statements as full multi-line units. An import
// statement starts on a line beginning with `import` and ends on the
// first line ending with `;` (counting only at column 0 / outside string).
function extractImportStatements(allLines) {
  const out = [];
  let i = 0;
  while (i < allLines.length) {
    const l = allLines[i];
    if (!/^import\b/.test(l)) { i++; continue; }
    let stmt = l;
    let j = i + 1;
    while (!/;\s*$/.test(stmt) && j < allLines.length) {
      stmt += '\n' + allLines[j];
      j++;
    }
    out.push(stmt);
    i = j;
  }
  return out;
}

const importsOnly = extractImportStatements(outsideLines)
  .map((stmt) => stmt.split('\n').map(rewritePath).join('\n'))
  .join('\n');

// Build a name → target-file map so we can wire up cross-domain
// references. Any function moved to entity X but called from entity Y
// gets an explicit `import { fn } from './X.js'` at the top of Y.
const nameToTarget = new Map();
for (const target of TARGETS) {
  for (const b of grouped[target]) nameToTarget.set(b.name, target);
}

let totalExports = 0;
for (const target of TARGETS) {
  const fns = grouped[target];
  totalExports += fns.length;

  let body = '';
  for (const b of fns) {
    // Rewrite relative paths inside block bodies too — e.g.
    // `await import('./crypto.js')` needs to become `'../crypto.js'`.
    body += b.content.split('\n').map(rewritePath).join('\n') + '\n\n';
  }

  // Each entity file pulls in everything _internals exports — a tiny
  // amount of unused-import noise but it guarantees correctness no
  // matter which symbols the entity uses (HEADER_ALIASES, EvalContext,
  // helpers, etc.). TS's incremental compilation drops unused imports.
  const valueImports = internalsExports.values.length
    ? `import { ${internalsExports.values.join(', ')} } from './_internals.js';`
    : '';
  const typeImports = internalsExports.types.length
    ? `import type { ${internalsExports.types.join(', ')} } from './_internals.js';`
    : '';

  // Cross-domain references: scan this file's body for identifiers that
  // belong to a different entity file and emit explicit imports.
  const declaredHere = new Set(fns.map((b) => b.name));
  const referencedNames = new Set();
  // Heuristic: pick out any usage of an identifier that matches a known
  // function name. We scan with a word-boundary regex per name to avoid
  // false positives on substrings.
  for (const [name, file] of nameToTarget.entries()) {
    if (file === target || declaredHere.has(name)) continue;
    const usageRx = new RegExp(`\\b${name}\\b`);
    if (usageRx.test(body)) referencedNames.add(name);
  }
  const crossImportsByFile = new Map();
  for (const name of referencedNames) {
    const file = nameToTarget.get(name);
    if (!crossImportsByFile.has(file)) crossImportsByFile.set(file, []);
    crossImportsByFile.get(file).push(name);
  }
  const crossImports = [...crossImportsByFile.entries()]
    .map(([file, names]) => `import { ${names.sort().join(', ')} } from './${file}.js';`)
    .join('\n');

  const file = `// AUTO-GENERATED BY scripts/split-store.cjs — do not edit by hand.
// Edit src/crm/store.ts.bak (or restore from it) and re-run the splitter.
//
// Domain: ${target}
${importsOnly}
${valueImports}
${typeImports}
${crossImports}

${body.trimEnd()}
`;

  fs.writeFileSync(path.join(OUT_DIR, `${target}.ts`), file);
  console.log(`[split-store] ${target}.ts: ${fns.length} exports`);
}

console.log(`[split-store] total: ${totalExports} exports (expected ${blocks.length})`);
if (totalExports !== blocks.length) {
  throw new Error(`export count mismatch — ${blocks.length} input vs ${totalExports} output`);
}

// ──────────────────────────────────────────────────────────────────────
// 6) Rewrite src/crm/store.ts as a barrel.
// ──────────────────────────────────────────────────────────────────────
const barrel = `/**
 * CRM store — barrel module.
 *
 * The data-access layer was split into per-entity files under
 * src/crm/store/* in this refactor. This barrel re-exports every named
 * export from each entity file so that existing call sites
 *   import { listContacts } from './store.js';
 * keep working without changes.
 *
 * Module-level state (lazy emitter caches) lives in store/_internals.ts
 * and is shared across every entity file.
 */
${TARGETS.map((t) => `export * from './store/${t}.js';`).join('\n')}
`;

fs.writeFileSync(SRC, barrel);
console.log(`[split-store] barrel written`);
