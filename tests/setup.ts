/**
 * setup.ts — baseline de ambiente pra suite de testes.
 *
 * Roda antes de cada arquivo de teste (vitest.config.ts -> setupFiles).
 *
 * Por que existe: `modoBonus()` (src/tenancy/modoBonus.ts) tem padrao LIGADO —
 * de proposito, pra que um deploy novo nasca sem cobranca. Mas a suite de
 * billing (cota, excedente, suspensao de tenant) so faz sentido no modo
 * assinatura; sem essa variavel ela roda com a cota desligada e falha em massa
 * (`expected Infinity to be 499`, `expected 200 to be 403`).
 *
 * Cada valor so e aplicado se o ambiente ja nao tiver definido o seu, pra que
 * CI e execucoes pontuais possam sobrescrever sem editar este arquivo.
 */

/** Seta a variavel apenas quando ela ainda nao veio do ambiente. */
function padrao(nome: string, valor: string): void {
  if (process.env[nome] === undefined || process.env[nome] === '') {
    process.env[nome] = valor;
  }
}

// Modo assinatura: licenca, Stripe e cotas ativos (ver modoBonus.ts).
padrao('CLOW_MODO_BONUS', 'false');
