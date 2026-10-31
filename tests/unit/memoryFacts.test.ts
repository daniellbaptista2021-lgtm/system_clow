import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  apagarFato,
  fatosParaPrompt,
  listarFatos,
  pareceSegredo,
  salvarFato,
} from '../../src/memory/MemoryFacts.js';
import { closeAllMemoryDbs } from '../../src/memory/MemoryDatabase.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'evox-memory-facts-'));
  process.env.CLOW_HOME = home;
});

afterEach(() => {
  closeAllMemoryDbs();
  delete process.env.CLOW_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('memória permanente por conta', () => {
  it('grava, atualiza e apaga um fato sem duplicar o título', () => {
    const primeiro = salvarFato('corretora-a', 'preferencia', 'Dia de cobrança', 'Todo dia 10.');
    expect(primeiro.atualizado).toBe(false);

    const segundo = salvarFato('corretora-a', 'preferencia', 'Dia de cobrança', 'Todo dia 12, por Pix.');
    expect(segundo.atualizado).toBe(true);
    expect(listarFatos('corretora-a')).toHaveLength(1);
    expect(listarFatos('corretora-a')[0].conteudo).toBe('Todo dia 12, por Pix.');

    expect(apagarFato('corretora-a', 'Dia de cobrança')).toBe(true);
    expect(listarFatos('corretora-a')).toEqual([]);
  });

  it('não mistura a memória de duas contas', () => {
    salvarFato('corretora-a', 'perfil', 'Nome', 'Ana Corretora');
    salvarFato('corretora-b', 'perfil', 'Nome', 'Bruno Corretor');

    expect(fatosParaPrompt('corretora-a')).toContain('Ana Corretora');
    expect(fatosParaPrompt('corretora-a')).not.toContain('Bruno Corretor');
    expect(fatosParaPrompt('corretora-b')).toContain('Bruno Corretor');
  });

  it('recusa senha, token e chave', () => {
    expect(pareceSegredo('senha: segredo123')).toBe(true);
    expect(() => salvarFato('corretora-a', 'conexao', 'Acesso', 'token: abcdefghijklmnop')).toThrow('memoria_segredo');
  });
});
