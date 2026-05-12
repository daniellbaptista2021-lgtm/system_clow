/**
 * bashSandbox.ts — Bash command validation for multi-tenant safety
 *
 * 2026-04-29 mudanca de modelo: WHITELIST → BLACKLIST.
 * Daniel: "todos os comandos exceto mexer no proprio sistema". Tenant pode
 * rodar QUALQUER binario/comando dentro do seu workspace; bloqueamos so o
 * que toca o System Clow propriamente dito (codigo, processo, .env, banco
 * dos tenants) ou que escala privilegio (sudo/su).
 *
 * Garantias estruturais que continuam (NAO precisam estar nessa lista):
 *  - bwrap namespace isola filesystem do tenant: ele so ve /opt/clow-workspaces/<tid>
 *    em rw + /usr /lib /lib64 /bin /etc em ro. Outros tenants nem existem
 *    no namespace.
 *  - SQL queries do CRM filtram por tenant_id.
 *  - Sem sudo, processos rodam como user nao-root no sandbox.
 *
 * Por isso a blacklist abaixo e CURTA: cobre apenas o que sandbox/SQL nao
 * isolam por conta propria — comandos que escalam ou acessam o System Clow
 * pelo canal de processo/PID/arquivos especiais.
 *
 * Admin: unrestricted (path separado em BashTool).
 */

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

/** Patterns que afetam o System Clow ou escalam privilegio. */
const BLOCKED_PATTERNS = [
  // Privilege escalation
  /\bsudo\b/,
  /(^|\s|;|&|\|)su\s+(-|\w)/,         // su -, su user
  /\bdoas\b/,
  /\bpolkit\b/i,

  // System Clow process control
  /\bpm2\b/,
  /\bsystemctl\b/,
  /(^|\s|;|&|\|)service\s+\S+\s+(start|stop|restart|reload)/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\binit\b\s+\d/,

  // Mata processo do System Clow / sistema (PID 1, ranges)
  /\bkill\s+-9\s+1\b/,
  /\bkill\s+1\b/,
  /\bkillall\s+(node|clow|pm2)\b/,
  /\bpkill\s+(node|clow|pm2)\b/,

  // Firewall / rede de baixo nivel — afeta o servidor todo
  /\biptables\b/,
  /\bufw\b/,
  /\bnft(ables)?\b/,

  // Dispositivos / filesystem do servidor
  /\bmkfs(\.|\b)/i,
  /\bdd\s+if=/,
  />\s*\/dev\/(sd|nvme|hd)/,

  // Leak/modificacao de credenciais e do banco do System Clow
  /\.env\b/,
  /tenants\.json/i,
  /\bANTHROPIC_API_KEY\b/,
  /\bCLOW_ADMIN[A-Z_]*\b/,
];

/** Paths que sao do sistema/clow — read e write proibidos pra tenant.
 *  /etc fica acessivel via bwrap como ro-bind, entao leitura e ok mas
 *  escrita ja nao funciona naturalmente. */
const BLOCKED_PATHS = [
  '/opt/system-clow/src',
  '/opt/system-clow/dist',
  '/opt/system-clow/.env',
  '/opt/system-clow/package.json',
  '/opt/system-clow/tsconfig',
  '/opt/system-clow/node_modules',
  '/opt/system-clow/scripts',
  '/root/.clow',                        // banco SQLite multi-tenant + tenants.json
  '/root/.ssh',
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/etc/systemd', '/etc/nginx',
];

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface SandboxResult {
  allowed: boolean;
  reason?: string;
  sanitizedCommand?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Sandbox Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Valida um comando Bash de tenant SaaS.
 *
 * Modelo blacklist (2026-04-29): tenant pode rodar qualquer binario/comando.
 * Bloqueamos so o que toca o proprio System Clow (processo, codigo, banco)
 * ou escala privilegio (sudo/su). Isolamento de filesystem entre tenants e
 * feito pelo bwrap namespace em SandboxRunner (nao por path matching aqui).
 */
export function validateBashCommand(
  command: string,
  workspaceRoot: string,
  isAdmin: boolean = false,
): SandboxResult {
  if (isAdmin) return { allowed: true };

  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Bloqueado: comando afeta o System Clow ou escala privilegio (${pattern.source.slice(0, 40)}). Voce pode rodar qualquer outra coisa no seu workspace.`,
      };
    }
  }

  for (const blockedPath of BLOCKED_PATHS) {
    if (trimmed.includes(blockedPath)) {
      return {
        allowed: false,
        reason: `Bloqueado: caminho pertence ao System Clow ou ao sistema operacional (${blockedPath}).`,
      };
    }
  }

  return { allowed: true, sanitizedCommand: trimmed };
}

/**
 * Get the working directory for a tenant's Bash execution.
 * Always forces execution within the tenant's workspace.
 */
export function getTenantWorkspaceDir(tenantId: string): string {
  return `/opt/clow-workspaces/${sanitizeTenantId(tenantId)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function sanitizeTenantId(tenantId: string): string {
  return tenantId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}
