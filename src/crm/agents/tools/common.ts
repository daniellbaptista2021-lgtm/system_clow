/**
 * Tools comuns — disponiveis pra qualquer role (qualificador / cotador /
 * closer / finalizador / custom). PR 3 da Onda 62.
 */
import { logger } from '../../../utils/logger.js';
import * as store from '../../store.js';
import * as outbound from '../../outboundWebhooks.js';
import { getCrmDb } from '../../schema.js';
import {
  recordAgentMetric,
  setCardAgentStatus,
  upsertCardAgentState,
  getCardAgentState,
} from '../../store/cardAgentStateStore.js';
import { maskAllSensitive, decryptAllSensitive, listSensitiveFields, type SensitiveBag } from '../piiCrypto.js';
import type { ToolDef, ToolContext, ToolResult } from './types.js';

const J = {
  parse<T>(s: unknown, fb: T): T {
    if (typeof s !== 'string') return fb;
    try { return JSON.parse(s) as T; } catch { return fb; }
  },
};

// ─── escalar_humano ──────────────────────────────────────────────────────

const escalarHumano: ToolDef = {
  name: 'escalar_humano',
  description: 'Pausa o atendimento automático e notifica o time humano. Use quando o cliente pediu humano explicitamente, xingou, demonstrou frustração intensa, ou você ficou sem saber como prosseguir. Se cliente sinalizou interesse em PLANO COMPLETO (vida/doenças graves/cirurgia/DIT), passe urgencia="alta" — manda alerta WhatsApp pro corretor pessoal AGORA.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razão objetiva da escalação (1 frase).' },
      urgencia: {
        type: 'string',
        description: '"alta" pra lead quente (interesse plano completo). "normal" pra demais casos.',
        enum: ['alta', 'normal'],
      },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const urgencia = (args.urgencia === 'alta' ? 'alta' : 'normal') as 'alta' | 'normal';

    setCardAgentStatus(ctx.card.id, 'escalated');
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'escalated',
      reason: urgencia === 'alta' ? `urgent: ${motivo}` : motivo,
      turnsInColumn: ctx.state.turnsCount,
    });

    // Tenta achar nome do contato pra incluir no alerta
    let contactName: string | undefined;
    try {
      const contact = ctx.card.contactId ? store.getContact?.(ctx.tenantId, ctx.card.contactId) : null;
      contactName = contact?.name;
    } catch { /* nao bloqueia */ }

    // Outbound webhook pro tenant (Telegram / WhatsApp / email do Daniel etc)
    try {
      await outbound.emit(ctx.tenantId, 'agent.escalated', {
        cardId: ctx.card.id,
        cardTitle: ctx.card.title,
        contactName,
        contactPhone: ctx.customerPhone,
        columnId: ctx.column.id,
        columnName: ctx.column.name,
        role: ctx.role,
        urgencia,
        reason: motivo,
        turnsInColumn: ctx.state.turnsCount,
      });
    } catch (err: any) {
      logger.warn('[tool.escalar_humano] outbound emit falhou:', err?.message);
    }

    // PR 6.0: alerta WhatsApp pessoal do Daniel se urgencia=alta + URGENT_ALERT_PHONE setado
    if (urgencia === 'alta' && process.env.URGENT_ALERT_PHONE) {
      void sendUrgentWhatsAppAlert(ctx, motivo, contactName).catch((err: any) => {
        logger.warn('[tool.escalar_humano] urgent alert WhatsApp falhou:', err?.message);
      });
    }

    // FIX 2026-04-30 (Daniel): mover card pra coluna "Atendimento Humano"
    // do mesmo board, se existir. Sem isso, agente avisa o Daniel mas o
    // card fica parado em Lead novo — Daniel precisa arrastar manual.
    let movedTo: { id: string; name: string } | null = null;
    try {
      if (ctx.card.boardId) {
        const cols = store.listColumns(ctx.tenantId, ctx.card.boardId);
        // Match tolerante: lowercase + remove diacriticos via NFD/replace de
        // combining marks (range u0300-u036f). Aceita "Atendimento Humano",
        // "atendimento humano", "Humano" etc.
        const norm = (s: string) =>
          s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
        const target = cols.find((c) => {
          const n = norm(c.name);
          return n === 'atendimento humano' || n === 'humano' || n === 'atendimento';
        });
        if (target && target.id !== ctx.column.id) {
          const db = getCrmDb();
          db.prepare('UPDATE crm_cards SET column_changed_at = ? WHERE id = ?').run(Date.now(), ctx.card.id);
          store.moveCard(ctx.tenantId, ctx.card.id, target.id);
          // Reseta state do agente pra coluna nova (NAO inicia bot la — bot
          // de Atendimento Humano fica OFF, humano assume)
          upsertCardAgentState({
            cardId: ctx.card.id,
            columnId: target.id,
            currentAgentRole: 'custom',
            tenantId: ctx.tenantId,
            turnsCount: 0,
            inactivityTimerAt: null,
            inactivityFireCount: 0,
            status: 'escalated',
          });
          movedTo = { id: target.id, name: target.name };
          recordAgentMetric({
            tenantId: ctx.tenantId, columnId: target.id, cardId: ctx.card.id,
            event: 'promoted', reason: `escalado_humano: ${motivo}`,
          });
          logger.info(`[tool.escalar_humano] card=${ctx.card.id} movido ${ctx.column.name} → ${target.name}`);
        }
      }
    } catch (err: any) {
      logger.warn('[tool.escalar_humano] move pra Atendimento Humano falhou:', err?.message);
    }

    logger.info(`[tool.escalar_humano] card=${ctx.card.id} urgencia=${urgencia} reason="${motivo}"${movedTo ? ` movedTo=${movedTo.name}` : ''}`);
    return { ok: true, result: { escalated: true, urgencia, movedTo }, userVisible:
      'Vou te transferir pra um especialista. Já já alguém da equipe entra em contato! 🙏' };
  },
};

