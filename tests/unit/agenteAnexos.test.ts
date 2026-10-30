import { describe, it, expect } from 'vitest';
import { nomeSeguro } from '../../src/server/routes/agenteAnexos.js';

// O nome do anexo vira arquivo na pasta da conta: não pode subir de pasta
// nem carregar caracteres que quebrem o comando que o agente vai rodar.
describe('nome do anexo do agente', () => {
  it('tira pastas e acentos e mantém a extensão', () => {
    expect(nomeSeguro('../../etc/passwd')).toBe('passwd');
    expect(nomeSeguro('Cotação Família Andrade.PDF')).toBe('Cotacao-Familia-Andrade.pdf');
  });
  it('troca o que é estranho por hífen e nunca fica vazio', () => {
    expect(nomeSeguro('a; rm -rf $(x).png')).toBe('a-rm-rf-x.png');
    expect(nomeSeguro('')).toBe('arquivo');
  });
});
