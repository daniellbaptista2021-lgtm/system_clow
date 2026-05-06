/**
 * cotar_sulamerica_api — cotação OFFLINE com tabela hardcoded.
 *
 * Daniel 2026-05-06 (refactor pós-incidente Follow Up): produto
 * simplificado pro lançamento. Sem API externa, sem timeout, sem variação
 * por capital. Tabela fixa por (composição × faixa de idade do titular)
 * e adicionais determinísticos. Bot só passa idade + composição;
 * tool retorna `userVisible` pronto.
 *
 * Mantém o nome `cotar_sulamerica_api` (mesma assinatura) pra não quebrar
 * o outputValidator (whitelist) nem o prompt antigo. A implementação fica
 * 100% offline — instantânea, determinística, zero alucinação.
 */

import { logger } from '../../../utils/logger.js';
import {
  getCardAgentState,
  upsertCardAgentState,
  recordAgentMetric,
} from '../../store/cardAgentStateStore.js';
import type { ToolDef } from './types.js';

// ─── Tabela de preços (Daniel 2026-05-06) ───────────────────────────────
// Idade do titular: faixa "young" = 18..45, faixa "older" = 46..74.
// Valores em CENTS pra evitar erro de ponto flutuante.
const PRICE_TABLE_CENTS: Record<Composicao, [young: number, older: number]> = {
  individual:    [2990,  3990],   // só titular
  casal:         [3990,  4990],   // titular + cônjuge
  casal_filhos:  [4990,  5990],   // titular + cônjuge + filhos<=21
  completo:      [8990, 10990],   // + pai + mãe + sogro + sogra
};

const ADICIONAL_FILHO_MAIOR_21_CENTS = 1200;       // R$ 12 cada
const ADICIONAL_OUTRO_DEPENDENTE_CENTS = 1400;     // R$ 14 cada
const MEDICO_NA_TELA_CENTS = 1400;                 // +R$ 14 sobre o principal

const IDADE_MIN_TITULAR = 18;
const IDADE_MAX_TITULAR = 74;
const FAIXA_JOVEM_LIMITE = 45; // <=45 entra na coluna jovem; 46+ na older

type Composicao = 'individual' | 'casal' | 'casal_filhos' | 'completo';

interface CotarArgs {
  idade?: number;
  composicao?: Composicao;
  filhos_maior_21?: number;
  outros_dependentes?: number;
  incluir_medico_tela?: boolean;
}

function brl(cents: number): string {
  const reais = (cents / 100).toFixed(2).replace('.', ',');
  return `R$ ${reais}`;
}

function isFaixaJovem(idade: number): boolean {
  return idade <= FAIXA_JOVEM_LIMITE;
}

function descricaoComposicao(c: Composicao): string {
  switch (c) {
    case 'individual': return 'Individual (só você)';
    case 'casal': return 'Casal (você + cônjuge)';
    case 'casal_filhos': return 'Casal + Filhos até 21 anos';
    case 'completo': return 'Completo (você + cônjuge + filhos até 21 + pais e sogros)';
  }
}

