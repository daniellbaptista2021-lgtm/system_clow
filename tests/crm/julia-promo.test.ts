/**
 * TESTE TEMPORÁRIO — validação do fluxo da agente "Julia" (coluna Lead novo).
 *
 * O que testa:
 *   1. Agente responde no turno 1 (saudação qualificando)
 *   2. Lead responde a 1ª pergunta (individual/familiar) → agente faz a 2ª
 *   3. Lead responde a 2ª pergunta (tipo de plano) → agente chama a tool
 *      promover_para_qualificado (papel=qualificador) → card move pra "Qualificado"
 *   4. Observa o que acontece com o envio da mensagem final (kill switch)
 *
 * Roda contra CLONE do DB real (CLOW_HOME=/tmp/julia-test) pra não tocar em produção.
 * LLM mockado com roteiro determinístico; sendReply mockado (não envia WhatsApp real).
 */
process.env.CLOW_HOME = '/tmp/julia-test';
process.env.CRM_DB_PATH = '';
process.env.CLOW_MODO_BONUS = 'false';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../src/crm/ai/agent.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendReply: vi.fn(async () => {
      console.log('  [mock] sendReply → WhatsApp NÃO enviado (mock de teste)');
    }),
    callDeepSeekWithTools: vi.fn(async (messages: any[]) => {
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
      const lastTool = [...messages].reverse().find((m: any) => m.role === 'tool');
      const text = String(lastUser?.content ?? '').toLowerCase();
      if (lastTool) {
        // Ferramenta executada (promoção) — agora responde o texto final
        return {
          role: 'assistant',
          content:
            'Perfeito, anotei tudo! 😊 O Daniel já vai retornar seu contato pra fazer a cotação, pode aguardar que não demora.',
        };
      }
      if (/fam/.test(text)) {
        return {
          role: 'assistant',
          content: 'Entendi! E você quer apenas assistência funeral ou o plano completo com seguro de vida e proteções?',
        };
      }
      if (/completo|seguro de vida/.test(text)) {
        return {
          role: 'assistant',
          content: 'Ótimo, obrigada pelas informações!',
          tool_calls: [
            {
              id: 'call_test_promo_1',
              type: 'function',
              function: {
                name: 'promover_para_qualificado',
                arguments: JSON.stringify({ motivo: 'Teste automatizado: cliente familiar, plano completo com seguro de vida' }),
              },
            },
          ],
        };
      }
      return {
        role: 'assistant',
        content: 'Olá! Tudo bem? 😊 Aqui é a Julia, assistente do corretor Daniel. Antes de tudo: o plano seria individual ou para a família toda?',
      };
    }),
  };
});

import { getCrmDb } from '../../src/crm/schema.js';
import { runColumnAgent } from '../../src/crm/agents/columnAgentRunner.js';
import { sendReply, callDeepSeekWithTools } from '../../src/crm/ai/agent.js';

const TENANT = 'e556f5de-aa9e-493e-9159-0f8e6b915804';
const COL_LEAD = 'crm_col_1ce13c79c3ae';
const COL_QUALIF = 'crm_col_fc844007d108';
const BOARD = 'crm_board_e6579f1b9ba7';
const PHONE = '5500000000000';

describe('Julia (Lead novo) — promoção automática pro Qualificado', () => {
  let contactId: string;
  let cardId: string;

  beforeAll(() => {
    const db = getCrmDb();
    const now = Date.now();
    contactId = `crm_con_test_${now}`;
    cardId = `crm_card_test_${now}`;
    db.prepare(
      'INSERT INTO crm_contacts (id, tenant_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(contactId, TENANT, 'Teste Automatizado Julia', PHONE, now, now);
    db.prepare(
      'INSERT INTO crm_cards (id, tenant_id, board_id, column_id, title, contact_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
    ).run(cardId, TENANT, BOARD, COL_LEAD, '[TESTE] Cliente Julia', contactId, now, now);
    console.log(`\n>>> Card de teste criado: ${cardId} na coluna "Lead novo"\n`);
  });

  it('move o card pra "Qualificado" após o lead responder as 2 perguntas', async () => {
    const db = getCrmDb();
    const channel = {
      id: 'crm_ch_test',
      tenantId: TENANT,
      type: 'evolution',
      name: 'canal-teste',
      status: 'active',
      credentialsEncrypted: '',
      createdAt: Date.now(),
    } as any;

    const carregarCard = () => db.prepare('SELECT * FROM crm_cards WHERE id = ?').get(cardId) as any;
    const carregarColuna = (colId: string) => db.prepare('SELECT * FROM crm_columns WHERE id = ?').get(colId) as any;

    // ── Turno 1: lead chega ──────────────────────────────────────────────
    const card1 = carregarCard();
    const col1 = carregarColuna(card1.column_id);
    const r1 = await runColumnAgent({
      channel,
      card: card1,
      column: col1,
      customerPhone: PHONE,
      text: 'Olá, quero saber sobre os planos',
      messageId: 'msg-test-1',
    });
    console.log('Turno 1 (lead chegou) →', JSON.stringify({ status: r1?.status, reason: r1?.reason ?? r1?.blockReason }));
    expect(r1?.status).toBe('sent');

    // ── Turno 2: responde a 1ª pergunta (familiar) ───────────────────────
    const card2 = carregarCard();
    const col2 = carregarColuna(card2.column_id);
    const r2 = await runColumnAgent({
      channel,
      card: card2,
      column: col2,
      customerPhone: PHONE,
      text: 'É para a minha família toda',
      messageId: 'msg-test-2',
    });
    console.log('Turno 2 (respondeu "família") →', JSON.stringify({ status: r2?.status, reason: r2?.reason ?? r2?.blockReason }));

    // ── Turno 3: responde a 2ª pergunta (plano completo) ─────────────────
    const card3 = carregarCard();
    const col3 = carregarColuna(card3.column_id);
    const r3 = await runColumnAgent({
      channel,
      card: card3,
      column: col3,
      customerPhone: PHONE,
      text: 'Quero o plano completo com seguro de vida',
      messageId: 'msg-test-3',
    });
    console.log('Turno 3 (respondeu "completo") →', JSON.stringify({ status: r3?.status, reason: r3?.reason ?? r3?.blockReason }));

    // ── Verificação final ────────────────────────────────────────────────
    const finalCard = carregarCard();
    const colFinal = carregarColuna(finalCard.column_id);
    console.log(`\n>>> Card ${cardId} está agora na coluna: "${colFinal?.name}" (${finalCard.column_id})`);

    const llmCalls = (callDeepSeekWithTools as any).mock.calls.length;
    const replyCalls = (sendReply as any).mock.calls.length;
    console.log(`>>> Chamadas LLM: ${llmCalls} | Chamadas sendReply: ${replyCalls}`);

    // ASSERT PRINCIPAL: card precisa ter sido promovido pra "Qualificado"
    expect(finalCard.column_id).toBe(COL_QUALIF);
  });

  afterAll(() => {
    const db = getCrmDb();
    db.prepare('DELETE FROM crm_cards WHERE id = ?').run(cardId);
    db.prepare('DELETE FROM crm_contacts WHERE id = ?').run(contactId);
    db.prepare("DELETE FROM crm_activities WHERE card_id = ?").run(cardId);
    console.log('\n>>> Limpeza concluída (card/contato de teste removidos do clone)\n');
  });
});
