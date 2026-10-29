/**
 * terminalPermitido.ts — quem pode rodar comando no servidor pelo Agente IA.
 *
 * Achado 29/10/2026: o Bash do tenant deveria rodar dentro do bwrap
 * (sandboxRunner.ts), mas a maquina de producao nao tem bwrap nem firejail —
 * o backend caia em 'none' e o comando de QUALQUER conta rodava cru, como
 * root, no host que guarda a chave do parque e os slots de todos os clientes.
 * A lista negra do bashSandbox.ts era a unica barreira, e lista negra de regex
 * se contorna com um `python3 -c`.
 *
 * Decisao do Daniel: terminal so para as contas dele. Os clientes seguem com
 * as ferramentas do CRM, arquivos (presos ao workspace pelo pathGuard) e web.
 *
 * Quem decide e a lista CLOW_TERMINAL_TENANTS no .env do servidor (ids
 * separados por virgula) — nunca algo que venha no token ou no pedido, que o
 * cliente controla. Lista vazia ou ausente = ninguem alem do admin_session.
 *
 * Os mesmos ids liberam os ganchos (.clow/hooks.json) e plugins lidos do
 * workspace: os dois executam comando no host e eram outra porta para o mesmo
 * lugar — o agente escreve o arquivo com a ferramenta Write e a proxima sessao
 * roda o que estiver nele.
 */

function contasLiberadas(): Set<string> {
  return new Set(
    (process.env.CLOW_TERMINAL_TENANTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function podeUsarTerminal(tenantId: string | undefined, isAdmin = false): boolean {
  if (isAdmin) return true;
  // Sem tenant = uso local pela CLI do dono, fora do servidor multi-tenant.
  if (!tenantId) return true;
  return contasLiberadas().has(tenantId);
}

export const MENSAGEM_TERMINAL_BLOQUEADO =
  'O terminal do servidor não está disponível nesta conta. Use as ferramentas do CRM, de arquivos e de internet.';
