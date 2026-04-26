#!/usr/bin/env node
/**
 * setup-husky.cjs — roda no `npm prepare` (que o npm executa após install).
 * Inicializa husky + cria/atualiza .husky/pre-commit que chama lint-staged.
 * Idempotente: pode rodar várias vezes sem efeito colateral.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

// Pula em CI se HUSKY=0
if (process.env.HUSKY === '0' || process.env.CI === 'true' && process.env.HUSKY !== '1') {
  console.log('[husky] pulando setup (HUSKY=0 ou CI)');
  process.exit(0);
}

const repoRoot = path.join(__dirname, '..');
const huskyBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'husky.cmd' : 'husky');

if (!fs.existsSync(huskyBin)) {
  console.warn('[husky] binário não encontrado em node_modules/.bin — rode npm install primeiro');
  process.exit(0);
}

// Verifica se está dentro de um repo git (caso a pasta tenha sido extraída de zip sem .git)
try {
  execSync('git rev-parse --is-inside-work-tree', { cwd: repoRoot, stdio: 'pipe' });
} catch {
  console.warn('[husky] não está num repositório git, pulando setup');
  process.exit(0);
}

// husky init (cria .husky/_)
const r = spawnSync(huskyBin, ['init'], { cwd: repoRoot, stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.warn('[husky] husky init falhou');
  process.exit(0);
}

// Conteúdo do pre-commit
const preCommitPath = path.join(repoRoot, '.husky', 'pre-commit');
const preCommitBody = `# Pre-commit hook do System Clow — gerado por scripts/setup-husky.cjs
# Roda lint-staged → que chama gitleaks protect --staged.
# Pra pular um commit emergencial: git commit --no-verify (NÃO RECOMENDADO).

npx --no-install lint-staged
`;

try {
  fs.mkdirSync(path.dirname(preCommitPath), { recursive: true });
  fs.writeFileSync(preCommitPath, preCommitBody, { mode: 0o755 });
  console.log('[husky] .husky/pre-commit configurado');
} catch (e) {
  console.warn(`[husky] falha ao escrever pre-commit: ${e.message}`);
  process.exit(0);
}
