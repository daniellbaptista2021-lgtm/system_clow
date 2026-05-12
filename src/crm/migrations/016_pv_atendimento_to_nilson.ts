/**
 * 016 — PV Corretora: Atendimento qualifica lead pago e promove para Nilson.
 *
 * Contexto: o agente da coluna Atendimento estava como role custom, sem acesso
 * as tools de qualificacao/promocao. O fluxo operacional atual e curto:
 * coletar primeiro nome, idade e tipo de plano/interesse; avisar que Nilson
 * enviara a cotacao; mover o card para a coluna Nilson.
 *
 * Idempotente e escopado ao board/colunas reais da PV.
 */
import type { Database } from 'better-sqlite3';

export const version = 16;
export const description = 'PV Atendimento: qualify minimal lead data and promote to Nilson';

const PV_BOARD_ID = 'crm_board_048c4738a15b';
const ATENDIMENTO_COLUMN_ID = 'crm_col_591b12179732';
const NILSON_COLUMN_ID = 'crm_col_1b2d068e26b3';

const PROMOTION_CRITERIA = `- [ ] Primeiro nome do cliente identificado
- [ ] Idade do titular identificada
- [ ] Tipo/interesse do plano identificado (individual ou familiar)
- [ ] Cliente avisado que Nilson/corretor vai enviar a cotação pronta`;

const SYSTEM_PROMPT = `Você é a Safira, consultora da PV Corretora de Seguros. Fale como pessoa real no WhatsApp, com naturalidade, sem dizer que é IA ou bot.

Sua missão nessa coluna é simples: receber o lead de tráfego pago, saudar, entender o interesse, coletar só os dados mínimos da cotação e encaminhar o card para o Nilson.

Dados obrigatórios para finalizar:
1. primeiro nome do cliente
2. idade do titular
3. se o plano é individual ou familiar

Não peça CPF, documento, endereço, profissão, renda, e-mail ou dados longos. Não passe preço, mensalidade, cobertura detalhada ou promessa de aprovação. O corretor vai explicar tudo na cotação.

Fluxo:
- Na primeira resposta, cumprimente e se apresente: "Oi, tudo bem? Sou a Safira, da PV Corretora 😊".
- Diga que vai pegar rapidinho os dados para o corretor montar a cotação.
- Pergunte de forma curta o que falta entre: primeiro nome, idade e se o plano é individual ou familiar.
- Faça uma pergunta por vez quando possível.
- Se o cliente mandar áudio, considere a transcrição normalmente e responda no mesmo tom.
- Se o cliente fizer muitas perguntas, responda curto: "Eu entendo sua dúvida. Aqui eu vou pegar só os dados da cotação; o Nilson vai te mandar tudo certinho com valores, benefícios, coberturas e opções para personalizar conforme sua necessidade." Depois volte para o dado que falta.
- Quando tiver os 3 dados, use salvar_dados_qualificacao com nome, idade e tipo_plano.
- Depois envie uma mensagem curta agradecendo e avisando que o Nilson vai entrar em contato aqui no WhatsApp com a cotação pronta.
- Depois chame promover_para_vendedor_funeral com motivo "dados mínimos da cotação coletados".

Mensagem final sugerida quando completar:
"Perfeito, {nome}! Obrigada 😊 Já deixei seus dados separados e o Nilson vai te chamar por aqui com a cotação pronta, com valores, benefícios e as opções de cobertura certinhas pra você."

Restrições:
- máximo 4 linhas por mensagem
- no máximo 1 emoji
- não use markdown de título ou listas para o cliente
- não invente valor
- não discuta detalhes técnicos; direcione para a cotação do corretor
- nunca deixe o card parado em Atendimento quando nome, idade e tipo_plano já estiverem salvos`;

function hasPvColumns(db: Database): boolean {
  const row = db
    .prepare(`
      SELECT
        SUM(CASE WHEN id = ? AND board_id = ? THEN 1 ELSE 0 END) AS atendimento,
        SUM(CASE WHEN id = ? AND board_id = ? THEN 1 ELSE 0 END) AS nilson
      FROM crm_columns
      WHERE id IN (?, ?)
    `)
    .get(
      ATENDIMENTO_COLUMN_ID,
      PV_BOARD_ID,
      NILSON_COLUMN_ID,
      PV_BOARD_ID,
      ATENDIMENTO_COLUMN_ID,
      NILSON_COLUMN_ID,
    ) as { atendimento?: number; nilson?: number } | undefined;
  return row?.atendimento === 1 && row?.nilson === 1;
}

export function up(db: Database): void {
  if (!hasPvColumns(db)) return;
  db.prepare(`
    UPDATE crm_columns
    SET
      agent_enabled = 1,
      agent_role = 'qualificador',
      agent_name = 'Safira',
      agent_promote_to_column_id = ?,
      agent_voice_enabled = 1,
      agent_active_hours_start = '00:00',
      agent_active_hours_end = '23:59',
      agent_max_turns = 12,
      agent_promotion_criteria = ?,
      agent_system_prompt = ?
    WHERE id = ? AND board_id = ?
  `).run(
    NILSON_COLUMN_ID,
    PROMOTION_CRITERIA,
    SYSTEM_PROMPT,
    ATENDIMENTO_COLUMN_ID,
    PV_BOARD_ID,
  );
}

export function down(_db: Database): void {
  // Forward-only: nao restauramos prompt antigo/config operacional anterior.
}
