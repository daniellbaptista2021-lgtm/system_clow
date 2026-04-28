/**
 * Tools do role 'finalizador' — coleta dados pra emissao da proposta
 * SulAmerica AP Flex (PR 5.1), valida formato, cifra dados sensiveis,
 * e promove pro Daniel humano.
 *
 * Coleta os 17 campos requeridos:
 *   Titular (15): nome_completo, cpf, rg, data_nascimento, sexo,
 *                 estado_civil, nacionalidade, nome_mae, dia_vencimento,
 *                 celular, email, cep, endereco_completo, profissao,
 *                 altura, peso. (16 fields — altura/peso podem ser separados)
 *   Cada dependente (4): nome_completo, parentesco, cpf, data_nascimento.
 */
import { logger } from '../../../utils/logger.js';
import {
  upsertCardAgentState,
  getCardAgentState,
  recordAgentMetric,
} from '../../store/cardAgentStateStore.js';
import { encryptPII, listSensitiveFields, type SensitiveBag } from '../piiCrypto.js';
import { buildQuotation } from '../quotation/quotationEngine.js';
import * as outbound from '../../outboundWebhooks.js';
import * as store from '../../store.js';
import { validatePromotionTarget, executePromotion } from './common.js';
import type { ToolDef } from './types.js';
import type { QualificationData } from '../../types.js';

// ─── validar_cpf ─────────────────────────────────────────────────────────

/**
 * Valida CPF brasileiro com 2 niveis:
 *  1. Formato valido: 11 digitos puros OU 'XXX.XXX.XXX-XX' literal
 *  2. Algoritmo digito verificador
 *
 * Bug PR 5.1: a versao anterior aceitava strings tipo "137.44793737"
 * (3+8 digitos sem hifen) porque so removia non-digits e checava soma.
 * Agora valida o SHAPE primeiro — formato bagunçado eh rejeitado mesmo
 * que os digitos por sorte batam.
 */
function isValidCPFFormat(cpf: string): boolean {
  // Aceita 2 formatos exatos: "XXXXXXXXXXX" (11 dig) ou "XXX.XXX.XXX-XX"
  if (/^\d{11}$/.test(cpf)) return true;
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(cpf)) return true;
  return false;
}

function isValidCPFDigit(cpf: string): boolean {
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

/** Valida CPF em 2 fases: formato + digito. Exposto pra teste isolado. */
export function isValidCPF(cpf: string): boolean {
  const trimmed = String(cpf || '').trim();
  if (!isValidCPFFormat(trimmed)) return false;
  return isValidCPFDigit(trimmed);
}

const validarCpf: ToolDef = {
  name: 'validar_cpf',
  description: 'Valida CPF (formato + digito verificador). Aceita 2 formatos: 11 digitos puros ("12345678900") ou mascarado ("123.456.789-00"). Qualquer formato bagunçado retorna invalido. Use ANTES de salvar.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      cpf: { type: 'string', description: 'CPF do cliente (com ou sem mascara, mas com formato valido)' },
    },
    required: ['cpf'],
  },
  execute(args, _ctx) {
    const cpfInput = String(args.cpf || '');
    const valid = isValidCPF(cpfInput);
    return {
      ok: true,
      result: {
        valid,
        formato: 'aceito: "XXXXXXXXXXX" (11 digitos) ou "XXX.XXX.XXX-XX" (mascarado)',
      },
    };
  },
};

// ─── validar_cep ─────────────────────────────────────────────────────────

const validarCep: ToolDef = {
  name: 'validar_cep',
  description: 'Valida o formato do CEP (8 digitos). Aceita "XXXXXXXX" ou "XXXXX-XXX". Stub: nao consulta ViaCEP nesta versao.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      cep: { type: 'string', description: 'CEP com ou sem traco' },
    },
    required: ['cep'],
  },
  execute(args, _ctx) {
    const v = String(args.cep || '').trim();
    const formatOk = /^\d{8}$/.test(v) || /^\d{5}-\d{3}$/.test(v);
    return { ok: true, result: { valid: formatOk, formato: '00000-000 ou 00000000' } };
  },
};

// ─── salvar_dados_proposta (17 campos SulAmerica) ────────────────────────

interface DependenteData {
  nome_completo?: string;
  parentesco?: string;
  cpf?: string;
  data_nascimento?: string;
}

interface DadosProposta {
  // Titular (15 campos)
  nome_completo?: string;
  cpf?: string;
  rg?: string;
  data_nascimento?: string;
  sexo?: string;
  estado_civil?: string;
  nacionalidade?: string;
  nome_mae?: string;
  dia_vencimento?: number;
  celular?: string;
  email?: string;
  cep?: string;
  endereco_completo?: {
    rua?: string; numero?: string; complemento?: string;
    bairro?: string; cidade?: string; uf?: string;
  };
  profissao?: string;
  altura?: string; // pode ser "1.75m" ou "175cm"
  peso?: string;   // pode ser "78kg"
  // Dependentes
  dependentes?: DependenteData[];
}