/** Envia alerta urgente via WhatsApp do channel atual pro Daniel pessoal.
 *  URGENT_ALERT_PHONE no .env eh o numero do corretor (ex: 5521990423520).
 *  Usa o canal Z-API/Meta do tenant pra enviar — meio simples mas funcional.
 *  Exportado pra ser reutilizado em promocao.ts (PR 7.3 — alerta em
 *  "Lancar Venda" tambem precisa avisar o humano via WhatsApp). */
export async function sendUrgentWhatsAppAlert(
  ctx: ToolContext,
  motivo: string,
  contactName?: string,
): Promise<void> {
  const phone = (process.env.URGENT_ALERT_PHONE || '').replace(/\D/g, '');
  if (!phone) return;
  const cardUrl = `${process.env.PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br'}/crm/?card=${ctx.card.id}`;
  const text = `🚨 *LEAD QUENTE — INTERESSE PLANO COMPLETO* 🚨\n\n` +
    `👤 Cliente: *${contactName || ctx.card.title || 'sem nome'}*\n` +
    `📞 Telefone: ${ctx.customerPhone}\n` +
    `💬 Motivo: ${motivo}\n` +
    `📋 Card: ${cardUrl}\n\n` +
    `_Bot encaminhou na hora — fala com ele AGORA._`;

  // sendOutbound do inbox.ts usa o channel passado pra mandar texto.
  // Importamos dinamicamente pra evitar circular.
  const { sendOutbound } = await import('../../inbox.js');
  await sendOutbound(ctx.channel, { to: phone, text });
}

// ─── marcar_perdido ──────────────────────────────────────────────────────

const marcarPerdido: ToolDef = {
  name: 'marcar_perdido',
  description: 'Marca o lead como perdido (cliente sem interesse, fora de orçamento, etc). Move pra coluna "Perdidos" se existir, senão marca status=done com reason=lost.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razão da perda (sem_interesse / preço / etc)' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';

    // Procura coluna Perdidos no mesmo board (case-insensitive)
    const cols = store.listColumns(ctx.tenantId, ctx.card.boardId!);
    const lostCol = cols.find((c) =>
      c.isTerminal && /perdid|lost/i.test(c.name)
    ) || cols.find((c) => /perdid|lost/i.test(c.name));

    if (lostCol && lostCol.id !== ctx.card.columnId) {
      try { store.moveCard(ctx.tenantId, ctx.card.id, lostCol.id); }
      catch (err: any) {
        logger.warn('[tool.marcar_perdido] moveCard falhou:', err?.message);
      }
    }
    // status=done — sai do funil de qualquer forma
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: lostCol?.id ?? ctx.card.columnId!,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      status: 'done',
    });
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'lost', reason: motivo,
      turnsInColumn: ctx.state.turnsCount,
    });
    logger.info(`[tool.marcar_perdido] card=${ctx.card.id} motivo="${motivo}" movedTo=${lostCol?.name ?? '(sem coluna)'}`);
    return { ok: true, result: 'marked_lost', userVisible: null as any };
  },
};

