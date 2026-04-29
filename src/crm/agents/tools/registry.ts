/**
 * Tool registry — agrega todas as tools, filtra por role, monta formato
 * pro LLM, e executa com checagem de permissao + log de metric.
 */
import { logger } from '../../../utils/logger.js';
import { recordAgentMetric } from '../../store/cardAgentStateStore.js';
import { COMMON_TOOLS } from './common.js';
import { QUALIFICADOR_TOOLS } from './qualificador.js';
import { VENDEDOR_FUNERAL_TOOLS } from './vendedor_funeral.js';
import { COLETOR_DADOS_TOOLS } from './coletor_dados.js';
import type { ToolDef, ToolContext, ToolResult, LLMToolDef, LLMToolCall } from './types.js';
import type { ColumnAgentRole } from '../../types.js';

// PR 6.0: bot vendedor completo. 3 roles:
//   qualificador     — acolhe, oferece escolha, coleta (ou escala)
//   vendedor_funeral — cota + fecha venda funeral SOZINHO (com tool gerar_cotacao_sulamerica)
//   coletor_dados    — LGPD + 17 campos + forma pagamento
// Migration 010 renomeia rows existentes (educador → vendedor_funeral,
// finalizador → coletor_dados).
const ALL_TOOLS: ToolDef[] = [
  ...COMMON_TOOLS,
  ...QUALIFICADOR_TOOLS,
  ...VENDEDOR_FUNERAL_TOOLS,
  ...COLETOR_DADOS_TOOLS,
];

// ─── Validacao da registry no module load ────────────────────────────────
(function validate(): void {
  const names = new Set<string>();
  for (const t of ALL_TOOLS) {
    if (names.has(t.name)) throw new Error(`tool registry: duplicate tool name '${t.name}'`);
    names.add(t.name);
    if (typeof t.execute !== 'function') throw new Error(`tool registry: '${t.name}' missing execute`);
    if (!t.roles?.length) throw new Error(`tool registry: '${t.name}' has empty roles`);
  }
})();

/** Retorna as tools que o role pode chamar (comuns + especificas). */
export function getToolsForRole(role: ColumnAgentRole): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.roles.includes('*') || t.roles.includes(role));
}

/** Converte tools pro shape OpenAI/DeepSeek function calling. */
export function toLLMTools(tools: ToolDef[]): LLMToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Executa um tool_call com checagem de permissao + log de metric.
 *  Erros de execucao sao capturados e retornados como ToolResult.error
 *  pro LLM processar. NAO propaga exception. */
export async function executeToolCall(
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = call.function.name;
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) {
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_failed', reason: `unknown_tool=${name}`,
    });
    return { ok: false, error: `tool_unknown: ${name}` };
  }
  // Checa permissao por role
  if (!tool.roles.includes('*') && !tool.roles.includes(ctx.role)) {
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_failed', reason: `permission_denied tool=${name} role=${ctx.role}`,
    });
    return { ok: false, error: `tool_not_allowed_for_role: tool=${name} role=${ctx.role}` };
  }
  // Parse args
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (err: any) {
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_failed', reason: `bad_args_json tool=${name}`,
    });
    return { ok: false, error: `tool_bad_args_json: ${err?.message || 'parse_failed'}` };
  }
  // Executa
  try {
    const result = await tool.execute(args, ctx);
    // Log estruturado: nome da tool + resumo de keys (nao loga PII)
    const reason = `tool=${name} args_keys=[${Object.keys(args).join(',')}] ok=${result.ok}`;
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: result.ok ? 'tool_called' : 'tool_failed',
      reason,
    });
    return result;
  } catch (err: any) {
    logger.error(`[tool-registry] ${name} threw:`, err?.message);
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_failed',
      reason: `tool=${name} threw=${(err?.message || 'unknown').slice(0, 80)}`,
    });
    return { ok: false, error: `tool_runtime_error: ${err?.message || 'unknown'}` };
  }
}

/** Lista flat de todas as tools registered (debug/inspecao). */
export function listAllToolNames(): string[] {
  return ALL_TOOLS.map((t) => t.name);
}
