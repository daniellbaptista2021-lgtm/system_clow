import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { nomeDoSlot, caminhoNoSlot, comandoNoSlot, slotsDisponiveis } from '../../src/tenancy/slotConta.js';

// Cada conta do EVOX roda o terminal do Agente IA no slot dela (uma maquina
// separada). O que estes testes protegem: o comando nunca escapa para o
// servidor, e sem slot o terminal fica desligado em vez de rodar no host.

const RAIZ = path.resolve(__dirname, '../..');

describe('slot de cada conta', () => {
  const antes = process.env.EVOX_SLOTS;
  afterEach(() => { process.env.EVOX_SLOTS = antes; });

  it('sem EVOX_SLOTS=container nao ha slot', () => {
    delete process.env.EVOX_SLOTS;
    expect(slotsDisponiveis()).toBe(false);
  });

  it('nome do slot so tem letras e numeros da conta', () => {
    expect(nomeDoSlot('E556F5DE-aa9e;rm -rf /')).toBe('evox-e556f5deaa9erm');
    expect(() => nomeDoSlot(';;;')).toThrow();
  });

  it('pasta fora da conta cai na raiz do slot', () => {
    expect(caminhoNoSlot('/c/x/sub/a', '/c/x')).toBe('/workspace/sub/a');
    expect(caminhoNoSlot('/etc', '/c/x')).toBe('/workspace');
  });

  it('o comando inteiro vai entre aspas para dentro do slot', () => {
    const linha = comandoNoSlot('evox-a', "echo 'oi'; rm -rf /", '/workspace');
    expect(linha).toMatch(/ exec -w '\/workspace' 'evox-a' bash -lc 'echo '\\''oi'\\''; rm -rf \/'$/);
  });

  it('conta comum sem slot nao roda nada no servidor', () => {
    const bash = fs.readFileSync(path.join(RAIZ, 'src/tools/BashTool/BashTool.ts'), 'utf8');
    expect(bash).toMatch(/noSlot && !slotsDisponiveis\(\)/);
    expect(bash).toMatch(/if \(noSlot\) return rodarNoSlot\(/);
  });
});