// ─── marcar_morno ────────────────────────────────────────────────────────

const marcarMorno: ToolDef = {
  name: 'marcar_morno',
  description: 'Marca o cliente como "morno" (interesse vago) e agenda follow-up automático em 2 dias. Use quando cliente desconversa, demora a responder, ou demonstra interesse mas sem urgência.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_args, ctx) {
    // Tag "morno" no contato
    if (ctx.card.contactId) {
      const c = store.getContact?.(ctx.tenantId, ctx.card.contactId)
        ?? (store as any).findContactByPhone?.(ctx.tenantId, ctx.customerPhone);
      if (c) {
        const newTags = Array.from(new Set([...(c.tags ?? []), 'morno']));
        try { store.updateContact(ctx.tenantId, c.id, { tags: newTags }); }
        catch (err: any) { logger.warn('[tool.marcar_morno] updateContact falhou:', err?.message); }
      }
    }
    // inactivityTimerAt = D+2. PR 4 vai ler e disparar.
    const followupAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      inactivityTimerAt: followupAt,
    });
    logger.info(`[tool.marcar_morno] card=${ctx.card.id} followup=${new Date(followupAt).toISOString()}`);
    return { ok: true, result: { tagged: 'morno', followup_at: followupAt } };
  },
};

// ─── agendar_followup ────────────────────────────────────────────────────

const agendarFollowup: ToolDef = {
  name: 'agendar_followup',
  description: 'Agenda um follow-up automático pro cliente em uma data específica. Aceita ISO 8601 ("2026-05-01T14:00:00Z"), data ISO ("2026-05-01" — assume 14h BRT), formato BR ("01/05/2026 14:00"), ou tempo relativo em horas ("+24h", "+48h"). PR 4 dispara o agente na hora.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      quando: { type: 'string', description: 'Quando disparar. ISO 8601, "YYYY-MM-DD" (default 14h BRT), "DD/MM/YYYY HH:MM", ou "+Nh" / "+Nd"' },
    },
    required: ['quando'],
  },
  execute(args, ctx) {
    const quando = String(args.quando || '').trim();
    if (!quando) {
      logger.warn(`[tool.agendar_followup] BLOQUEADO card=${ctx.card.id} quando=vazio`);
      return { ok: false, error: 'data_obrigatoria: passe ISO ("2026-05-08T14:00:00Z") OU "+24h" OU "DD/MM/YYYY HH:MM"' };
    }

    const t = parseFollowupDate(quando);
    if (t === null) {
      // Daniel 2026-05-06: log no nivel ERROR pra agregar inputs rejeitados
      // facilmente; serve pra expandir parser depois com base nos formatos
      // reais que LLM está tentando passar.
      logger.error(`[tool.agendar_followup] formato_invalido card=${ctx.card.id} quando_raw="${quando}" role=${ctx.role}`);
      return { ok: false, error: `formato_invalido: "${quando}". Aceito: "+24h"/"+2d"/"+30min"/"+24 horas"/"+2 dias", "2026-05-08", "2026-05-08 14:00", "08/05/2026 14:00", ou ISO 8601 completo.` };
    }

    // Tolerância de 60s no passado (cobre latência LLM); senão soma 1h.
    const now = Date.now();
    let final = t;
    if (t < now - 60_000) {
      logger.warn(`[tool.agendar_followup] data no passado (${Math.round((now-t)/60000)}min atras) — ajustando pra +1h`);
      final = now + 60 * 60 * 1000;
    }
    // Limita a 60 dias no futuro pra evitar follow-up "pra nunca"
    const max = now + 60 * 24 * 60 * 60 * 1000;
    final = Math.min(final, max);

    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      inactivityTimerAt: final,
    });
    logger.info(`[tool.agendar_followup] card=${ctx.card.id} at=${new Date(final).toISOString()} (input="${quando}")`);
    return { ok: true, result: { scheduled_at: final, scheduled_iso: new Date(final).toISOString() } };
  },
};

