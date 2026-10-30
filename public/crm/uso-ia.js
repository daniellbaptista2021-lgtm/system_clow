/**
 * Uso da IA — o cartão de Configurações do EVOX.
 *
 * A IA é do EVOX, com um limite de uso por mês em cada plano. O cliente vê só
 * a barra (porcentagem), como no plano Pro do Claude, nunca o valor em reais.
 * Quando precisar de mais, escolhe um pacote e libera mais uso.
 */
(function () {
  'use strict';

  function chave() {
    return window.clowStorage.getItem('clow_crm_key') || window.clowStorage.getItem('clow_token') || '';
  }
  async function api(caminho, opcoes = {}) {
    const r = await fetch('/v1/agente' + caminho, {
      ...opcoes,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + chave() },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || 'http_' + r.status);
    return d;
  }
  function dataBr(iso) {
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  }
  function moeda(v) {
    return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function montar(destino, deps) {
    const el = deps.el;
    const toast = deps.toast || (() => {});
    const cartao = el('div', { class: 'uso-ia-cartao' });
    destino.append(cartao);
    cartao.append(el('div', { class: 'uso-ia-sub' }, 'Carregando…'));
    let u;
    try { u = await api('/uso'); } catch (e) { cartao.innerHTML = ''; cartao.append(el('div', { class: 'uso-ia-sub' }, 'Não consegui carregar o uso da IA agora.')); return; }

    const nomePlano = u.plano === 'completo' ? 'Completo' : 'Essencial';
    const cor = u.percentual >= 100 ? 'cheio' : u.percentual >= 80 ? 'alto' : '';
    cartao.innerHTML = '';
    cartao.append(
      el('div', { class: 'uso-ia-topo' },
        el('div', {},
          el('h3', {}, 'Uso da IA'),
          el('div', { class: 'uso-ia-sub' }, `Plano ${nomePlano} · renova em ${dataBr(u.renova_em)}`)),
        el('div', { class: 'uso-ia-pct ' + cor }, `${String(u.percentual).replace('.', ',')}%`)),
      el('div', { class: 'uso-ia-barra' }, el('i', { class: cor, style: `width:${Math.max(u.percentual, 1.5)}%` })),
      el('div', { class: 'uso-ia-sub' },
        u.bloqueado
          ? 'Você usou todo o limite deste mês. A IA volta a responder quando renovar ou quando você liberar mais uso.'
          : u.percentual >= 80
            ? 'Você está perto do limite do mês. Se precisar, libere mais uso abaixo.'
            : 'Inclui o Agente IA e os agentes do funil atendendo seus leads.'),
      u.extra_percentual > 0 ? el('div', { class: 'uso-ia-extra' }, `✦ +${u.extra_percentual}% de uso liberado este mês`) : '',
    );

    const caixa = el('div', { class: 'uso-ia-pacotes' });
    u.pacotes.forEach((p) => {
      caixa.append(el('button', {
        type: 'button', class: 'uso-ia-pacote',
        on: { click: async () => {
          try {
            await api('/uso/pedido', { method: 'POST', body: { valor: p.valor } });
            if (p.link) { window.open(p.link, '_blank', 'noopener'); toast('Conclua o pagamento na nova aba. O uso é liberado assim que o pagamento for confirmado.', 'success'); }
            else toast('Pedido registrado! Assim que o pagamento for confirmado, o uso extra é liberado.', 'success');
          } catch (e) { toast('Não consegui registrar o pedido: ' + e.message, 'error'); }
        } },
      },
        el('b', {}, `+${p.mais_uso_percentual}% de uso`),
        el('span', {}, moeda(p.valor))));
    });
    cartao.append(el('div', { class: 'uso-ia-libere' }, el('h4', {}, 'Liberar mais uso este mês'), caixa));
  }

  window.UsoIA = { montar };
})();
