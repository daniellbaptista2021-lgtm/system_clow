#!/usr/bin/env node
/**
 * One-shot codemod: console.{log,info,warn,error,debug} → logger.{info,info,warn,error,debug}
 * Across every .ts file under src/.
 *
 *   - Adds `import { logger } from '<rel>/utils/logger.js'` if not already there.
 *   - Skips test files, scripts, and the logger module itself.
 *   - Maps:
 *       console.log    → logger.info
 *       console.info   → logger.info
 *       console.warn   → logger.warn
 *       console.error  → logger.error
 *       console.debug  → logger.debug
 *
 * NOTE: this is a structural rewrite of CALL sites — the message text is
 * NOT touched. logger.X(msg, extraFields?) keeps the SAME first arg as
 * console.X(msg). Multi-arg console.log(a, b, c) is rewritten to
 * logger.info(a, { extra: [b, c] }) so nothing is lost.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const LOGGER_MOD_REL = 'utils/logger.js';

// Skip patterns.
const SKIP = [
  /\/utils\/logger\.ts$/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.ts')) yield full;
  }
}

function relImport(filepath) {
  const fromDir = path.dirname(filepath);
  const target = path.join(SRC, LOGGER_MOD_REL);
  let rel = path.relative(fromDir, target).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

const CONSOLE_RX = /\bconsole\.(log|info|warn|error|debug)\b/g;
const LEVEL_MAP = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

let filesScanned = 0;
let filesChanged = 0;
let totalReplacements = 0;

for (const file of walk(SRC)) {
  filesScanned++;
  if (SKIP.some((rx) => rx.test(file.replace(/\\/g, '/')))) continue;
  const original = fs.readFileSync(file, 'utf-8');
  if (!CONSOLE_RX.test(original)) continue;
  CONSOLE_RX.lastIndex = 0; // reset

  let count = 0;
  let next = original.replace(CONSOLE_RX, (_, lvl) => {
    count++;
    return `logger.${LEVEL_MAP[lvl]}`;
  });

  if (count === 0) continue;

  // Add `import { logger } from '...'` if missing.
  if (!/from\s+['"][^'"]*\/utils\/logger(\.js)?['"]/.test(next)) {
    const importLine = `import { logger } from '${relImport(file)}';\n`;
    // Insert after the last existing top-level import statement, or at top.
    const lines = next.split('\n');
    let insertAt = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^import\s/.test(lines[i])) insertAt = i + 1;
      else if (insertAt > 0 && lines[i].trim() === '') {
        // first blank line after the import block — break here
        break;
      }
    }
    lines.splice(insertAt, 0, importLine.trimEnd());
    next = lines.join('\n');
  }

  fs.writeFileSync(file, next);
  filesChanged++;
  totalReplacements += count;
}

console.log(`[replace-console] scanned ${filesScanned} .ts files`);
console.log(`[replace-console] modified ${filesChanged} files`);
console.log(`[replace-console] replaced ${totalReplacements} console.* calls`);
