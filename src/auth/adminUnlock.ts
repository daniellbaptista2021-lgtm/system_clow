/**
 * adminUnlock.ts — admin password unlock, session-scoped, ephemeral.
 *
 * O admin precisa digitar a senha (CLOW_ADMIN_BASH_PASSWORD no .env) pra
 * destravar Bash/self-modification na sessão atual. A senha NUNCA é
 * persistida em disco — vive só num Map em memória. Quando a sessão termina
 * (ou o processo reinicia), o unlock desaparece.
 *
 * Fluxo:
 *   1. Admin pede operação sensível → BashTool retorna ADMIN_PASSWORD_REQUIRED
 *   2. IA pede senha ao usuário
 *   3. Usuário envia senha → server/routes (ou whatsappMeta) chama
 *      tryUnlockFromMessage() ANTES de passar mensagem pro QueryEngine
 *   4. Se bater, sessão marcada como unlocked por UNLOCK_TTL_MS
 *   5. Mensagem segue pro QueryEngine com marker [ADMIN_PASSWORD_VERIFIED]
 *      no inicio pra IA saber que pode re-tentar
 *
 * Usuários (não-admin) NUNCA são destravados mesmo com senha correta —
 * a verificação só roda quando o contexto de sessão é admin.
 */

const unlockedSessions = new Map<string, number>(); // sessionId → unlockedAt (ms)
const UNLOCK_TTL_MS = 60 * 60 * 1000; // 1 hora max por sessão

function getPassword(): string {
  return process.env.CLOW_ADMIN_BASH_PASSWORD || '';
}

/**
 * Detecta senha admin no texto enviado pelo usuário.
 * Se match, marca sessão como unlocked e retorna { matched: true, stripped }
 * onde `stripped` é a mensagem sem a senha (pra não vazar pro histórico/LLM).
 */
export function tryUnlockFromMessage(
  sessionId: string,
  text: string,
  isAdmin: boolean,
): { matched: boolean; stripped: string } {
  if (!isAdmin || !text) return { matched: false, stripped: text };

  const pwd = getPassword();
  if (!pwd) return { matched: false, stripped: text };

  // Match exato (linha só com a senha) ou senha presente na mensagem.
  const trimmed = text.trim();
  if (trimmed === pwd) {
    unlockedSessions.set(sessionId, Date.now());
    return { matched: true, stripped: '[ADMIN_PASSWORD_VERIFIED]' };
  }
  if (text.includes(pwd)) {
    unlockedSessions.set(sessionId, Date.now());
    // Remove a senha do texto pra não ficar registrada
    const stripped = text.split(pwd).join('[SENHA_REMOVIDA]');
    return { matched: true, stripped: '[ADMIN_PASSWORD_VERIFIED]\n' + stripped };
  }
  return { matched: false, stripped: text };
}

/** Checa se sessão está atualmente destravada pra operações sensíveis. */
export function isSessionUnlocked(sessionId: string): boolean {
  const at = unlockedSessions.get(sessionId);
  if (!at) return false;
  if (Date.now() - at > UNLOCK_TTL_MS) {
    unlockedSessions.delete(sessionId);
    return false;
  }
  return true;
}

/** Travar sessão (chamado no logout / session end). */
export function lockSession(sessionId: string): void {
  unlockedSessions.delete(sessionId);
}

/** Limpar todas as sessões destravadas (ex: no shutdown). */
export function lockAllSessions(): void {
  unlockedSessions.clear();
}
