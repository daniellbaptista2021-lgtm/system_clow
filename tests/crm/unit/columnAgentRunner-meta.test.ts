/**
 * Regression tests para looksLikeMetaCommentary — o filtro que impede o
 * LLM de mandar "raciocinio interno" como mensagem de WhatsApp pro cliente.
 *
 * Vazamentos catalogados aqui sao os que CHEGARAM ao cliente em prod (e
 * custaram vendas). Se algum desses voltar a passar, e regressao critica.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeMetaCommentary, isReplyEmptyish } from '../../../src/crm/agents/columnAgentRunner.js';

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

describe('looksLikeMetaCommentary — auditoria 2026-05-06 (vazamentos reais 63 cards)', () => {
  // Cada string abaixo VAZOU pro cliente em produção entre 05/05 e 06/05.
  // Adicionados patterns 25-38 pra capturar.
  const vazamentosAuditoriaMaio06 = [
    // Pattern 25 — "Vejo que..."
    'Vejo que eu acabei pulando etapas importantes do fluxo — enviei mensagens automáticas',
    // Pattern 26 — "Pelo que entendi, a/o <Nome>..."
    'Já tem uma cotação salva aqui. A titular é Dejanira (71, FEMININO). Pelo que entendi, a Sandra é quem está falando comigo.',
    // Pattern 27 — "Agora é aguardar"
    'Pronto! Agora é aguardar o retorno dela.',
    // Pattern 28 — "Ele tava na dúvida"
    'Ele tava na dúvida sobre a esposa de 76 anos — vou retomar naturalmente o raciocínio.',
    // Pattern 29 — "Vou retomar naturalmente o raciocínio"
    'Pode ser. Vou retomar naturalmente o raciocínio sobre os netos.',
    // Pattern 30 — cliente fechou/encerrou/indicou/continua/sumiu/parou
    'A cliente já fechou o plano dela, indicou duas pessoas e tá de boa.',
    'Não precisa cobrar — ela já encerrou o assunto dela.',
    'A cliente continua sem responder.',
    'O cliente sumiu depois da cotação.',
    'A cliente parou de responder ontem.',
    // Pattern 31 — "Vou só deixar quieto / ficar quieto / observar"
    'Vou só deixar quieto, sem mensagem.',
    'Vou ficar quieto por aqui.',
    'Vou só observar em silêncio.',
    // Pattern 33 — "Já tem(os) cotação salva aqui"
    'Já temos uma cotação salva aqui. Deixa eu ver os detalhes.',
    'Já tem uma cotação salva aqui.',
    'Já temos os dados salvos.',
    // Pattern 34 — "Agendei pra retomar"
    'Já deixei agendado pra retomar daqui uns dias com ela.',
    'Marquei pra retomar uns dias depois.',
    // Pattern 35 — "Aqui foi anotado"
    'Aqui foi anotado que ela tem 73 anos.',
    'Aqui foi registrado o tipo plano.',
    // Pattern 36 — "Não precisa cobrar/mandar mensagem"
    'Não precisa cobrar — ela já fechou.',
    'Não precisa mandar mensagem agora.',
    // Pattern 37 — "Pronto! Agora é aguardar..."
    'Pronto! Agora é aguardar o retorno dela.',
    'Pronto. Agora vou só esperar.',
    // Pattern 38 — "<Nome> já preencheu/forneceu/indicou os dados"
    'Norma já preencheu os dados no formulário de entrada.',
    'Antônio já indicou os familiares.',
  ];

  it.each(vazamentosAuditoriaMaio06)('bloqueia vazamento maio/06: %s', (msg) => {
    expect(looksLikeMetaCommentary(msg)).toBe(true);
  });

  it('NAO bloqueia respostas legitimas que parecem com os patterns', () => {
    // Falsos positivos a evitar — frases reais de cliente para humano
    expect(looksLikeMetaCommentary('Vejo que você precisa de mais informação')).toBe(false);
    expect(looksLikeMetaCommentary('Pelo que entendi, você quer cobrir 4 pessoas')).toBe(false);
    expect(looksLikeMetaCommentary('Aqui foi feito tudo certinho')).toBe(false);
    expect(looksLikeMetaCommentary('Já tem uma sugestao pra você ver')).toBe(false);
    expect(looksLikeMetaCommentary('A indenização é em caso de acidente')).toBe(false);
    expect(looksLikeMetaCommentary('Não precisa se preocupar com nada')).toBe(false);
  });
});

describe('looksLikeMetaCommentary — vazamento Jademar 2026-05-06 (pos-deploy)', () => {
  // Caso real card crm_card_1c93ed7c749b 2026-05-06 20:16:00
  // VAZOU pos-deploy do output validator. Frase tem 3 elementos meta:
  // "Deixei registrado", "Se o <Nome> voltar a falar", "eu retomo daqui"
  it('bloqueia o vazamento exato do Jademar', () => {
    const msg = 'Deixei registrado. Se o Jademar voltar a falar, eu retomo daqui mesmo 😊';
    expect(looksLikeMetaCommentary(msg)).toBe(true);
  });

  // Pattern 39 — "Deixei registrado" abertura
  it('bloqueia "Deixei registrado." sozinho', () => {
    expect(looksLikeMetaCommentary('Deixei registrado.')).toBe(true);
  });
  it('bloqueia "Deixei anotado aqui."', () => {
    expect(looksLikeMetaCommentary('Deixei anotado aqui.')).toBe(true);
  });
  it('bloqueia "Já deixei registrado para acompanhar"', () => {
    expect(looksLikeMetaCommentary('Já deixei registrado para acompanhar')).toBe(true);
  });

  // Pattern 40 — "Se o/a <Nome> voltar a falar/escrever/etc"
  it('bloqueia "Se o Jademar voltar a falar"', () => {
    expect(looksLikeMetaCommentary('Se o Jademar voltar a falar, eu retomo')).toBe(true);
  });
  it('bloqueia "Se a Maria voltar a escrever"', () => {
    expect(looksLikeMetaCommentary('Se a Maria voltar a escrever, retomo')).toBe(true);
  });
  it('bloqueia "Se o Antônio retornar"', () => {
    expect(looksLikeMetaCommentary('Se o Antônio retornar, eu sigo daqui')).toBe(true);
  });

  // Pattern 41 — "eu retomo/continuo daqui"
  it('bloqueia "eu retomo daqui mesmo"', () => {
    expect(looksLikeMetaCommentary('Vou aguardar e eu retomo daqui mesmo')).toBe(true);
  });
  it('bloqueia "eu continuo daqui"', () => {
    expect(looksLikeMetaCommentary('Beleza! eu continuo daqui')).toBe(true);
  });

  // Pattern 42 — "Quando ele/ela voltar/responder"
  it('bloqueia "Quando ele voltar, eu chamo"', () => {
    expect(looksLikeMetaCommentary('Quando ele voltar, eu chamo de novo')).toBe(true);
  });
  it('bloqueia "Quando o Jademar responder, retomo"', () => {
    expect(looksLikeMetaCommentary('Quando o Jademar responder, retomo')).toBe(true);
  });

  // Pattern 43 — "Se ela responder depois"
  it('bloqueia "Se ela responder depois, eu reabro"', () => {
    expect(looksLikeMetaCommentary('Se ela responder depois, eu reabro')).toBe(true);
  });

  // Falsos positivos a evitar
  it('NÃO bloqueia "Deixei registrado, Lourdes" (vocativo, não meta)', () => {
    // "Deixei registrado, Lourdes" — fala COM Lourdes, não SOBRE.
    // Pattern 39 exige (se|que|o|a|aqui|isso|tudo|para) após "registrado"
    expect(looksLikeMetaCommentary('Deixei registrado, Lourdes! Já te passo pra cima.')).toBe(false);
  });
  it('NÃO bloqueia "se você voltar a falar" (segunda pessoa)', () => {
    expect(looksLikeMetaCommentary('Se você voltar a falar é só me chamar')).toBe(false);
  });
  it('NÃO bloqueia "Quando você responder eu volto" (segunda pessoa)', () => {
    expect(looksLikeMetaCommentary('Quando você responder eu volto')).toBe(false);
  });
});

describe('Patterns 44-49 — incidente Follow Up 2026-05-06', () => {
  it('bloqueia "Tag já estava aplicada. Vou seguir." (caso Sil)', () => {
    expect(looksLikeMetaCommentary('Tag já estava aplicada. Vou seguir.')).toBe(true);
  });

  it('bloqueia "Tag já estava aplicada. Vou seguir com a mensagem do step 1, adaptada ao histórico dela." (caso Helga)', () => {
    expect(
      looksLikeMetaCommentary(
        'Tag já estava aplicada. Vou seguir com a mensagem do step 1, adaptada ao histórico dela.\n\nOi Helma!'
      )
    ).toBe(true);
  });

  it('bloqueia "Hmm, a tag já existia. Vou seguir com a mensagem mesmo assim." (caso Hércules)', () => {
    expect(
      looksLikeMetaCommentary(
        'Hmm, a tag já existia. Vou seguir com a mensagem mesmo assim.\n\nOi Hércules!'
      )
    ).toBe(true);
  });

  it('bloqueia "vou seguir com a mensagem do step 2"', () => {
    expect(looksLikeMetaCommentary('Vou seguir com a mensagem do step 2 do follow-up')).toBe(true);
  });

  it('bloqueia "step 1 do roteiro"', () => {
    expect(looksLikeMetaCommentary('Vou disparar o step 1 do roteiro pra ela.')).toBe(true);
  });

  it('bloqueia "adaptada ao histórico dela"', () => {
    expect(looksLikeMetaCommentary('mensagem adaptada ao histórico dela')).toBe(true);
  });

  it('bloqueia "Hmm, a tag já existia"', () => {
    expect(looksLikeMetaCommentary('Hmm, a tag já existia, sem problema.')).toBe(true);
  });

  it('NÃO bloqueia "Hmm, posso te ajudar com isso!" (hesitação humana real)', () => {
    // Pattern 48 só bate quando "hmm" é seguido de meta-marker (a/o/já/tag/status/etc)
    expect(looksLikeMetaCommentary('Hmm, posso te ajudar com isso!')).toBe(false);
  });

  it('NÃO bloqueia "vou seguir as orientações do médico" (uso natural de "vou seguir")', () => {
    expect(looksLikeMetaCommentary('Vou seguir as orientações do médico')).toBe(false);
  });
});

describe('isReplyEmptyish — barra texto inutilizavel', () => {
  it('detecta string vazia', () => {
    expect(isReplyEmptyish('')).toBe(true);
  });

  it('detecta apenas aspas duplas (caso real Val Mulher de Fibra)', () => {
    expect(isReplyEmptyish('""')).toBe(true);
  });

  it('detecta aspas simples', () => {
    expect(isReplyEmptyish("''")).toBe(true);
  });

  it('detecta apenas espacos / pontuacao', () => {
    expect(isReplyEmptyish('   ')).toBe(true);
    expect(isReplyEmptyish('...')).toBe(true);
    expect(isReplyEmptyish('!!')).toBe(true);
    expect(isReplyEmptyish('. . .')).toBe(true);
  });

  it('detecta emoji solto (caso real Graça Pires "😄")', () => {
    expect(isReplyEmptyish('😄')).toBe(true);
    expect(isReplyEmptyish('🙏')).toBe(true);
    expect(isReplyEmptyish('😊')).toBe(true);
  });

  it('NAO bloqueia respostas reais minimas', () => {
    expect(isReplyEmptyish('Oi')).toBe(false);
    expect(isReplyEmptyish('Ok')).toBe(false);
    expect(isReplyEmptyish('Já')).toBe(false);
    expect(isReplyEmptyish('Não')).toBe(false);
    expect(isReplyEmptyish('Beleza')).toBe(false);
    expect(isReplyEmptyish('Oi 😊')).toBe(false);
    expect(isReplyEmptyish('Pode ser!')).toBe(false);
  });
});
