/**
 * Datas de relacionamento: datas móveis, casamento de profissão e janela
 * de eventos. Datas de referência conferidas no calendário de 2026/2027.
 */
import { describe, it, expect } from 'vitest';
import { enesimoDomingo, pascoa, profissaoDo, eventosEntre, preencher, hojeBrasilia, biblioteca } from '../../src/crm/datas/calendario.js';

describe('datas móveis', () => {
  it('Dia das Mães e dos Pais = 2º domingo de maio e de agosto', () => {
    expect(enesimoDomingo(2026, 5, 2)).toBe('2026-05-10');
    expect(enesimoDomingo(2026, 8, 2)).toBe('2026-08-09');
    expect(enesimoDomingo(2027, 5, 2)).toBe('2027-05-09');
  });
  it('Páscoa', () => {
    expect(pascoa(2026)).toBe('2026-04-05');
    expect(pascoa(2027)).toBe('2027-03-28');
  });
});

describe('profissão do cliente', () => {
  it.each([
    ['Médica', 'medico'], ['médico cardiologista', 'medico'], ['Biomédico', 'biomedico'],
    ['Advogada', 'advogado'], ['Corretora de imóveis', 'corretor-imoveis'], ['Gerente comercial', 'vendedor'],
    ['Professora de educação física', 'educador-fisico'], ['Engenheira civil', 'engenheiro'], ['Dentista', 'dentista'],
  ])('%s → %s', (titulo, chave) => {
    expect(profissaoDo(titulo)?.chave).toBe(chave);
  });
  it('profissão desconhecida não casa com nada', () => {
    expect(profissaoDo('Astronauta')).toBeNull();
    expect(profissaoDo('')).toBeNull();
  });
});

describe('eventos', () => {
  const contatos = [
    { id: 'a', nome: 'Ana Souza', telefone: '11999990000', nascimento: '1985-10-20', profissao: 'Médica' },
    { id: 'b', nome: 'Beto', nascimento: '1990-01-02', profissao: 'Advogado' },
  ];
  const apolices = [{ id: 'p1', contatoId: 'a', nome: 'Vida Inteira', inicio: '2023-10-19' }];

  it('janela de 7 dias a partir de 18/10 pega dia do médico, apólice e aniversário', () => {
    const ev = eventosEntre('2026-10-18', 7, contatos, apolices);
    const t = ev.map((e) => `${e.data} ${e.tipo} ${e.titulo}`);
    expect(t).toContain('2026-10-18 profissao Dia do Médico');
    expect(t).toContain('2026-10-19 apolice Apólice de Ana Souza');
    expect(t).toContain('2026-10-20 aniversario Aniversário de Ana Souza');
    const medico = ev.find((e) => e.titulo === 'Dia do Médico')!;
    expect(medico.contatos.map((c) => c.id)).toEqual(['a']);
    expect(ev.find((e) => e.tipo === 'apolice')!.descricao).toContain('3 anos');
    expect(ev.find((e) => e.tipo === 'aniversario')!.anos).toBe(41);
  });

  it('janela que atravessa o ano pega aniversário de janeiro do ano seguinte', () => {
    const ev = eventosEntre('2026-12-28', 10, contatos, []);
    expect(ev.some((e) => e.tipo === 'aniversario' && e.data === '2027-01-02')).toBe(true);
    expect(ev.some((e) => e.titulo === 'Ano Novo' && e.data === '2027-01-01')).toBe(true);
  });

  it('apólice no ano em que começou não gera aniversário', () => {
    const ev = eventosEntre('2023-10-01', 30, contatos, apolices);
    expect(ev.some((e) => e.tipo === 'apolice')).toBe(false);
  });

  it('ordem: por data', () => {
    const ev = eventosEntre('2026-01-01', 365, contatos, apolices);
    const datas = ev.map((e) => e.data);
    expect([...datas].sort()).toEqual(datas);
  });
});

describe('mensagens', () => {
  it('preenche nome e corretor', () => {
    expect(preencher('Oi, {nome}! Abraço, {corretor}.', { nome: 'Ana', corretor: 'Bruno' })).toBe('Oi, Ana! Abraço, Bruno.');
  });
  it('sem corretor no perfil, a assinatura some em vez de sair "{corretor}"', () => {
    expect(preencher('Oi, {nome}! Um abraço, {corretor}.', { nome: 'Ana' })).toBe('Oi, Ana! Um abraço');
    expect(preencher('Parabéns! — {corretor}', { nome: 'Ana' })).toBe('Parabéns!');
  });
  it('hoje é calculado em Brasília', () => {
    // 02:30 UTC de 11/10 ainda é 23:30 do dia 10 em Brasília.
    expect(hojeBrasilia(new Date('2026-10-11T02:30:00Z'))).toBe('2026-10-10');
  });
  it('biblioteca tem as datas do ano e nenhuma mensagem vazia', () => {
    const b = biblioteca(2026);
    expect(b.find((x) => x.chave === 'dia-maes')!.data).toBe('2026-05-10');
    expect(b.every((x) => x.mensagens.length && x.mensagens.every((m) => m.length > 20))).toBe(true);
  });
});
