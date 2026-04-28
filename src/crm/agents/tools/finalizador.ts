/**
 * Tools do role 'finalizador' — coleta dados pra emissao da proposta,
 * valida formato, cifra dados sensiveis, e promove pro Daniel humano.
 */
import { logger } from '../../../utils/logger.js';
import {
  upsertCardAgentState,
  getCardAgentState,
  recordAgentMetric,
} from '../../store/cardAgentStateStore.js';
import { encryptPII, listSensitiveFields, type SensitiveBag } from '../piiCrypto.js';
import * as outbound from '../../outboundWebhooks.js';
import * as store from '../../store.js';
import { validatePromotionTarget, executePromotion } from './common.js';
import type { ToolDef } from './types.js';

// ─── validar_cpf ─────────────────────────────────────────────────────────

/** Algoritmo de digito verificador do CPF brasileiro. */
function isValidCPF(cpf: string): boolean {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // 11111111111 etc invalido
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let r = (sum * 10) % 11;
  if (r === 10) r = 0;
  if (r !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  r = (sum * 10) % 11;
  if (r === 10) r = 0;
  return r === Number(d[10]);
}

const validarCpf: ToolDef = {
  name: 'validar_cpf',
  description: 'Valida o digito verificador do CPF informado pelo cliente. Use ANTES de salvar — se invalido, peca pro cliente repetir.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      cpf: { type: 'string', description: 'CPF com ou sem mascara' },
    },
    required: ['cpf'],
  },
  execute(args, _ctx) {
    const valid = isValidCPF(String(args.cpf || ''));
    return { ok: true, result: { valid, formato: 'XXX.XXX.XXX-XX esperado' } };
  },
};

// ─── validar_cep ─────────────────────────────────────────────────────────

const validarCep: ToolDef = {
  name: 'validar_cep',
  description: 'Valida o formato do CEP (8 digitos). Stub: nao consulta ViaCEP nesta versao — so checa shape. Implementacao real (resolver UF/cidade automatic) pode vir em PR futuro.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      cep: { type: 'string', description: 'CEP com ou sem traco' },
    },
    required: ['cep'],
  },
  execute(args, _ctx) {
    const d = String(args.cep || '').replace(/\D/g, '');
    const valid = /^[0-9]{8}$/.test(d);
    return { ok: true, result: { valid, formato: '00000-000' } };
  },
};

// ─── salvar_dados_proposta ───────────────────────────────────────────────

interface DadosProposta {
  cpf?: string;
  rg?: string;
  endereco?: {
    cep?: string; rua?: string; numero?: string; bairro?: string;
    cidade?: string; uf?: string;
  } | string;
  beneficiarios?: Array<{
    nome: string; cpf?: string; parentesco?: string; data_nascimento?: string;
  }>;
}

const salvarDadosProposta: ToolDef = {
  name: 'salvar_dados_proposta',
  description: 'Salva os dados sensiveis (CPF, RG, endereco, beneficiarios) com criptografia AES-256-GCM por campo. Faz merge com o que ja foi salvo. NUNCA salva senha ou cartao de credito.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      cpf: { type: 'string', description: 'CPF do titular (sera cifrado)' },
      rg: { type: 'string', description: 'RG ou CNH (sera cifrado)' },
      endereco: { type: 'object', description: 'Objeto com cep/rua/numero/bairro/cidade/uf (sera cifrado completo)' },
      beneficiarios: { type: 'array', description: 'Array de objetos {nome, cpf, parentesco, data_nascimento} (sera cifrado completo)' },
    },
  },
  execute(args, ctx) {
    const data = args as DadosProposta;
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const sensitive: SensitiveBag = { ...((collected.sensitive as SensitiveBag) ?? {}) };

    const filled: string[] = [];
    if (data.cpf) {
      sensitive.cpf_enc = encryptPII(String(data.cpf).replace(/\D/g, ''));
      filled.push('cpf');
    }
    if (data.rg) {
      sensitive.rg_enc = encryptPII(String(data.rg).trim());
      filled.push('rg');
    }
    if (data.endereco) {
      sensitive.endereco_enc = encryptPII(data.endereco);
      filled.push('endereco');
    }
    if (data.beneficiarios && Array.isArray(data.beneficiarios)) {
      sensitive.beneficiarios_enc = encryptPII(data.beneficiarios);
      filled.push('beneficiarios');
    }

    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, sensitive },
    });
    logger.info(`[tool.salvar_dados_proposta] card=${ctx.card.id} fields=[${filled.join(',')}]`);
    return {
      ok: true,
      result: {
        saved: filled,
        sensitive_fields_filled: listSensitiveFields(sensitive),
      },
    };
  },
};

