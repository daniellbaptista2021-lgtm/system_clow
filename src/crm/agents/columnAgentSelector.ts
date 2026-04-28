/**
 * columnAgentSelector — decide qual agente vai responder um inbound:
 * o agente da COLUNA do card atual, o agente do CANAL (legado), ou
 * nenhum.
 *
 * Ordem de prioridade (definida em PR 2 da Onda 62):
 *   1. Coluna do card atual tem agent_enabled=true E agent_system_prompt
 *      configurado → roda column agent.
 *   2. Senao, canal tem ai_enabled=true E ai_system_prompt configurado
 *      → roda channel agent (comportamento atual, zero regressao).
 *   3. Senao → nao responde.
 *
 * Esse selector NAO chama LLM nem manda mensagem. So decide e devolve
 * a config. O caller (handleInboundForAI) e quem dispatcha pro runner
 * apropriado.
 *
 * Backward compat: tenant que nao mexeu nas colunas (agent_enabled=0)
 * continua caindo no fallback de canal — mesmo comportamento de hoje.
 */
import { logger } from '../../utils/logger.js';
import * as store from '../store.js';
import { readChannelAIConfig } from '../ai/agent.js';
import type { Channel2, Card, BoardColumn } from '../types.js';

export interface ColumnAgentPick {
  type: 'column';
  channel: Channel2;
  card: Card;
  column: BoardColumn;
}

export interface ChannelAgentPick {
  type: 'channel';
  channel: Channel2;
  // ChannelAIConfig nao e exportado como tipo; o caller (agent.ts) le
  // a config diretamente via readChannelAIConfig(channel.id). Aqui so
  // sinalizamos qual caminho seguir.
}

export interface NoneAgentPick {
  type: 'none';
  reason: 'no_contact' | 'no_card' | 'no_column' | 'no_agent_configured';
}

export type AgentPick = ColumnAgentPick | ChannelAgentPick | NoneAgentPick;

export interface PickAgentInput {
  channel: Channel2;
  customerPhone: string;
}

/** Decide qual agente responde o inbound. Pure function (sem side effects). */
export function pickAgent(input: PickAgentInput): AgentPick {
  const { channel, customerPhone } = input;
  const tenantId = channel.tenantId;

  // 1) Tem contato com esse phone?
  const contact = store.findContactByPhone(tenantId, customerPhone);
  if (!contact) {
    // Sem contato significa que ingestInbound ainda nao gravou (race) ou
    // veio de outra fonte. Cai no canal — agente de canal nao precisa
    // de card pra rodar, ele responde "primeira interacao".
    return tryChannelFallback(channel, 'no_contact');
  }

  // 2) Tem card aberto?
  const cards = store.listCardsByContact(tenantId, contact.id);
  if (cards.length === 0) return tryChannelFallback(channel, 'no_card');

  // listCardsByContact retorna ORDER BY updated_at DESC → primeiro = mais recente
  const card = cards[0];

  // 3) Lê coluna do card pra ver se tem agente ativo
  if (!card.boardId || !card.columnId) return tryChannelFallback(channel, 'no_column');
  const columns = store.listColumns(tenantId, card.boardId);
  const column = columns.find((c) => c.id === card.columnId);
  if (!column) return tryChannelFallback(channel, 'no_column');

  // Coluna tem agente ativo E prompt configurado?
  const hasColumnAgent = column.agentEnabled === true
    && typeof column.agentSystemPrompt === 'string'
    && column.agentSystemPrompt.trim().length > 0;
  if (hasColumnAgent) {
    logger.info(
      `[col-agent.selector] tenant=${tenantId.slice(0, 8)} card=${card.id} ` +
        `column="${column.name}" role=${column.agentRole ?? 'custom'} → COLUMN agent`,
    );
    return { type: 'column', channel, card, column };
  }

  // Sem agente de coluna ativo — fallback pro canal
  return tryChannelFallback(channel, 'no_agent_configured');
}

/**
 * Verifica se canal tem agente de canal ativo (caminho legado, mantido
 * pra zero regressao). Se sim, retorna 'channel'. Se nao, retorna 'none'
 * com reason apropriada — caller pode logar metric event='blocked'
 * com reason='no_agent'.
 */
function tryChannelFallback(channel: Channel2, reasonIfNone: NoneAgentPick['reason']): AgentPick {
  const cfg = readChannelAIConfig(channel.id);
  if (cfg) return { type: 'channel', channel };
  return { type: 'none', reason: reasonIfNone };
}
