/**
 * Regression tests para looksLikeMetaCommentary — o filtro que impede o
 * LLM de mandar "raciocinio interno" como mensagem de WhatsApp pro cliente.
 *
 * Vazamentos catalogados aqui sao os que CHEGARAM ao cliente em prod (e
 * custaram vendas). Se algum desses voltar a passar, e regressao critica.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeMetaCommentary } from '../../../src/crm/agents/columnAgentRunner.js';

describe('looksLikeMetaCommentary — vazamentos historicos (DEVEM bloquear)', () => {
  // Screenshot 2026-04-30 — cliente Tania (5521984574332)
  const vazamentosTania2026_04_30 = [
    'Deixa eu avaliar o contexto: A cliente (Tania) pediu informações sobre plano de saúde/assistência médica',
    '- A cliente (Tania) pediu informações sobre plano de saúde/assistência médica',
    '- Eu perguntei se seriam 4 pessoas no funeral e ela não respondeu ainda',
    '- Acabou de ficar inativa (0 minutos) — na verdade foi bem recente',
    'Vou mandar uma cobrança gentil já que a última pergunta ficou no ar e ela demonstrou interesse real.',
    'Marquei como morno com follow-up automático em 2 dias. Se ela responder até lá, volto a atender. Caso contrário, o sistema dispara o follow-up. 😎',
    'Tania, tudo bem? 😉 Só pra não perder o fio da meada — você comentou sobre plano de saúde também, e eu já vou acionar o corretor especialista pra te ajudar com isso.',
  ];

  it.each(vazamentosTania2026_04_30)('bloqueia vazamento Tania: %s', (msg) => {
    expect(looksLikeMetaCommentary(msg)).toBe(true);
  });

  // Vazamentos historicos (commit 191100f) — devem continuar bloqueando.
  const vazamentosAnteriores = [
    'Cliente qualificado, respondeu Ok. Marquei como morno...',
    'O cliente parece interessado, vou aguardar resposta.',
    'Composição familiar completa pra montar proposta personalizada.',
    'Ainda é cedo pra escalar.',
    'Anotei como qualificado.',
    'Classifiquei o cliente como quente.',
    'Lead qualificado para próximo passo.',
    'Encaminhei pro corretor humano.',
  ];

  it.each(vazamentosAnteriores)('bloqueia vazamento anterior: %s', (msg) => {
    expect(looksLikeMetaCommentary(msg)).toBe(true);
  });
});

describe('looksLikeMetaCommentary — mensagens reais ao cliente (NAO devem bloquear)', () => {
  // Mensagens legitimas que o agente DEVE conseguir mandar pro cliente.
  // Falsos positivos aqui = atendimento quebrado.
  const mensagensReais = [
    'Olá Tania! Tudo bem? Vi que você se interessou pelo Seguro Funeral.',
    'Boa tarde! Posso te ajudar com a proposta?',
    'Pode me confirmar quantas pessoas seriam no plano?',
    'Te mando agora a cotacao no valor de R$120/mes.',
    'Vou enviar a proposta no seu email, pode ser?',
    'Obrigado pela confianca! Em breve nossa equipe entra em contato.',
    'Voce prefere falar agora ou marco uma ligacao pra depois?',
    'Pode ser amanha as 14h?',
    'Acabei de receber sua mensagem, ja te respondo.',  // "acabei de receber" - nao "acabei de mandar"
    'Tem alguma duvida sobre os valores?',
    'Vou te passar mais detalhes em alguns minutos.',
    'O plano cobre voce e sua familia.',
    'A cobertura inclui assistencia 24h.',
  ];

  it.each(mensagensReais)('passa mensagem real: %s', (msg) => {
    expect(looksLikeMetaCommentary(msg)).toBe(false);
  });
});

describe('looksLikeMetaCommentary — bug ortografico do regex pt-BR (regressao)', () => {
  // O bug original era: regex tinha (marc|...)(quei) que so casa "marcquei"
  // (palavra que nao existe). A forma correta em portugues e marquei
  // (marqu+ei). Esse teste e o canario.
  it('bloqueia "Marquei como morno" (1a pessoa singular passado)', () => {
    expect(looksLikeMetaCommentary('Marquei como morno')).toBe(true);
  });

  it('bloqueia "Classifiquei como qualificado"', () => {
    expect(looksLikeMetaCommentary('Classifiquei como qualificado')).toBe(true);
  });

  it('bloqueia variacoes plurais e formais', () => {
    expect(looksLikeMetaCommentary('Marcamos como frio')).toBe(true);
    expect(looksLikeMetaCommentary('Marcou como perdido')).toBe(true);
    expect(looksLikeMetaCommentary('Anotei como interessado')).toBe(true);
    expect(looksLikeMetaCommentary('Sinalizei como quente')).toBe(true);
    expect(looksLikeMetaCommentary('Defini como qualificado')).toBe(true);
  });

  it('bloqueia com texto entre verbo e label (ate 30 chars)', () => {
    expect(looksLikeMetaCommentary('Marquei como morno com follow-up automatico em 2 dias')).toBe(true);
    expect(looksLikeMetaCommentary('Anotei o cliente como interessado no plano premium')).toBe(true);
  });
});

describe('looksLikeMetaCommentary — vazamento Safira/PV chase 2026-05-01', () => {
  // Caso real: agente "Safira" mandou pra cliente o raciocinio interno
  // "Cliente nao respondeu nada ainda — so a saudacao inicial que eu
  // mandei. Vou fazer a 1a cobranca gentil." Tres elementos meta:
  // (a) estado do cliente em 3a pessoa, (b) narrativa da propria msg, e
  // (c) anuncio do que vai fazer. Cada um deve cair em pelo menos um regex.
  const vazamentoSafira = [
    'Cliente não respondeu nada ainda — só a saudação inicial que eu mandei. Vou fazer a 1ª cobrança gentil.',
    'Cliente ainda não respondeu, vou aguardar.',
    'Cliente nao escreveu nada, vou tentar de novo.',
    'Só a saudação inicial que eu mandei até agora.',
    'Vou fazer a 1ª cobrança gentil agora.',
    'Vou disparar a 2ª tentativa.',
    'Vou tentar uma 3ª abordagem.',
    'Minha última mensagem ficou sem resposta.',
    'Primeira cobrança enviada, esperando resposta.',
    'Última tentativa antes de marcar perdido.',
  ];

  it.each(vazamentoSafira)('bloqueia: %s', (msg) => {
    expect(looksLikeMetaCommentary(msg)).toBe(true);
  });

  it('NAO bloqueia mensagens reais proximas dos novos patterns', () => {
    // Falsos positivos catastrofes — agente nao consegue mais saudar
    // ou enviar cotacao se essas baterem.
    expect(looksLikeMetaCommentary('Bom dia! Tudo bem? Sou a Safira da PV Corretora.')).toBe(false);
    expect(looksLikeMetaCommentary('Me conta seu nome pra eu te ajudar direitinho?')).toBe(false);
    expect(looksLikeMetaCommentary('Pra eu te passar o valor exato, preciso de alguns detalhes.')).toBe(false);
    expect(looksLikeMetaCommentary('Quem vai fazer parte do plano com você?')).toBe(false);
    expect(looksLikeMetaCommentary('A cobrança é mensal, no boleto ou cartão.')).toBe(false);
    expect(looksLikeMetaCommentary('Você pode escolher entre cobrança mensal ou anual.')).toBe(false);
    expect(looksLikeMetaCommentary('A primeira parcela vence em 30 dias.')).toBe(false);
  });
});

describe('looksLikeMetaCommentary — vazamento de identidade de role (Maria Cecilia 2026-04-30)', () => {
  // Caso real: cliente Maria Cecilia Goncalves recebeu "Oi! Boa noite 😉
  // Prazer, sou a qualificadora, da PV Corretora!" — agente vazou o role
  // (qualificador) como se fosse profissao. Cliente NUNCA pode ouvir o
  // termo tecnico interno.
  const vazamentosIdentidade = [
    'Oi! Boa noite 😉 Prazer, sou a qualificadora, da PV Corretora!',
    'Sou a qualificadora da PV Corretora.',
    'Prazer, sou o qualificador!',
    'Oi, sou a cotadora.',
    'Sou o cotador SulAmerica.',
    'Oi, sou a vendedora bot.',
    'Aqui é a coletora de dados.',
    'Sou o followupper.',
    'Eu sou o closer da equipe.',
    'Oi, me chamo qualificadora!',
    'Aqui é a educadora.',
    'Sou a finalizadora!',
    // Auto-identificacao como bot/IA
    'Oi, sou o bot da PV.',
    'Sou a IA que cuida dos atendimentos.',
    'Sou um assistente virtual.',
    'Sou o agente automatico.',
    'Sou a inteligencia artificial.',
  ];

  it.each(vazamentosIdentidade)('bloqueia: %s', (msg) => {
    expect(looksLikeMetaCommentary(msg)).toBe(true);
  });

  it('NAO bloqueia mensagens reais com nome de pessoa', () => {
    // Frases que mencionam um nome real NAO devem cair no bloqueio.
    expect(looksLikeMetaCommentary('Oi! Sou a Safira da PV Corretora')).toBe(false);
    expect(looksLikeMetaCommentary('Prazer, sou a Ana da PV Corretora')).toBe(false);
    expect(looksLikeMetaCommentary('Aqui e o Lucas, da SulAmerica')).toBe(false);
    expect(looksLikeMetaCommentary('Me chamo Marina, sou da PV Corretora')).toBe(false);
  });
});
