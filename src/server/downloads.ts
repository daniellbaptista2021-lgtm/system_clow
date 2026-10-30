/** Regras do endereço /downloads (a rota mora em server.ts). */

export function isSafeDownloadName(requested: string): boolean {
  if (!requested || requested.includes('/') || requested.includes('\\')) return false;
  if (requested === '.' || requested === '..') return false;
  return !/[\x00-\x1f]/.test(requested);
}

/** /downloads/<código>/<arquivo>: o código (32 hex, aleatório) é a chave.
 *  Arquivo solto na raiz não é servido — seria de qualquer um que adivinhasse
 *  o nome. CLOW_DOWNLOADS_LEGADO=1 reabre a raiz, só para migrar links velhos. */
export function caminhoDeDownload(pedido: string): string | null {
  const partes = pedido.split('/');
  if (partes.length === 2 && /^[a-f0-9]{32}$/.test(partes[0]) && isSafeDownloadName(partes[1])) return `${partes[0]}/${partes[1]}`;
  if (partes.length === 1 && process.env.CLOW_DOWNLOADS_LEGADO === '1' && isSafeDownloadName(partes[0])) return partes[0];
  return null;
}
