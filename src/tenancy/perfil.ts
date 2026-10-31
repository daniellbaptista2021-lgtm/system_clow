/** Normaliza o nome público exibido no CRM sem aceitar controles invisíveis. */
export function normalizarNomePerfil(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const nome = valor.replace(/\s+/g, ' ').trim();
  if (nome.length < 3 || nome.length > 80) return null;
  if (/[\u0000-\u001F\u007F]/.test(nome)) return null;
  return nome;
}
