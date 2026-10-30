/** Downloads: só abre com o código aleatório na frente do nome. */
import { describe, it, expect, afterEach } from 'vitest';

describe('rota /downloads', async () => {
  const { caminhoDeDownload } = await import('../src/server/downloads.js');
  afterEach(() => { delete process.env.CLOW_DOWNLOADS_LEGADO; });
  it('aceita código + nome; recusa nome solto, código curto e ../', () => {
    const cod = 'a'.repeat(32);
    expect(caminhoDeDownload(`${cod}/planilha.xlsx`)).toBe(`${cod}/planilha.xlsx`);
    expect(caminhoDeDownload('planilha.xlsx')).toBeNull();
    expect(caminhoDeDownload('abc/planilha.xlsx')).toBeNull();
    expect(caminhoDeDownload(`${cod}/../x`)).toBeNull();
    expect(caminhoDeDownload(`../${cod}/x`)).toBeNull();
    process.env.CLOW_DOWNLOADS_LEGADO = '1';
    expect(caminhoDeDownload('planilha.xlsx')).toBe('planilha.xlsx');
  });
});