/** Parser permissivo pra agendar_followup. Retorna timestamp ms ou null.
 *  Ordem dos checks importa: regex BR/date-only ANTES de Date.parse, senão
 *  Date.parse interpreta "08/05/2026" como US (Aug 5) ou "2026-05-08" como
 *  00h UTC (em vez de 14h BRT que queremos).
 *
 *  Daniel 2026-05-06: ~16 falhas/sem com formato_invalido. Expandir pra
 *  cobrir formatos extras que o LLM tende a passar:
 *    - "+24 horas" / "+2 dias" (PT-BR com palavra)
 *    - "YYYY-MM-DD HH:MM" sem T separator
 *    - "D/M/YYYY" sem zero-pad
 *    - "amanhã" / "hoje à noite" — NÃO suportado (peça pra LLM usar +Nh)
 */
export function parseFollowupDate(raw: string): number | null {
  const s = raw.trim();
  // 1) "+Nh" / "+Nd" / "+N horas" / "+N dias" — relativo (PT/EN abreviado/completo)
  const rel = s.match(/^\+?\s*(\d+)\s*(h(?:oras?)?|d(?:ias?)?|min(?:utos?)?)\.?$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unitRaw = rel[2]!.toLowerCase();
    if (n > 0 && n < 1500) {
      let ms: number;
      if (unitRaw.startsWith('min')) ms = n * 60 * 1000;
      else if (unitRaw.startsWith('h')) ms = n * 60 * 60 * 1000;
      else ms = n * 24 * 60 * 60 * 1000; // dias
      return Date.now() + ms;
    }
  }
  // 2) "YYYY-MM-DD" só data → assume 14h BRT (UTC-3) = 17h UTC.
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), 17, 0, 0);
  }
  // 2b) "YYYY-MM-DD HH:MM" sem T separator → BRT (UTC-3).
  const dateTimeNoT = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (dateTimeNoT) {
    const [, y, m, d, hh, mm, ss = '0'] = dateTimeNoT;
    // Se tem 'T' e termina com Z/+/-, deixa pro Date.parse no passo 4.
    if (!/[Z+]/.test(s) && !/-\d{2}:\d{2}$/.test(s)) {
      return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) + 3, Number(mm), Number(ss));
    }
  }
  // 3) "D/M/YYYY [HH:MM]" — formato BR (com ou sem zero-pad).
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (br) {
    const [, d, m, y, hh = '14', mm = '00'] = br;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) + 3, Number(mm), 0);
  }
  // 4) ISO 8601 completo (com TZ). Date.parse trata.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;
  return null;
}

// ─── consultar_historico ─────────────────────────────────────────────────

const consultarHistorico: ToolDef = {
  name: 'consultar_historico',
  description: 'Retorna as últimas N mensagens trocadas com o cliente, formatadas. Útil quando precisa relembrar contexto antigo que saiu do contexto atual.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      turnos: { type: 'number', description: 'Quantas mensagens retornar (1-50). Default 20.' },
    },
  },
  execute(args, ctx) {
    const limit = Math.min(50, Math.max(1, Number(args.turnos) || 20));
    if (!ctx.card.contactId) return { ok: true, result: { history: [] } };
    const acts = store.listActivitiesByContact(ctx.tenantId, ctx.card.contactId, 1000);
    const msgs = acts
      .filter((a) => a.type === 'message_in' || a.type === 'message_out')
      .slice(-limit);
    return {
      ok: true,
      result: {
        history: msgs.map((a) => ({
          role: a.type === 'message_out' ? 'agente' : 'cliente',
          text: a.content || '',
          at: a.createdAt,
        })),
      },
    };
  },
};

// ─── ler_dados_card ──────────────────────────────────────────────────────

