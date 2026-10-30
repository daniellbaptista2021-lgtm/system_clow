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
      u.extra_pacotes > 0 ? el('div', { class: 'uso-ia-extra' }, '✦ Uso extra liberado este mês') : '',
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
        el('b', {}, p.nome),
        el('span', {}, moeda(p.valor))));
    });
    cartao.append(el('div', { class: 'uso-ia-libere' }, el('h4', {}, 'Crédito extra'), el('div', { class: 'uso-ia-sub', style: 'margin:-6px 0 12px' }, 'Vale para este mês e soma ao limite do seu plano. A barra de uso se ajusta na hora.'), caixa));

    // === Trocar de plano ===
    const PLANOS = {
      essencial: { nome: 'Essencial', preco: '189,90', desc: 'O CRM inteiro, com a IA atendendo o seu funil.',
        itens: ['Funil de vendas, WhatsApp e agenda', 'IA em cada etapa do funil, 24h', 'Mensalidades, datas e relatórios'] },
      completo: { nome: 'Completo', preco: '249,90', desc: 'Tudo incluso, com o Agente IA trabalhando junto com você.',
        itens: ['Tudo do Essencial', 'Agente IA completo no menu', 'Gestor de tráfego pago e criação', 'Maior limite de uso da IA'] },
    };
    const troca = el('div', { class: 'troca-plano' });
    u.planos.forEach((p) => {
      const d = PLANOS[p.id];
      const sobe = p.id === 'completo';
      troca.append(el('div', { class: 'troca-card' + (sobe ? ' top' : '') + (p.atual ? ' atual' : '') },
        sobe ? el('span', { class: 'troca-tag' }, 'Mais completo') : '',
        el('div', { class: 'troca-nome' }, d.nome),
        el('div', { class: 'troca-preco' }, el('small', {}, 'R$'), el('b', {}, d.preco), el('span', {}, '/mês')),
        el('div', { class: 'troca-desc' }, d.desc),
        el('ul', {}, ...d.itens.map((t) => el('li', {}, t))),
        p.atual
          ? el('div', { class: 'troca-atual' }, '✓ Seu plano atual')
          : el('button', { type: 'button', class: 'troca-btn' + (sobe ? ' sobe' : ''), on: { click: () => {
              if (p.link) window.open(p.link, '_blank', 'noopener');
              else toast('A troca de plano estará disponível em breve.', 'success');
            } } }, sobe ? 'Mudar para o Completo' : 'Mudar para o Essencial')));
    });
    destino.append(el('div', { class: 'uso-ia-cartao' }, el('h3', {}, 'Trocar de plano'), el('div', { class: 'uso-ia-sub', style: 'margin-bottom:16px' }, 'A mudança vale a partir da próxima cobrança.'), troca));
  }

  window.UsoIA = { montar };
})();
