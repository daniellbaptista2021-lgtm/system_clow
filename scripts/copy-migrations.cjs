#!/usr/bin/env node
// Copies migration .sql files from src/crm/migrations/ to dist/crm/migrations/
// so the compiled migrator can read them at runtime via fileURLToPath.
// Runs as part of `npm run build`.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src', 'crm', 'migrations');
const DST = path.resolve(__dirname, '..', 'dist', 'crm', 'migrations');

if (!fs.existsSync(SRC)) {
  console.warn(`[copy-migrations] no source dir ${SRC}, nothing to do`);
  process.exit(0);
}
fs.mkdirSync(DST, { recursive: true });

const sqlFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.sql'));
let copied = 0;
for (const f of sqlFiles) {
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  copied++;
}
console.log(`[copy-migrations] copied ${copied} .sql file(s) → dist/crm/migrations/`);