const lerDadosCard: ToolDef = {
  name: 'ler_dados_card',
  description: 'Retorna os dados estruturados ja coletados pelo agente neste card (qualificacao + lista de campos sensitive ja preenchidos, mascarados). Se voce eh o role coletor_dados e precisa do valor REAL de algum campo sensitive (pra validar/usar), passa unmask=true.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      unmask: { type: 'boolean', description: 'Se true, retorna dados sensitive em CLARO. SO funciona se role=coletor_dados.' },
    },
  },
  execute(args, ctx) {
    const wantsUnmask = args.unmask === true;
    const isColetor = ctx.role === 'coletor_dados' || ctx.role === 'coletor';
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const qualification = collected.qualification ?? null;
    const sensitive = (collected.sensitive ?? null) as SensitiveBag | null;

    let sensitiveOut: Record<string, string> | Record<string, unknown>;
    let unmaskIgnored = false;
    if (wantsUnmask && isColetor) {
      sensitiveOut = decryptAllSensitive(sensitive);
    } else {
      // Daniel 2026-05-06: vendedor chama unmask=true em ~65/sem (loop de
      // tool_failed que custa tokens e atrasa resposta). Em vez de falhar
      // com permission_denied — vendedor não precisa PII em claro mesmo —
      // retorna sucesso mascarado e sinaliza unmask_ignored. PII fica
      // protegida; LLM consome qualification + last_quotation que é o que
      // ele realmente usa.
      if (wantsUnmask && !isColetor) unmaskIgnored = true;
      sensitiveOut = maskAllSensitive(sensitive);
    }

    // PR 5: expõe last_quotation se houver (snapshot da ultima cotacao gerada).
    // Closer + Finalizador usam pra ter contexto exato dos planos sem reler historico.
    const lastQuotation = (collected as any).last_quotation ?? null;
    return {
      ok: true,
      result: {
        contact: {
          name: ctx.card.title,
          phone: ctx.customerPhone,
        },
        qualification,
        sensitive: sensitiveOut,
        sensitive_fields_filled: listSensitiveFields(sensitive),
        last_quotation: lastQuotation,
        column: { id: ctx.column.id, name: ctx.column.name, role: ctx.role },
        turns: fresh.turnsCount,
        ...(unmaskIgnored ? { unmask_ignored: true, unmask_ignored_reason: `role=${ctx.role} sem permissão; dados retornados mascarados` } : {}),
      },
    };
  },
};

// ─── handoff_para_corretor ───────────────────────────────────────────────

const handoffParaCorretor: ToolDef = {
  name: 'handoff_para_corretor',
  description: 'Encerra o atendimento automatico e direciona o cliente DIRETO pro corretor humano (Daniel). Move o card pra coluna "Lancar venda" e dispara alerta WhatsApp pro Daniel AGORA. Use quando: (a) cliente foi vago apos sua saudacao inicial e nao deu contexto sobre o que quer (lead aleatorio), (b) voce identificou que o caso precisa do humano direto.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razao objetiva em 1 frase (ex: "lead aleatorio sem contexto", "cliente pediu pra falar com humano direto").' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';

    const cols = store.listColumns(ctx.tenantId, ctx.card.boardId!);
    const target = cols.find((c) => /^lan[çc]ar\s*venda$/i.test(c.name));
    let movedTo: string | null = null;
    if (target && target.id !== ctx.card.columnId) {
      try {
        store.moveCard(ctx.tenantId, ctx.card.id, target.id);
        movedTo = target.id;
      } catch (err: any) {
        logger.warn('[tool.handoff_para_corretor] moveCard falhou:', err?.message);
      }
    }

    try {
      const { applyTagSystem } = await import('./tags.js');
      applyTagSystem(ctx.card.id, 'handoff_corretor');
    } catch { /* nao bloqueia */ }

    setCardAgentStatus(ctx.card.id, 'escalated');

    let contactName: string | undefined;
    try {
      const c = ctx.card.contactId ? store.getContact?.(ctx.tenantId, ctx.card.contactId) : null;
      contactName = c?.name;
    } catch { /* noop */ }

    try {
      await outbound.emit(ctx.tenantId, 'agent.escalated', {
        cardId: ctx.card.id,
        cardTitle: ctx.card.title,
        contactName,
        contactPhone: ctx.customerPhone,
        columnId: target?.id ?? ctx.column.id,
        columnName: target?.name ?? ctx.column.name,
        role: ctx.role,
        urgencia: 'alta',
        reason: `handoff: ${motivo}`,
        turnsInColumn: ctx.state.turnsCount,
      });
    } catch (err: any) {
      logger.warn('[tool.handoff_para_corretor] outbound emit falhou:', err?.message);
    }

    if (process.env.URGENT_ALERT_PHONE) {
      void sendUrgentWhatsAppAlert(ctx, `HANDOFF: ${motivo}`, contactName).catch((err: any) => {
        logger.warn('[tool.handoff_para_corretor] urgent alert falhou:', err?.message);
      });
    }

    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'escalated', reason: `handoff_corretor: ${motivo}`,
      turnsInColumn: ctx.state.turnsCount,
    });

    logger.info(`[tool.handoff_para_corretor] card=${ctx.card.id} motivo="${motivo}" movedTo=${target?.name ?? '(sem coluna)'}`);
    return { ok: true, result: { handoff: true, movedTo } };
  },
};

