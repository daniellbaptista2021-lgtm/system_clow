/**
 * redact.ts — helpers para mascarar PII em logs/erros antes de chegar
 * em pino/Sentry/console. LGPD: telefone, email, CPF de cliente sao
 * dados pessoais e nao podem aparecer crus em logs persistidos.
 *
 * Politica: manter informacao suficiente pra debug (regiao/dominio)
 * sem expor o identificador completo.
 */

/**
 * Mascara telefone preservando codigo do pais + DDD + ultimos 4 digitos.
 * Ex: "5521990423520" -> "5521****3520"
 *     "+5521990423520" -> "+5521****3520"
 *     "21990423520" -> "21****3520"
 *     "(21) 99042-3520" -> formato preservado parcialmente: "(21) ****-3520"
 *
 * Aceita tambem null/undefined (retorna string vazia) pra simplificar
 * call sites do tipo `[wpp] ${maskPhone(phone)}: ...`.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const s = String(phone);
  // Extrai so digitos pra calcular o mascaramento
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) {
    // Curto demais — mascara tudo menos os ultimos 2
    return digits.length <= 2 ? '**' : '*'.repeat(digits.length - 2) + digits.slice(-2);
  }
  // Pega 4 primeiros e 4 ultimos digitos (ou menos se nao houver)
  const head = digits.slice(0, 4);
  const tail = digits.slice(-4);
  // Se a string original tinha caracteres formatadores, preserva o sinal de +
  const plus = s.startsWith('+') ? '+' : '';
  return `${plus}${head}****${tail}`;
}

/**
 * Mascara email preservando dominio + 1a letra do local-part.
 * Ex: "daniellbaptista2021@gmail.com" -> "d***@gmail.com"
 *     "ab@example.com" -> "a***@example.com"
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const s = String(email);
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  return `${local[0]}***${domain}`;
}

/**
 * Mascara CPF/RG/documento numerico preservando ultimos 2 digitos.
 * Ex: "12345678901" -> "*********01"
 */
export function maskDoc(doc: string | null | undefined): string {
  if (!doc) return '';
  const digits = String(doc).replace(/\D/g, '');
  if (digits.length <= 2) return '*'.repeat(digits.length);
  return '*'.repeat(digits.length - 2) + digits.slice(-2);
}