const cotarSulamericaApi: ToolDef = {
  name: 'cotar_sulamerica_api',
  description: [
    'Calcula o valor mensal do Plano Funeral SulAmérica usando a tabela oficial PV Corretora.',
    'NÃO chama API externa — cálculo instantâneo via tabela. Use SEMPRE que precisar mostrar valor pro cliente.',
    'Parâmetros:',
    '  - idade (number): idade do titular (18-74). Lê de qualification se não passar.',
    '  - composicao (string): "individual" (só titular) | "casal" (titular + cônjuge) | "casal_filhos" (+ filhos<=21) | "completo" (+ pais e sogros).',
    '  - filhos_maior_21 (number): quantos filhos > 21 anos (planos separados R$ 12 cada).',
    '  - outros_dependentes (number): outros parentes não-elegíveis pra apólice principal (R$ 14 cada). Default 0.',
    '  - incluir_medico_tela (boolean): adiciona R$ 14 ao valor mensal pelo benefício extra Médico na Tela 24h.',
    'Retorna `userVisible` com a cotação completa formatada — manda LITERAL pro cliente.',
  ].join('\n'),
  // Vou manter os roles existentes — a coluna unificada (etapa 3) vai
  // usar role='vendedor' que já cobre. Sem precisar mexer no schema.
  roles: ['vendedor', 'vendedor_funeral', 'cotador'],
  parameters: {
    type: 'object',
    properties: {
      idade: { type: 'number', description: 'Idade do titular (18-74).' },
      composicao: {
        type: 'string',
        enum: ['individual', 'casal', 'casal_filhos', 'completo'],
        description: 'Composição da apólice principal.',
      },
      filhos_maior_21: { type: 'number', description: 'Quantos filhos > 21 anos (cobrança separada R$ 12 cada).' },
      outros_dependentes: { type: 'number', description: 'Outros parentes que não cabem na apólice principal (R$ 14 cada).' },
      incluir_medico_tela: { type: 'boolean', description: 'Adicionar Médico na Tela 24h por +R$ 14/mês.' },
    },
  },
  async execute(args: Record<string, unknown>, ctx) {
    const a = args as CotarArgs;

    // ─── 1) Resolver idade + composição ────────────────────────────────
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const qual = (collected.qualification ?? {}) as Record<string, unknown>;

    const idade = typeof a.idade === 'number' ? a.idade : Number(qual.idade);
    const composicao = (a.composicao || qual.composicao || 'individual') as Composicao;

    if (!Number.isFinite(idade) || idade < IDADE_MIN_TITULAR || idade > IDADE_MAX_TITULAR) {
      return {
        ok: false,
        error: `idade_invalida: precisa ser ${IDADE_MIN_TITULAR}-${IDADE_MAX_TITULAR} (recebido=${idade}). Cliente fora da faixa SulAmérica — use escalar_humano se titular > 74.`,
      };
    }
    if (!PRICE_TABLE_CENTS[composicao]) {
      return {
        ok: false,
        error: `composicao_invalida: "${composicao}". Use "individual" | "casal" | "casal_filhos" | "completo".`,
      };
    }

    // ─── 2) Calcular preço base ────────────────────────────────────────
    const [precoYoung, precoOlder] = PRICE_TABLE_CENTS[composicao];
    const baseCents = isFaixaJovem(idade) ? precoYoung : precoOlder;

    const filhos21 = Math.max(0, Math.floor(a.filhos_maior_21 || 0));
    const outros = Math.max(0, Math.floor(a.outros_dependentes || 0));
    const medicoTela = a.incluir_medico_tela === true;

    // Adicionais
    const adicFilhos = filhos21 * ADICIONAL_FILHO_MAIOR_21_CENTS;
    const adicOutros = outros * ADICIONAL_OUTRO_DEPENDENTE_CENTS;
    const adicMedicoTela = medicoTela ? MEDICO_NA_TELA_CENTS : 0;

    // Valor mensal único (apólice principal + médico na tela). Adicionais
    // de filhos>21 e outros parentes são apólices SEPARADAS e ficam
    // descritas à parte (cliente paga em boletos separados).
    const principalCents = baseCents + adicMedicoTela;
    const totalIncluindoSeparadosCents = principalCents + adicFilhos + adicOutros;

    // ─── 3) Montar userVisible ─────────────────────────────────────────
    const customerName = ctx.card.title || (qual.nome as string | undefined) || '';
    const greeting = customerName ? customerName.split(/\s+/)[0] : '';

    const isIndividual = composicao === 'individual';
    const carenciaNatural = isIndividual ? '90 dias' : '120 dias';
    const compoLabel = descricaoComposicao(composicao);

    const lines: string[] = [];
    lines.push('🛡️ *Plano Funeral SulAmérica — sua proteção completa*');
    lines.push('');
    lines.push(`*Plano ${compoLabel}*`);
    lines.push('');
    lines.push('*Tudo isso incluso pra você:*');
    lines.push('✅ *Indenização de R$ 50 mil* em caso de morte por acidente');
    lines.push('✅ *Indenização de R$ 50 mil* em caso de invalidez por acidente');
    lines.push('✅ *Diária de R$ 500 por dia* de internação por acidente');
    lines.push('✅ *Descontos em farmácias e medicamentos*');
    if (medicoTela) {
      lines.push('✅ *Médico na Tela 24h* — telemedicina pra toda a família');
    }
    lines.push('');
    lines.push('*Assistência Funeral completa em todo Brasil:*');
    lines.push('🚐 Translado nacional');
    lines.push('🌸 Ornamentação completa · 💐 8 flores');
    lines.push('⚱️ Urnas exclusivas cromadas com divisores');
    lines.push('🏛️ Aluguel de capela · velório completo');
    lines.push('🧴 Tanatopraxia');
    lines.push('🔥 Cremação inclusa (em todo o país)');
    lines.push('📜 Certidão de óbito · taxas cemiteriais inclusas');
    lines.push('');

    // Quem entra
    if (composicao === 'individual') {
      lines.push('*Quem está coberto:* só você (titular).');
    } else if (composicao === 'casal') {
      lines.push('*Quem está coberto:* você + cônjuge.');
    } else if (composicao === 'casal_filhos') {
      lines.push('*Quem está coberto:* você + cônjuge + filhos até 21 anos.');
    } else {
      lines.push('*Quem está coberto:* você + cônjuge + filhos até 21 + pai e mãe + sogro e sogra.');
    }
    lines.push('');

    // Valor da apólice principal
    lines.push(`💰 *${brl(principalCents)}/mês* — apólice principal`);
    if (medicoTela) {
      lines.push(`   _(${brl(baseCents)} do plano + ${brl(MEDICO_NA_TELA_CENTS)} do Médico na Tela)_`);
    }

    // Adicionais separados (planos à parte)
    if (filhos21 > 0 || outros > 0) {
      lines.push('');
      lines.push('*Planos separados (apólices à parte):*');
      if (filhos21 > 0) {
        lines.push(`• ${filhos21} filho(s) > 21 anos: ${brl(ADICIONAL_FILHO_MAIOR_21_CENTS)} cada = ${brl(adicFilhos)}/mês`);
      }
      if (outros > 0) {
        lines.push(`• ${outros} dependente(s) extra(s): ${brl(ADICIONAL_OUTRO_DEPENDENTE_CENTS)} cada = ${brl(adicOutros)}/mês`);
      }
      lines.push(`💰 *Total geral: ${brl(totalIncluindoSeparadosCents)}/mês*`);
    }
    lines.push('');

    lines.push('*Carências oficiais:*');
    lines.push('• Morte/invalidez por acidente: _zero_ (cobre já no 1º dia)');
    lines.push(`• Morte natural: ${carenciaNatural}`);
    lines.push('');
    lines.push('✅ *Sem declaração de saúde* · *sem taxa de adesão*');
    lines.push('💳 Pagamento por *cartão recorrente*, *boleto mensal* ou *Pix*');
    lines.push('');
    lines.push(greeting ? `E aí, _${greeting}_? O que achou? 😊` : 'E aí? O que achou? 😊');

    const userVisible = lines.join('\n');

    // ─── 4) Salvar snapshot ────────────────────────────────────────────
    const snapshot = {
      at: Date.now(),
      idade,
      composicao,
      filhos_maior_21: filhos21,
      outros_dependentes: outros,
      incluir_medico_tela: medicoTela,
      base_cents: baseCents,
      principal_cents: principalCents,
      adic_filhos_cents: adicFilhos,
      adic_outros_cents: adicOutros,
      total_cents: principalCents, // valor único da apólice principal — o que entra no validator
      total_incluindo_separados_cents: totalIncluindoSeparadosCents,
    };
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, cotacao_api: snapshot, last_quotation: snapshot },
    });
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_called',
      reason: `cotar_offline composicao=${composicao} idade=${idade} principal_cents=${principalCents} filhos21=${filhos21} outros=${outros} medico=${medicoTela}`,
    });
    logger.info(`[cotar_sulamerica_api] offline composicao=${composicao} idade=${idade} principal=${brl(principalCents)} card=${ctx.card.id}`);

    return {
      ok: true,
      result: {
        total_cents: principalCents,
        total_incluindo_separados_cents: totalIncluindoSeparadosCents,
        composicao,
        idade,
      },
      userVisible,
    };
  },
};

export const COTACAO_SULAMERICA_TOOLS: ToolDef[] = [cotarSulamericaApi];