export const COMMON_TOOLS: ToolDef[] = [
  escalarHumano,
  marcarPerdido,
  marcarMorno,
  agendarFollowup,
  consultarHistorico,
  lerDadosCard,
  handoffParaCorretor,
];

/** PV Corretora — unico tenant onde auto-promote deterministico opera.
 *  Daniel 2026-05-05: scope global causou vazamento cross-tenant. */
const PV_TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';

/**
 * Auto-promote deterministico (PV Corretora apenas).
 *
 * Daniel 2026-05-05: o LLM as vezes coleta os dados via salvar_dados_qualificacao
 * mas esquece de chamar promover_para_vendedor_funeral, deixando o card preso no
 * Lead apos cliente ja ter dado todos os dados pra cotacao. O fluxo Daniel quer
 * (Lead → Atendimento Humano) tem que ser garantido independente do LLM.
 *
 * Chamado apos cada turno bem-sucedido do agente. Se o state tem qualification
 * completa (4 campos minimos), move o card pra coluna alvo automaticamente.
 * Idempotente — validatePromotionTarget retorna alreadyPromoted se ja moveu.
 */
export function maybeAutoPromote(ctx: ToolContext): { promoted: boolean; reason?: string } {
  // GUARD 1: scope PV apenas. Outros tenants ficam de fora.
  if (ctx.tenantId !== PV_TENANT_ID) return { promoted: false, reason: 'not_pv' };
  // GUARD 2: coluna precisa ter destino configurado.
  if (!ctx.column.agentPromoteToColumnId) return { promoted: false, reason: 'no_promote_target' };
  // GUARD 0 (Daniel 2026-05-06): auto-promote SO opera Lead→Atendimento Humano
  // (role qualificador). Bug grave: o vendedor herdava `qualification` do Lead
  // (nome/idade/tipo/composicao todos preenchidos) e era promovido auto pra
  // "Lancar Venda" SEM ter fechado venda nem coletado CPF/RG/email/telefone.
  // Ele moveu 7 cards (Luiz Carlos, Neni, Graca, Ingrid, Regiane, Edvaldo,
  // help moraes) sem nenhum desses dados — venda inexistente.
  if (ctx.role !== 'qualificador') return { promoted: false, reason: 'auto_promote_qualificador_only' };

  // Re-resolve state — pode ter mudado durante o tool loop (LLM ja promoveu).
  const fresh = getCardAgentState(ctx.card.id);
  if (!fresh) return { promoted: false, reason: 'no_state' };
  if (fresh.columnId !== ctx.column.id) return { promoted: false, reason: 'already_moved' };

  // GUARD 3: dados minimos coletados. Se LLM nao chamou salvar_dados_qualificacao
  // ou so chamou parcialmente, nao promove — bot continua coletando.
  const q = (fresh.collectedData as Record<string, unknown> | undefined)?.qualification as
    | Record<string, unknown> | undefined;
  if (!q) return { promoted: false, reason: 'no_qualification' };
  const hasNome = typeof q.nome === 'string' && q.nome.trim().length > 0;
  const hasIdade = typeof q.idade === 'number' && q.idade > 0 && q.idade <= 74;
  const hasTipo = typeof q.tipo_plano === 'string' && q.tipo_plano.trim().length > 0;
  const hasComp = typeof q.composicao_familiar === 'string' && q.composicao_familiar.trim().length > 0;
  if (!hasNome || !hasIdade || !hasTipo || !hasComp) {
    return { promoted: false, reason: `missing:${[!hasNome && 'nome', !hasIdade && 'idade', !hasTipo && 'tipo', !hasComp && 'composicao'].filter(Boolean).join(',')}` };
  }

  // GUARD 4: pelo menos 2 turnos do cliente — evita promover na primeira msg
  // se o LLM por algum motivo salvar tudo de cara (edge case suspeito).
  if (fresh.turnsCount < 2) return { promoted: false, reason: `turns_too_low=${fresh.turnsCount}` };

  // Valida destino e move
  const v = validatePromotionTarget(ctx);
  if (v.alreadyPromoted) return { promoted: false, reason: 'already_promoted' };
  if (!v.ok || !v.target) return { promoted: false, reason: v.error || 'invalid_target' };

  logger.info(
    `[auto-promote] PV card=${ctx.card.id} qualification complete (nome=${q.nome}, idade=${q.idade}, tipo=${q.tipo_plano}) — moving to "${v.target.name}"`,
  );
  const result = executePromotion(ctx, v.target, 'auto-promote: dados completos sem chamada LLM', 'vendedor_funeral');
  return { promoted: result.ok, reason: result.ok ? 'moved' : (result.error || 'execute_failed') };
}

