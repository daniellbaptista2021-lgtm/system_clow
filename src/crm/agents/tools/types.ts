/**
 * Tool infra do funil multi-agente (PR 3 da Onda 62).
 *
 * Cada tool e uma funcao que o LLM pode chamar. A registry liga nomes
 * a definicoes (schema + handler), filtra por role, e executa em
 * isolamento — captura erros, loga metric, retorna resultado pro LLM
 * processar no proximo turno.
 *
 * O schema da tool segue o shape de OpenAI/DeepSeek function calling:
 *   { type: 'function', function: { name, description, parameters: {...} } }
 *
 * Tools com roles=['*'] sao "comuns" — qualquer agente de coluna chama.
 * Tools com roles=['educador'] sao especificas do role (PR 5.2: 3 estagios SDR).
 */
import type { Channel2, Card, BoardColumn, CardAgentState, ColumnAgentRole } from '../../types.js';

/** Contexto passado pra cada tool — o que ela precisa pra agir. */
export interface ToolContext {
  tenantId: string;
  channel: Channel2;
  card: Card;
  column: BoardColumn;
  state: CardAgentState;
  customerPhone: string;
  /** Role do agente que esta executando esta tool (pra checks de permissao). */
  role: ColumnAgentRole;
}

export type ToolResult =
  | { ok: true; result: unknown; userVisible?: string }
  | { ok: false; error: string };

/**
 * JSON schema simples no shape OpenAI function calling.
 * Usamos o tipo `unknown` pra evitar dependencia circular com a tipagem
 * estrita do DeepSeek SDK — a registry monta o objeto LLM-format final.
 */
export interface ToolSchema {
  type: 'object';
  properties: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    enum?: string[];
    items?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
  }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** Roles que podem chamar. ['*'] = qualquer role. */
  roles: Array<ColumnAgentRole | '*'>;
  /** Handler — recebe args ja parseados (JSON.parse do LLM). */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** Formato que o DeepSeek/OpenAI espera no payload `tools`. */
export interface LLMToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema;
  };
}

/** Tool call retornado pelo LLM no `choices[0].message.tool_calls`. */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