const salvarDadosProposta: ToolDef = {
  name: 'salvar_dados_proposta',
  description: 'Salva dados pessoais do titular e dependentes pra proposta SulAmerica AP Flex. Cada campo eh cifrado individualmente (AES-256-GCM). Chame multiplas vezes — faz merge. Campos do titular: nome_completo, cpf, rg, data_nascimento, sexo, estado_civil, nacionalidade, nome_mae, dia_vencimento (1-28), celular, email, cep, endereco_completo (objeto), profissao, altura, peso. Dependentes: array de { nome_completo, parentesco, cpf, data_nascimento }. NUNCA salva senha ou cartao.',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      nome_completo: { type: 'string' },
      cpf: { type: 'string' },
      rg: { type: 'string' },
      data_nascimento: { type: 'string', description: 'YYYY-MM-DD ou DD/MM/YYYY' },
      sexo: { type: 'string', enum: ['M', 'F', 'masculino', 'feminino', 'outro'] },
      estado_civil: { type: 'string' },
      nacionalidade: { type: 'string' },
      nome_mae: { type: 'string' },
      dia_vencimento: { type: 'number', description: 'Dia do mes (1-28) pra vencimento da mensalidade' },
      celular: { type: 'string', description: 'WhatsApp do titular' },
      email: { type: 'string' },
      cep: { type: 'string' },
      endereco_completo: { type: 'object', description: '{rua, numero, complemento, bairro, cidade, uf}' },
      profissao: { type: 'string' },
      altura: { type: 'string', description: 'Ex: "1.75m" ou "175cm"' },
      peso: { type: 'string', description: 'Ex: "78kg"' },
      dependentes: {
        type: 'array',
        description: 'Array de {nome_completo, parentesco, cpf, data_nascimento}',
        items: { type: 'object' },
      },
    },
  },
  execute(args, ctx) {
    const data = args as DadosProposta;
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const sensitive: SensitiveBag = { ...((collected.sensitive as SensitiveBag) ?? {}) };

    const filled: string[] = [];
    const tryEnc = (key: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      sensitive[`${key}_enc`] = encryptPII(value);
      filled.push(key);
    };

    // Titular — 15 campos
    tryEnc('nome_completo', data.nome_completo);
    tryEnc('cpf', typeof data.cpf === 'string' ? data.cpf.replace(/\D/g, '') : data.cpf);
    tryEnc('rg', typeof data.rg === 'string' ? data.rg.trim() : data.rg);
    tryEnc('data_nascimento', data.data_nascimento);
    tryEnc('sexo', data.sexo);
    tryEnc('estado_civil', data.estado_civil);
    tryEnc('nacionalidade', data.nacionalidade);
    tryEnc('nome_mae', data.nome_mae);
    tryEnc('dia_vencimento', data.dia_vencimento);
    tryEnc('celular', typeof data.celular === 'string' ? data.celular.replace(/\D/g, '') : data.celular);
    tryEnc('email', data.email);
    tryEnc('cep', typeof data.cep === 'string' ? data.cep.replace(/\D/g, '') : data.cep);
    tryEnc('endereco_completo', data.endereco_completo);
    tryEnc('profissao', data.profissao);
    tryEnc('altura', data.altura);
    tryEnc('peso', data.peso);

    // Dependentes — array cifrado em bloco (LLM passa todos juntos)
    if (Array.isArray(data.dependentes) && data.dependentes.length > 0) {
      sensitive.dependentes_enc = encryptPII(data.dependentes);
      filled.push('dependentes');
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
  description: 'Move o card pra coluna "Pendente Daniel" (humano vai finalizar a venda na seguradora). So chame com TODOS os dados coletados e validados. Dispara webhook card.ready_for_human (notifica Daniel via outbound webhook configurado).',
  roles: ['finalizador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo: modalidade fechada + dados coletados' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };

    // Coluna destino deletada — escala humano automatico
    if (!v.ok) {
      logger.warn(`[tool.promover_pendente_daniel] target invalido (${v.error}) — escalando humano`);
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

    // PR 5.2: ANTES de promover, calcula snapshot da cotacao silenciosamente
    // pra Daniel humano ter o valor de referencia. NAO eh chamado por LLM,
    // NAO retorna texto pro cliente. Pure utility.
    try {
      const fresh = getCardAgentState(ctx.card.id);
      const collected = (fresh?.collectedData ?? {}) as Record<string, unknown>;
      const qual = (collected.qualification ?? {}) as Partial<QualificationData>;
      // So calcula se ainda nao tem snapshot OU se qualification mudou desde
      // o ultimo. Sempre seguro: idempotente.
      const result = buildQuotation({
        tenantId: ctx.tenantId,
        productType: 'acidentes_pessoais',
        qualification: qual as QualificationData,
        customerName: qual.nomeTitular || ctx.card.title,
      });
      if (result.ok) {
        upsertCardAgentState({
          cardId: ctx.card.id,
          columnId: ctx.column.id,
          currentAgentRole: ctx.role,
          tenantId: ctx.tenantId,
          collectedData: { ...collected, last_quotation: result.snapshot },
        });
      } else {
        logger.warn(`[tool.promover_pendente_daniel] snapshot calc falhou: ${result.error} (segue promocao)`);
      }
    } catch (err: any) {
      logger.warn('[tool.promover_pendente_daniel] snapshot helper threw:', err?.message);
      // Nao bloqueia a promocao — Daniel pode calcular manualmente.
    }

    const promo = executePromotion(ctx, v.target, motivo, 'custom');
    if (!promo.ok) return promo;

    // Webhook card.ready_for_human
    try {
      const fresh = getCardAgentState(ctx.card.id);
      const sensitive = ((fresh?.collectedData as any)?.sensitive ?? {}) as SensitiveBag;
      const qualification = ((fresh?.collectedData as any)?.qualification ?? null);
      const lastQuotation = ((fresh?.collectedData as any)?.last_quotation ?? null);
      const contact = ctx.card.contactId ? store.getContact?.(ctx.tenantId, ctx.card.contactId) : null;
      await outbound.emit(ctx.tenantId, 'card.ready_for_human', {
        cardId: ctx.card.id,
        cardTitle: ctx.card.title,
        contact: contact ? { id: contact.id, name: contact.name, phone: contact.phone } : null,
        contactPhone: ctx.customerPhone,
        movedToColumn: v.target,
        qualification,
        last_quotation: lastQuotation,
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
