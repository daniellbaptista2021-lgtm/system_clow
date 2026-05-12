/**
 * cotador-sulamerica.js — botao no painel do card que abre o cotador
 * SulAmerica em uma janela flutuante em formato de celular.
 *
 * - Botao injetado em #sidePanel .panel-head (so aparece com card aberto).
 * - Desktop: frame de celular flutuante, arrastavel + redimensionavel.
 * - Mobile (<=768px): bottom-sheet fullscreen.
 * - Posicao/tamanho persistidos em localStorage.
 * - Iframe sobrevive a troca de card (nao recarrega).
 */
(function () {
  if (window.__cotadorSulAmericaLoaded) return;
  window.__cotadorSulAmericaLoaded = true;

  const URL_COTADOR = 'https://cotador.sulamerica.pvcorretor01.com.br/';
  const LS_KEY = 'clow.cotadorSA.state.v3';
  const CHAT_WIDTH = 420; // largura do #sidePanel (ver crm.css)
  const GAP = 24;
  const Z = 9500; // abaixo do clow-dialog (10000) — dialogos do app passam por cima

  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (typeof s !== 'object' || !s) return null;
      return s;
    } catch { return null; }
  }
  function saveState(patch) {
    try {
      const cur = loadState() || {};
      localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
    } catch { /* quota / private mode */ }
  }

  function injectStyles() {
    if (document.getElementById('cotador-sa-style')) return;
    const st = document.createElement('style');
    st.id = 'cotador-sa-style';
    st.textContent = `
.cot-sa-trigger{
  display:inline-flex;align-items:center;gap:6px;
  padding:7px 12px;border-radius:10px;
  background:linear-gradient(135deg,#9B59FC,#4A9EFF);
  color:#fff;border:none;cursor:pointer;
  font-family:inherit;font-size:12px;font-weight:700;letter-spacing:-.005em;
  box-shadow:0 6px 16px rgba(155,89,252,.28);
  transition:transform .14s ease, box-shadow .14s ease;
  white-space:nowrap;flex-shrink:0;
}
.cot-sa-trigger:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(155,89,252,.4)}
.cot-sa-trigger .lbl{display:inline}
@media(max-width:560px){
  .cot-sa-trigger{padding:7px 9px}
  .cot-sa-trigger .lbl{display:none}
}

/* Janela flutuante (desktop) — formato tablet, ancorada a esquerda do chat (#sidePanel = 420px) */
.cot-sa-win{
  position:fixed;z-index:${Z};
  width:min(820px, calc(100vw - ${CHAT_WIDTH + GAP * 2}px));
  height:min(940px, calc(100vh - 32px));
  right:${CHAT_WIDTH + GAP}px;top:50%;transform:translateY(-50%);
  background:#0a0a18;border-radius:22px;
  border:1px solid rgba(155,89,252,.35);
  box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 4px #1a1a2e,0 0 0 5px rgba(255,255,255,.04);
  display:flex;flex-direction:column;
  overflow:hidden;
  font-family:inherit;color:#E8E8F0;
  animation:cotSaIn .22s cubic-bezier(.2,.7,.2,1);
}
@keyframes cotSaIn{from{opacity:0;transform:translateY(-50%) scale(.96)}to{opacity:1;transform:translateY(-50%) scale(1)}}
.cot-sa-win.dragging,.cot-sa-win.resizing{transition:none;animation:none}
.cot-sa-win.minimized{height:48px!important;width:240px!important;border-radius:14px;box-shadow:0 12px 30px rgba(0,0,0,.5)}
.cot-sa-win.minimized .cot-sa-body,.cot-sa-win.minimized .cot-sa-resize{display:none}
.cot-sa-win.minimized .cot-sa-head{cursor:pointer;border-radius:14px}

.cot-sa-head{
  height:48px;flex-shrink:0;
  display:flex;align-items:center;gap:8px;
  padding:0 12px 0 18px;
  background:linear-gradient(180deg,#15152a,#0f0f24);
  border-bottom:1px solid rgba(255,255,255,.06);
  cursor:move;user-select:none;
  border-top-left-radius:22px;border-top-right-radius:22px;
}
.cot-sa-title{
  flex:1;min-width:0;
  font-size:13px;font-weight:700;letter-spacing:-.005em;
  background:linear-gradient(135deg,#9B59FC,#4A9EFF);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.cot-sa-icon{
  background:transparent;border:none;color:#9898B8;
  width:30px;height:30px;border-radius:8px;
  cursor:pointer;font-size:16px;
  display:flex;align-items:center;justify-content:center;
  transition:background .14s, color .14s;
}
.cot-sa-icon:hover{background:rgba(155,89,252,.14);color:#E8E8F0}

.cot-sa-body{
  flex:1;min-height:0;position:relative;background:#fff;
}
.cot-sa-body iframe{
  width:100%;height:100%;border:0;display:block;background:#fff;
}

.cot-sa-resize{
  position:absolute;width:18px;height:18px;right:4px;bottom:4px;
  cursor:nwse-resize;z-index:2;opacity:.7;
  background:linear-gradient(135deg,transparent 50%,rgba(155,89,252,.55) 50%);
  border-bottom-right-radius:30px;
}
.cot-sa-resize:hover{opacity:1}

/* Mobile: bottom-sheet fullscreen */
@media(max-width:768px){
  .cot-sa-win{
    inset:0!important;width:100%!important;height:100%!important;
    right:0!important;top:0!important;left:0!important;bottom:0!important;
    transform:none!important;
    border-radius:0;border:none;
    box-shadow:none;
    animation:cotSaInMob .22s cubic-bezier(.2,.7,.2,1);
  }
  @keyframes cotSaInMob{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  .cot-sa-head{cursor:default;border-radius:0}
  .cot-sa-resize{display:none}
  .cot-sa-win.minimized{
    inset:auto 12px 12px auto!important;width:200px!important;height:44px!important;
    border-radius:12px;border:1px solid rgba(155,89,252,.35);
  }
}
`;
    document.head.appendChild(st);
  }

  function injectButton() {
    const head = document.querySelector('#sidePanel .panel-head');
    if (!head || head.querySelector('.cot-sa-trigger')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cot-sa-trigger';
    btn.title = 'Abrir Cotação SulAmérica';
    btn.innerHTML = '<span aria-hidden="true">📱</span><span class="lbl">Cotação SulAmérica</span>';
    btn.addEventListener('click', toggleWindow);
    // inserir antes do botao de fechar (se existir), senao no final
    const closeBtn = head.querySelector('.close-panel');
    if (closeBtn) head.insertBefore(btn, closeBtn);
    else head.appendChild(btn);
  }

  let winEl = null;

  function toggleWindow() {
    if (winEl) {
      // se ja existe, fecha
      closeWindow();
    } else {
      openWindow();
    }
  }

  function closeWindow() {
    if (!winEl) return;
    winEl.remove();
    winEl = null;
  }

  function openWindow() {
    const w = document.createElement('div');
    w.className = 'cot-sa-win';

    // restaurar posicao/tamanho (apenas desktop)
    if (!isMobile()) {
      const s = loadState();
      if (s) {
        if (typeof s.left === 'number') { w.style.left = s.left + 'px'; w.style.right = 'auto'; }
        if (typeof s.top === 'number') { w.style.top = s.top + 'px'; w.style.transform = 'none'; }
        if (typeof s.width === 'number') w.style.width = s.width + 'px';
        if (typeof s.height === 'number') w.style.height = s.height + 'px';
      }
    }

    const head = document.createElement('div');
    head.className = 'cot-sa-head';

    const title = document.createElement('div');
    title.className = 'cot-sa-title';
    title.textContent = '📱 Cotação SulAmérica';

    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'cot-sa-icon';
    minBtn.title = 'Minimizar';
    minBtn.innerHTML = '–';
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      w.classList.toggle('minimized');
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'cot-sa-icon';
    reloadBtn.title = 'Recarregar';
    reloadBtn.innerHTML = '↻';
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const f = w.querySelector('iframe');
      if (f) f.src = f.src;
    });

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'cot-sa-icon';
    openBtn.title = 'Abrir em nova aba';
    openBtn.innerHTML = '↗';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(URL_COTADOR, '_blank', 'noopener');
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cot-sa-icon';
    closeBtn.title = 'Fechar';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeWindow();
    });

    head.appendChild(title);
    head.appendChild(reloadBtn);
    head.appendChild(openBtn);
    head.appendChild(minBtn);
    head.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'cot-sa-body';
    const iframe = document.createElement('iframe');
    iframe.src = URL_COTADOR;
    iframe.title = 'Cotação SulAmérica';
    iframe.allow = 'clipboard-read; clipboard-write; camera; microphone; geolocation';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    body.appendChild(iframe);

    const resize = document.createElement('div');
    resize.className = 'cot-sa-resize';
    resize.title = 'Redimensionar';

    w.appendChild(head);
    w.appendChild(body);
    w.appendChild(resize);
    document.body.appendChild(w);
    winEl = w;

    // restaurar minimizado
    const s = loadState();
    if (s && s.minimized && !isMobile()) w.classList.add('minimized');

    wireDrag(w, head);
    wireResize(w, resize);

    // toggle minimized: clicar no head minimizado abre de volta
    head.addEventListener('click', (e) => {
      if (!w.classList.contains('minimized')) return;
      if (e.target.closest('.cot-sa-icon')) return;
      w.classList.remove('minimized');
      saveState({ minimized: false });
    });

    // observar mudanca de minimized pra persistir
    const mo = new MutationObserver(() => {
      saveState({ minimized: w.classList.contains('minimized') });
    });
    mo.observe(w, { attributes: true, attributeFilter: ['class'] });
  }

  function wireDrag(w, handle) {
    let drag = null;
    handle.addEventListener('mousedown', (e) => {
      if (isMobile()) return;
      if (e.target.closest('.cot-sa-icon')) return;
      if (w.classList.contains('minimized')) return;
      const rect = w.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      w.classList.add('dragging');
      // remover transform (pode ter translateY -50%)
      w.style.left = rect.left + 'px';
      w.style.top = rect.top + 'px';
      w.style.right = 'auto';
      w.style.transform = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const maxL = window.innerWidth - 120;
      const maxT = window.innerHeight - 40;
      const left = Math.min(maxL, Math.max(-w.offsetWidth + 120, e.clientX - drag.dx));
      const top = Math.min(maxT, Math.max(0, e.clientY - drag.dy));
      w.style.left = left + 'px';
      w.style.top = top + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      w.classList.remove('dragging');
      const rect = w.getBoundingClientRect();
      saveState({ left: Math.round(rect.left), top: Math.round(rect.top) });
    });
  }

  function wireResize(w, handle) {
    let rz = null;
    handle.addEventListener('mousedown', (e) => {
      if (isMobile()) return;
      const rect = w.getBoundingClientRect();
      rz = { sx: e.clientX, sy: e.clientY, sw: rect.width, sh: rect.height };
      w.classList.add('resizing');
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!rz) return;
      const width = Math.min(1200, Math.max(360, rz.sw + (e.clientX - rz.sx)));
      const height = Math.min(window.innerHeight - 20, Math.max(420, rz.sh + (e.clientY - rz.sy)));
      w.style.width = width + 'px';
      w.style.height = height + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!rz) return;
      rz = null;
      w.classList.remove('resizing');
      saveState({ width: Math.round(w.offsetWidth), height: Math.round(w.offsetHeight) });
    });
  }

  function init() {
    injectStyles();
    injectButton();
    // Reinjeta caso o painel seja re-renderizado (defensivo)
    const panel = document.getElementById('sidePanel');
    if (panel) {
      const mo = new MutationObserver(() => injectButton());
      mo.observe(panel, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
