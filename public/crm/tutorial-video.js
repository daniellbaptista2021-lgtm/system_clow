/* ═══════════════════════════════════════════════════════════════════════
 * CRM — Tutorial em vídeo
 *
 * Item de menu (no topo) e tela com o vídeo que ensina cada função do CRM,
 * com capítulos clicáveis. Mesmo molde de mcp-panel.js: aditivo, injeta o
 * próprio item e a própria view, e some inteiro se o script não carregar.
 *
 * O vídeo fica no site do Território (Vercel), e não em /crm/*: a rota de
 * arquivos do CRM não responde Range, e sem Range o iPhone não toca <video>.
 * ═══════════════════════════════════════════════════════════════════════ */

(function () {
  const VIDEO = 'https://territorio.pvcorretor01.com.br/tutoriais-video/crm-tutorial.mp4';
  const CAPA = 'https://territorio.pvcorretor01.com.br/tutoriais-video/crm-tutorial-capa.jpg';
  // [segundo, título] — tirados das cenas do vídeo (atualizar se o vídeo mudar).
  const CAPITULOS = [
    [0, 'Boas-vindas e o menu'], [32, 'Passo 1 · Conectar a IA'], [53, 'Passo 2 · Conectar o WhatsApp'],
    [66, 'O funil de vendas'], [81, 'Criar e mover cards'], [98, 'A conversa no card'],
    [130, 'Passo 3 · Agente de IA na coluna'], [174, 'Agente IA do CRM'], [185, 'Contatos'], [197, 'Equipe'],
    [204, 'Agenda'], [213, 'Mensalidades e cobrança'], [228, 'Relatórios'], [243, 'Tema e a sua marca'], [253, 'MCP'],
  ];

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
      else if (k === 'html') e.innerHTML = v;
      else if (v != null) e.setAttribute(k, v);
    }
    for (const c of kids) {
      if (c == null) continue;
      e.append(c instanceof Node ? c : document.createTextNode(c));
    }
    return e;
  };
  const apiKey = () => (window.clowStorage && window.clowStorage.getItem('clow_crm_key')) || '';
  const relogio = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function injetar() {
    const nav = $('.sidebar nav');
    if (!nav || nav.querySelector('[data-view="tutorial"]')) return;

    const item = el('button', { class: 'nav-item', data: { view: 'tutorial' } },
      el('span', {
        class: 'nav-icon',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
          + '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
      }),
      el('span', { class: 'nav-label' }, 'Tutorial em vídeo'),
    );
    nav.prepend(item); // no topo: é a primeira coisa que quem chega precisa ver

    $('.main').append(
      el('div', { class: 'view', data: { view: 'tutorial' }, id: 'tutorialView' },
        el('header', { class: 'top-bar' },
          el('div', { class: 'top-bar-left' }, el('h2', {}, 'Tutorial em vídeo')),
        ),
        el('div', { id: 'tutorialBody', style: 'padding:20px;max-width:1000px' }),
      ),
    );

    $$('.nav-item').forEach((n) => {
      if (n.dataset._tutWired) return;
      n.dataset._tutWired = '1';
      n.addEventListener('click', () => {
        if (n.dataset.view === 'tutorial') mostrar();
        else { const v = $('#tutorialVideo'); if (v) v.pause(); }
      });
    });
  }

  function mostrar() {
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === 'tutorial'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'tutorial'));
    renderizar();
  }

  function renderizar() {
    const body = $('#tutorialBody');
    if (!body || body.dataset.pronto) return;
    body.dataset.pronto = '1';

    const video = el('video', {
      id: 'tutorialVideo', src: VIDEO, poster: CAPA, controls: '', playsinline: '', preload: 'metadata',
      style: 'width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;border:1px solid var(--border);display:block',
    });

    body.append(
      el('p', { style: 'margin:0 0 16px;color:var(--text-dim);font-size:14px;line-height:1.55' },
        'Veja como usar cada função do CRM, passo a passo: conectar a IA e o WhatsApp, montar o funil, '
        + 'ligar um agente em cada coluna, mensalidades, relatórios e muito mais. Funciona no computador e no celular.'),
      video,
    );

    if (CAPITULOS.length) {
      const lista = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px' });
      for (const [seg, titulo] of CAPITULOS) {
        lista.append(el('button', {
          type: 'button',
          style: 'display:flex;gap:10px;align-items:center;text-align:left;padding:10px 12px;border-radius:10px;font-size:13px;'
            + 'background:var(--bg-2);color:var(--text);border:1px solid var(--border);cursor:pointer',
          on: { click: () => { video.currentTime = seg; video.play().catch(() => {}); video.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
        },
          el('span', { style: 'font-family:ui-monospace,monospace;font-size:12px;color:var(--purple);min-width:38px' }, relogio(seg)),
          el('span', {}, titulo),
        ));
      }
      body.append(
        el('h3', { style: 'margin:22px 0 10px;font-size:15px' }, 'Capítulos'),
        lista,
      );
    }
  }

  function tentarBoot() {
    if (!apiKey() || $('#app')?.classList.contains('hide')) {
      setTimeout(tentarBoot, 500);
      return;
    }
    injetar();
  }
  document.addEventListener('DOMContentLoaded', tentarBoot);
  setTimeout(tentarBoot, 1500);
})();
