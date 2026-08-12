/**
 * modoBonus.ts — o System Clow como bonus, sem assinatura.
 *
 * Decisao do Daniel (10/08/2026): o System Clow deixou de ser um SaaS cobrado
 * a parte e virou um bonus dentro do Territorio Proprio. Quem entra ja pagou
 * pelo Territorio; cobrar de novo aqui nao faz sentido. E como a IA agora roda
 * na chave do proprio cliente (ver aiCredentials.ts), o custo por mensagem que
 * justificava cota tambem deixou de ser nosso.
 *
 * **Desligado por configuracao, nao arrancado.** O codigo de licenca, Stripe,
 * trial e cota continua inteiro e testado: se um dia o System Clow voltar a
 * ser vendido sozinho, e uma variavel de ambiente, nao uma reconstrucao.
 * Arrancar seria a decisao dificil de desfazer — e essa nao e uma decisao que
 * precise ser dificil.
 *
 * O padrao e LIGADO (`true`). Quem quiser voltar a cobrar poe
 * `CLOW_MODO_BONUS=false` no ambiente. O padrao ser o modo bonus e proposital:
 * o deploy novo tem de nascer sem cobranca, sem depender de alguem lembrar de
 * setar variavel — esquecer produziria uma tela de "assine para continuar" na
 * cara de um aluno que ja pagou.
 */

/**
 * True quando o produto roda como bonus (sem licenca, sem cobranca, sem cota).
 *
 * Lido a cada chamada, e nao guardado numa constante de modulo, pra que os
 * testes possam alternar o valor sem recarregar o modulo.
 */
export function modoBonus(): boolean {
  const v = (process.env.CLOW_MODO_BONUS ?? '').trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'nao' || v === 'não') return false;
  return true;
}

/** Texto unico pra logs, pra ficar obvio no boot em que modo o servidor subiu. */
export function descricaoDoModo(): string {
  return modoBonus()
    ? 'bônus (sem assinatura, IA na chave do cliente)'
    : 'assinatura (licença, Stripe e cotas ativos)';
}