/** Helper compartilhado pra promote_*: valida coluna destino e mantem
 *  idempotencia. Devolve { ok, error?, target? }. */
export interface ValidatedPromotion {
  ok: boolean;
  error?: string;
  alreadyPromoted?: boolean;
  target?: BoardColumnLike;
}
type BoardColumnLike = { id: string; name: string; boardId: string };

export function validatePromotionTarget(ctx: ToolContext): ValidatedPromotion {
  // Idempotencia: state ja avancou? Cardja moveu nesta interacao?
  const fresh = getCardAgentState(ctx.card.id);
  if (fresh && fresh.columnId !== ctx.column.id) {
    return { ok: true, alreadyPromoted: true };
  }
  const targetId = ctx.column.agentPromoteToColumnId;
  if (!targetId) {
    return { ok: false, error: 'promote_target_not_configured' };
  }
  const cols = store.listColumns(ctx.tenantId, ctx.card.boardId!);
  const target = cols.find((c) => c.id === targetId);
  if (!target) {
    return { ok: false, error: 'target_column_not_found_in_board' };
  }
  return { ok: true, target: { id: target.id, name: target.name, boardId: target.boardId } };
}

/** Executa de fato a promocao: move card, atualiza state, append promotionLog,
 *  grava metric. Re-usado por todos os promote_*. */
export function executePromotion(
  ctx: ToolContext,
  target: BoardColumnLike,
  motivo: string,
  toRole: import('../../types.js').ColumnAgentRole,
  extra?: Record<string, unknown>,
): ToolResult {
  try {
    store.moveCard(ctx.tenantId, ctx.card.id, target.id);
  } catch (err: any) {
    return { ok: false, error: `move_card_failed: ${err?.message || 'unknown'}` };
  }
  // Reset last_bot_message_at na transicao de coluna. last_bot_message_at e
  // per-coluna na semantica do funil (entry_delay/chase ancoram nele); se o
  // role anterior emitiu uma despedida apos chamar promover_*, sendOutbound
  // bumpa esse timestamp pra DEPOIS de column_changed_at e
  // findEntryDelayCards filtra fora o card pra sempre. Zerar aqui garante
  // que o entry_delay do role novo dispara, e o chase volta a contar a
  // partir da primeira msg que o novo role emitir.
  try {
    getCrmDb()
      .prepare('UPDATE crm_cards SET last_bot_message_at = NULL WHERE id = ? AND tenant_id = ?')
      .run(ctx.card.id, ctx.tenantId);
  } catch (err: any) {
    logger.warn(`[executePromotion] reset last_bot_message_at falhou card=${ctx.card.id}: ${err?.message}`);
  }
  const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
  const log = Array.isArray(fresh.promotionLog) ? [...fresh.promotionLog] : [];
  log.push({
    fromColumnId: ctx.column.id,
    toColumnId: target.id,
    fromRole: ctx.role,
    toRole,
    reason: motivo,
    at: Date.now(),
  });
  upsertCardAgentState({
    cardId: ctx.card.id,
    columnId: target.id,
    currentAgentRole: toRole,
    tenantId: ctx.tenantId,
    turnsCount: 0, // reset turns na nova coluna
    inactivityTimerAt: null, // PR 4: nova coluna re-arma se quiser
    inactivityFireCount: 0,
    promotionLog: log,
    status: 'active',
  });
  recordAgentMetric({
    tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
    event: 'promoted',
    reason: extra?.tag ? `${motivo}|tag=${extra.tag}` : motivo,
    turnsInColumn: ctx.state.turnsCount,
  });
  return {
    ok: true,
    result: {
      moved_to: { id: target.id, name: target.name },
      from_role: ctx.role,
      to_role: toRole,
      ...(extra ?? {}),
    },
  };
}

// re-export pra cada role
void J; // silence unused on inicial sem uso
