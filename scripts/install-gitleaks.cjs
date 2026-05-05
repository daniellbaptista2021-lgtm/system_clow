#!/usr/bin/env node
/**
 * install-gitleaks.cjs — baixa o binário gitleaks pra node_modules/.bin/
 * Roda automaticamente no postinstall do npm.
 * Suporta: linux-x64, darwin-x64, darwin-arm64, win32-x64.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');

const VERSION = '8.21.2';
const BIN_DIR = path.join(__dirname, '..', 'node_modules', '.bin');
const BIN_NAME = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// Já tem? não baixa de novo.
if (fs.existsSync(BIN_PATH)) {
  try {
    const out = execSync(`"${BIN_PATH}" version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (out.includes(VERSION) || out.length > 0) {
      console.log(`gitleaks já instalado: ${out}`);
      process.exit(0);
    }
  } catch { /* re-instala */ }
}

// Mapa plataforma → asset do GitHub release
function pickAsset() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && a === 'x64')   return `gitleaks_${VERSION}_linux_x64.tar.gz`;
  if (p === 'linux' && a === 'arm64') return `gitleaks_${VERSION}_linux_arm64.tar.gz`;
  if (p === 'darwin' && a === 'x64')  return `gitleaks_${VERSION}_darwin_x64.tar.gz`;
  if (p === 'darwin' && a === 'arm64') return `gitleaks_${VERSION}_darwin_arm64.tar.gz`;
  if (p === 'win32' && a === 'x64')   return `gitleaks_${VERSION}_windows_x64.zip`;
  if (p === 'win32' && a === 'ia32')  return `gitleaks_${VERSION}_windows_x32.zip`;
  return null;
}

const asset = pickAsset();
if (!asset) {
  console.warn(`[gitleaks] plataforma não suportada (${process.platform}/${process.arch}). Instale manualmente: https://github.com/gitleaks/gitleaks/releases`);
  process.exit(0); // não falha o npm install
}

const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${asset}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-'));
const archivePath = path.join(tmpDir, asset);

console.log(`[gitleaks] baixando ${url}`);

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('redirect loop'));
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

(async () => {
  try {
    await download(url, archivePath);
    fs.mkdirSync(BIN_DIR, { recursive: true });

    if (asset.endsWith('.tar.gz')) {
      execSync(`tar -xzf "${archivePath}" -C "${tmpDir}" gitleaks`, { stdio: 'inherit' });
      fs.copyFileSync(path.join(tmpDir, 'gitleaks'), BIN_PATH);
      fs.chmodSync(BIN_PATH, 0o755);
    } else if (asset.endsWith('.zip')) {
      // PowerShell tem Expand-Archive
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' });
      fs.copyFileSync(path.join(tmpDir, 'gitleaks.exe'), BIN_PATH);
    }

    // Limpa tmp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    const ver = execSync(`"${BIN_PATH}" version`, { encoding: 'utf-8' }).trim();
    console.log(`[gitleaks] instalado: ${ver} → ${BIN_PATH}`);
  } catch (e) {
    console.warn(`[gitleaks] falha ao instalar: ${e.message}`);
    console.warn(`[gitleaks] pode instalar manualmente: https://github.com/gitleaks/gitleaks/releases/tag/v${VERSION}`);
    process.exit(0); // não bloqueia npm install
  }
})();
