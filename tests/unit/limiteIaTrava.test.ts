import { describe, it, expect, beforeAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Limite de IA atingido trava toda a automação (pedido do Daniel, 30/10/2026).
// Banco temporário e chave central ligada, só para este teste.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evox-limite-'));
process.env.CRM_DB_PATH = path.join(dir, 'crm.sqlite3');
process.env.EVOX_IA_KEY = 'teste';
process.env.EVOX_DOLAR_BRL = '5';

let uso: typeof import('../../src/tenancy/usoIa.js');
beforeAll(async () => {
  uso = await import('../../src/tenancy/usoIa.js');
});

describe('trava da IA no limite do mês', () => {
  it('conta nova não está travada', () => {
    expect(uso.limiteAtingido('corretora-a')).toBe(false);
  });

  it('gastou os R$ 80 do Essencial: trava', () => {
    // 20 milhões de tokens de saída a US$ 1,20/M = US$ 24 = R$ 120 (passa dos R$ 80)
    uso.registrarUso('corretora-a', { inputTokens: 0, outputTokens: 20_000_000 });
    expect(uso.limiteAtingido('corretora-a')).toBe(true);
    expect(() => uso.conferirLimite('corretora-a')).toThrow(uso.LimiteIaAtingido);
  });

  it('recarga paga destrava (85% do valor vira crédito)', () => {
    uso.adicionarCredito('corretora-a', uso.creditoDaRecarga(100), 'teste'); // R$ 85 → limite R$ 165
    expect(uso.limiteAtingido('corretora-a')).toBe(false);
  });

  it('uma conta travada não trava a outra', () => {
    expect(uso.limiteAtingido('corretora-b')).toBe(false);
  });
});