// ─── promover_pendente_daniel ────────────────────────────────────────────

const promoverPendenteDaniel: ToolDef = {
  name: 'promover_pendente_daniel',
  description: 'Move o card pra coluna "Pendente Daniel" (humano vai finalizar a venda na seguradora). So chame com TODOS os dados coletados e validados. Dispara webhook agent.escalated + card.ready_for_human.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo: plano fechado + dados coletados' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };

    // Caso especial: se a coluna destino nao existe, escala humano AUTOMATICO
    // ao inves de retornar erro vago. Card nao pode ficar orfao.
    if (!v.ok) {
      logger.warn(`[tool.promover_pendente_daniel] target invalido (${v.error}) — escalando humano automaticamente`);
      try {
        await outbound.emit(ctx.tenantId, 'agent.escalated', {
          cardId: ctx.card.id,
          cardTitle: ctx.card.title,
          contactPhone: ctx.customerPhone,
          columnId: ctx.column.id,
          columnName: ctx.column.name,
          role: ctx.role,
          reason: `auto_escalated_after_invalid_promote: ${v.error}`,
          turnsInColumn: ctx.state.turnsCount,
        });
      } catch (err: any) {
        logger.warn('[tool.promover_pendente_daniel] outbound emit falhou:', err?.message);
      }
      recordAgentMetric({
        tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
        event: 'escalated', reason: `auto_after_invalid_target: ${v.error}`,
      });
      return { ok: false, error: `coluna_destino_invalida: ${v.error}. Humano notificado.` };
    }

    if (!v.target) return { ok: false, error: 'no_target' };
    const promo = executePromotion(ctx, v.target, motivo, 'custom'); // role=custom (humano assume)
    if (!promo.ok) return promo;

    // Webhook card.ready_for_human — payload com lista de campos sensitive
    // ja preenchidos (sem o conteudo, so quais foram preenchidos)
    try {
      const fresh = getCardAgentState(ctx.card.id);
      const sensitive = ((fresh?.collectedData as any)?.sensitive ?? {}) as SensitiveBag;
      const qualification = ((fresh?.collectedData as any)?.qualification ?? null);
      // Pega contato pra incluir nome no payload
      const contact = ctx.card.contactId ? store.getContact?.(ctx.tenantId, ctx.card.contactId) : null;
      await outbound.emit(ctx.tenantId, 'card.ready_for_human', {
        cardId: ctx.card.id,
        cardTitle: ctx.card.title,
        contact: contact ? { id: contact.id, name: contact.name, phone: contact.phone } : null,
        contactPhone: ctx.customerPhone,
        movedToColumn: v.target,
        qualification,
        sensitive_fields_filled: listSensitiveFields(sensitive),
        reason: motivo,
      });
    } catch (err: any) {
      logger.warn('[tool.promover_pendente_daniel] outbound emit falhou:', err?.message);
    }
    return promo;
  },
};

export const FINALIZADOR_TOOLS: ToolDef[] = [
  validarCpf,
  validarCep,
  salvarDadosProposta,
  promoverPendenteDaniel,
];
