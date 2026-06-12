#!/usr/bin/env node
/**
 * run-gitleaks.cjs — wrapper que chama o binário de node_modules/.bin/.
 * Args: protect|detect [opts]
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const binDir = path.join(__dirname, '..', 'node_modules', '.bin');
const binName = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
const binPath = path.join(binDir, binName);

if (!fs.existsSync(binPath)) {
  console.error(`[gitleaks] binário não encontrado em ${binPath}`);
  console.error(`Rode: npm install (ele tem postinstall que baixa o gitleaks)`);
  console.error(`Ou manualmente: node scripts/install-gitleaks.cjs`);
  process.exit(2);
}

const args = process.argv.slice(2);

// Adiciona --config automaticamente se não passou
if (!args.includes('--config') && !args.includes('-c')) {
  const cfg = path.join(__dirname, '..', '.gitleaks.toml');
  if (fs.existsSync(cfg)) args.push('--config', cfg);
}

const r = spawnSync(binPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status ?? 1);
