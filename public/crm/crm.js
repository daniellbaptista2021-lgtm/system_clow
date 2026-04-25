/* ═══════════════════════════════════════════════════════════════════════
 * CRM CLOW — frontend
 * Zero dependencies. Vanilla ES2022 modules.
 * ═══════════════════════════════════════════════════════════════════════ */

// ─── Global state ──────────────────────────────────────────────────────
const state = {
  apiKey: localStorage.getItem('clow_crm_key') || '',
  tenant: null,
  boards: [],
  currentBoardId: null,
  pipeline: null,         // { board, columns, cardsByColumn }
  channels: [],
  contacts: [],
  agents: [],
  inventory: [],
  currentCard: null,
  pollInterval: null,
};

// ─── API helper ────────────────────────────────────────────────────────
const API_BASE = '/v1/crm';

async function api(path, opts = {}) {
  const headers = {
    'Authorization': `Bearer ${state.apiKey}`,
    ...(opts.headers || {}),
  };
  if (!(opts.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

// ─── UI utils ──────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
    else if (k === 'html') e.innerHTML = v;
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return e;
};
function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
}
function fmtMoney(cents) {
  return `R$ ${((cents || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
         d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function toast(msg, type = '') {
  const t = el('div', { class: `toast ${type}` }, msg);
  $('#toastRoot').append(t);
  setTimeout(() => t.remove(), 3200);
}
function confirmDialog(title, body, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' },
      el('h3', {}, title),
      body instanceof Node ? body : el('p', {}, body),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'cancel', on: { click: () => { backdrop.remove(); resolve(false); } } }, 'Cancelar'),
        el('button', { class: 'confirm', on: { click: () => { backdrop.remove(); resolve(true); } } }, okLabel),
      ),
    );
    backdrop.append(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } });
    document.body.append(backdrop);
  });
}

// ─── Auth ──────────────────────────────────────────────────────────────
async function attemptLogin(apiKey) {
  try {
    const r = await fetch('/v1/crm/stats', { headers: { 'Authorization': `Bearer ${apiKey}` } });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${r.status}`);
    }
    localStorage.setItem('clow_crm_key', apiKey);
    state.apiKey = apiKey;
    return true;
  } catch (e) {
    throw e;
  }
}

function logout() {
  localStorage.removeItem('clow_crm_key');
  state.apiKey = '';
  if (state.pollInterval) clearInterval(state.pollInterval);
  location.reload();
}

// ─── Bootstrap ─────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    // Ensure defaults seeded + load everything
    await api('/init', { method: 'POST' });
    await loadBoards();
    await loadChannels();
    if (state.boards.length) {
      state.currentBoardId = state.boards[0].id;
      await loadPipeline(state.currentBoardId);
    }
    renderSidebarTenant();
    renderBoardSelector();
    renderKanban();
    renderChannelsList(); // pre-render so send-channel dropdown has data
    // Polling: refresh pipeline + active conversation every 10s
    state.pollInterval = setInterval(async () => {
      // Onda 52: smart refresh preserva scroll + skip se interagindo
      if ($('#kanbanView').classList.contains('active')) {
        if (typeof window.__smartRefresh === 'function') {
          await window.__smartRefresh('boot-tick-10s');
        } else {
          await loadPipeline(state.currentBoardId);
          renderKanban();
        }
      }
      if (state.currentCard && !$('#sidePanel').classList.contains('hide')) {
        await refreshCurrentCard();
      }
    }, 10000);
  } catch (e) {
    toast('Erro ao carregar: ' + e.message, 'error');
  }
}

// ─── Data loaders ──────────────────────────────────────────────────────
async function loadBoards() {
  const r = await api('/boards');
  state.boards = r.boards || [];
}

async function loadPipeline(boardId) {
  if (!boardId) return;
  const r = await api(`/boards/${boardId}/pipeline`);
  state.pipeline = r;
}

async function loadChannels() {
  const r = await api('/channels');
  state.channels = r.channels || [];
}

async function loadContacts(q = '') {
  const path = q ? `/contacts/search?q=${encodeURIComponent(q)}` : '/contacts?limit=100';
  const r = await api(path);
  state.contacts = r.contacts || [];
}

async function loadAgents() {
  const r = await api('/agents');
  state.agents = r.agents || [];
}

async function loadInventory() {
  const r = await api('/inventory');
  state.inventory = r.items || [];
}

async function loadStats() {
  return api('/stats');
}

// ─── Rendering: sidebar ────────────────────────────────────────────────
function renderSidebarTenant() {
  $('#tenantName').textContent = state.tenant?.name || 'Tenant';
  $('#tenantTier').textContent = state.tenant?.tier || '';
}

// ─── Rendering: board selector ─────────────────────────────────────────
function renderBoardSelector() {
  const sel = $('#boardSelector');
  sel.innerHTML = '';
  for (const b of state.boards) {
    const opt = el('option', { value: b.id }, b.name);
    if (b.id === state.currentBoardId) opt.selected = true;
    sel.append(opt);
  }
  sel.onchange = async (e) => {
    state.currentBoardId = e.target.value;
    await loadPipeline(state.currentBoardId);
    renderKanban();
  };
}

// ─── Rendering: kanban ─────────────────────────────────────────────────
function renderKanban() {
  const k = $('#kanban');
  k.innerHTML = '';
  if (!state.pipeline) { k.append(el('div', { class: 'empty' }, 'Crie uma board pra começar.')); return; }
  const { columns, cardsByColumn } = state.pipeline;
  for (const col of columns) {
    const cards = cardsByColumn[col.id] || [];
    const colEl = el('div', { class: 'kanban-col', data: { columnId: col.id } },
      el('div', { class: 'col-head' },
        el('div', { class: 'col-title' },
          el('span', { class: 'col-color-dot', style: `background:${col.color}` }),
          col.name,
        ),
        el('span', { class: 'col-count' }, String(cards.length)),
      ),
      el('div', { class: 'col-body', data: { columnId: col.id } }, ...cards.map(cardEl)),
      el('div', { class: 'col-foot' },
        el('button', { class: 'add-card-btn', on: { click: () => openNewCardModal(col.id) } }, '+ Adicionar card'),
      ),
    );
    // Drop target
    const body = colEl.querySelector('.col-body');
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      body.classList.add('drop-target');
    });
    body.addEventListener('dragleave', () => body.classList.remove('drop-target'));
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      body.classList.remove('drop-target');
      const cardId = e.dataTransfer.getData('text/card-id');
      const fromColumnId = e.dataTransfer.getData('text/from-col');
      if (cardId && fromColumnId !== col.id) {
        try {
          await api(`/cards/${cardId}/move`, { method: 'POST', body: { toColumnId: col.id } });
          await loadPipeline(state.currentBoardId);
          renderKanban();
          toast('Card movido', 'success');
        } catch (err) {
          toast('Erro ao mover: ' + err.message, 'error');
        }
      }
    });
    k.append(colEl);
  }
}

function cardEl(card) {
  const contact = card.contact || {};
  const over = card.dueDate && card.dueDate < Date.now();
  const c = el('div', { class: 'card', draggable: 'true', data: { cardId: card.id, columnId: card.columnId } },
    el('div', { class: 'card-title' }, card.title),
    contact.name ? el('div', { class: 'card-contact' },
      el('div', { class: 'card-avatar' }, initials(contact.name)),
      contact.name,
    ) : null,
    el('div', { class: 'card-meta' },
      card.valueCents > 0 ? el('span', { class: 'card-value' }, fmtMoney(card.valueCents)) : el('span'),
      card.probability > 0 ? el('span', { class: 'card-probability' }, `${card.probability}%`) : el('span'),
    ),
    (card.labels || []).length ? el('div', { class: 'card-labels' },
      ...card.labels.map(l => el('span', { class: 'card-label' }, l)),
    ) : null,
    card.dueDate ? el('div', { class: over ? 'card-due overdue' : 'card-due' },
      over ? '⚠ ' : '📅 ',
      new Date(card.dueDate).toLocaleDateString('pt-BR'),
    ) : null,
    // Onda 48: badge WhatsApp — aparece quando tem mensagens nao respondidas
    (card.unreadCount || 0) > 0 ? el('div', { class: 'card-wa-badge', title: card.unreadCount + ' mensagem(ns) aguardando resposta' },
      el('span', { class: 'wa-icon', html: '<svg viewBox="0 0 32 32" width="16" height="16" fill="#25D366"><path d="M16 .4C7.4.4.4 7.4.4 16c0 3 .8 5.9 2.4 8.4L.4 31.6l7.4-2.4c2.4 1.4 5.2 2.1 8.2 2.1 8.6 0 15.6-7 15.6-15.6S24.6.4 16 .4zm0 28.5c-2.7 0-5.3-.7-7.5-2.1l-.5-.3-5.5 1.8 1.8-5.4-.4-.5C2.4 20.2 1.6 18.1 1.6 16 1.6 8.1 8.1 1.6 16 1.6S30.4 8.1 30.4 16 23.9 28.9 16 28.9zm8.1-10.8c-.4-.2-2.6-1.3-3-1.4-.4-.1-.7-.2-1 .2s-1.2 1.4-1.4 1.7c-.3.3-.5.3-.9.1-2.4-1.2-4-2.1-5.5-4.8-.4-.7.4-.7 1.2-2.2.1-.3 0-.5-.1-.7-.1-.2-.9-2.1-1.2-2.9-.3-.8-.7-.7-.9-.7H10c-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.4 0 2 1.4 3.9 1.6 4.2.2.3 2.8 4.3 6.8 6.1 2.6 1.1 3.6 1.2 4.9 1 .8-.1 2.6-1.1 3-2.1.4-1 .4-1.9.3-2.1-.1-.2-.4-.3-.8-.5z"/></svg>' }),
      el('span', { class: 'wa-count' }, String(card.unreadCount)),
    ) : null,
  );
  c.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/card-id', card.id);
    e.dataTransfer.setData('text/from-col', card.columnId);
    c.classList.add('dragging');
  });
  c.addEventListener('dragend', () => c.classList.remove('dragging'));
  c.addEventListener('click', () => openCardPanel(card.id));
  // Right-click: menu de contexto com acoes
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCardContextMenu(card, e.clientX, e.clientY);
  });
  // Long-press no mobile: 550ms = abre menu centrado no dedo
  let _lpTimer = null, _lpStart = null;
  c.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; if (!t) return;
    _lpStart = { x: t.clientX, y: t.clientY };
    _lpTimer = setTimeout(() => {
      if (_lpStart) { navigator.vibrate?.(20); showCardContextMenu(card, _lpStart.x, _lpStart.y); _lpStart = null; }
    }, 550);
  }, { passive: true });
  c.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t || !_lpStart) return;
    if (Math.abs(t.clientX - _lpStart.x) > 10 || Math.abs(t.clientY - _lpStart.y) > 10) {
      clearTimeout(_lpTimer); _lpStart = null;
    }
  }, { passive: true });
  c.addEventListener('touchend', () => { clearTimeout(_lpTimer); _lpStart = null; });
  c.addEventListener('touchcancel', () => { clearTimeout(_lpTimer); _lpStart = null; });
  return c;
}

// ═══ CARD CONTEXT MENU (right-click + long-press) ═════════════════════════
function ensureCtxMenuStyles() {
  if (document.getElementById('ctx-menu-style')) return;
  const st = document.createElement('style');
  st.id = 'ctx-menu-style';
  st.textContent = `
.ctx-menu{position:fixed;z-index:9998;background:var(--bg-2,#0F0F24);border:1px solid var(--border-2,rgba(155,89,252,.3));border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.55),0 1px 0 rgba(255,255,255,.04) inset;min-width:220px;padding:6px;font-family:inherit;font-size:13px;color:var(--text,#E8E8F0);animation:ctxIn .14s ease}
@keyframes ctxIn{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
.ctx-menu .ctx-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:7px;cursor:pointer;color:var(--text,#E8E8F0);user-select:none;white-space:nowrap;position:relative}
.ctx-menu .ctx-item:hover{background:linear-gradient(135deg,rgba(155,89,252,.14),rgba(74,158,255,.08))}
.ctx-menu .ctx-item .ctx-ico{width:16px;height:16px;flex-shrink:0;color:var(--text-dim,#9898B8);display:inline-flex;align-items:center;justify-content:center}
.ctx-menu .ctx-item .ctx-arrow{margin-left:auto;color:var(--text-dim,#9898B8);font-size:11px}
.ctx-menu .ctx-item.ctx-danger{color:var(--red,#EF4444)}
.ctx-menu .ctx-item.ctx-danger .ctx-ico{color:var(--red,#EF4444)}
.ctx-menu .ctx-item.ctx-danger:hover{background:rgba(239,68,68,.12)}
.ctx-menu .ctx-sep{height:1px;background:var(--border,rgba(255,255,255,.08));margin:4px 2px}
.ctx-menu .ctx-header{padding:8px 12px 4px;font-size:10px;text-transform:uppercase;letter-spacing:1.1px;color:var(--text-faint,#6E6E8C);font-weight:700}
.ctx-sub{padding:6px 12px;color:var(--text-dim,#9898B8);font-size:11.5px;font-style:italic}
`;
  document.head.appendChild(st);
}

let _ctxMenuEl = null;
function closeCtxMenus() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
}
document.addEventListener('click', (e) => {
  if (_ctxMenuEl && !_ctxMenuEl.contains(e.target)) closeCtxMenus();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenus(); });
window.addEventListener('scroll', closeCtxMenus, true);

function ctxItem(icon, label, onClick, opts = {}) {
  const span = el('span', { class: 'ctx-ico', html: icon });
  const item = el('div', { class: 'ctx-item' + (opts.danger ? ' ctx-danger' : '') }, span, label);
  if (opts.submenu) item.append(el('span', { class: 'ctx-arrow' }, '›'));
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCtxMenus();
    onClick?.();
  });
  return item;
}

function ctxSep() { return el('div', { class: 'ctx-sep' }); }
function ctxHeader(t) { return el('div', { class: 'ctx-header' }, t); }

function showCardContextMenu(card, x, y) {
  closeCtxMenus();
  ensureCtxMenuStyles();

  const ICO_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const ICO_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const ICO_MONEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
  const ICO_PCT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>';
  const ICO_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const ICO_MOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>';
  const ICO_WIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICO_LOSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICO_REPEAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  const ICO_LABEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  const ICO_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  const ICO_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  const menu = el('div', { class: 'ctx-menu' });
  menu.append(
    ctxHeader(truncate(card.title || 'Card', 30)),
    ctxItem(ICO_OPEN, 'Abrir', () => openCardPanel(card.id)),
    ctxItem(ICO_EDIT, 'Editar titulo', async () => {
      const t = await clowPrompt('Novo titulo:', card.title || '', { title: 'Editar card' });
      if (t == null || t.trim() === card.title) return;
      await patchCardSafe(card.id, { title: t.trim() });
    }),
    ctxSep(),
    ctxItem(ICO_MONEY, 'Definir valor (R$)', async () => {
      const current = ((card.valueCents || 0) / 100).toFixed(2);
      const v = await clowPrompt('Valor em R$ (ex: 1500.00):', current, { title: 'Definir valor', type: 'text', hint: 'Use ponto ou virgula como separador decimal.' });
      if (v == null) return;
      const cents = Math.round(parseFloat(String(v).replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents < 0) return toast('Valor invalido', 'error');
      await patchCardSafe(card.id, { valueCents: cents });
    }),
    ctxItem(ICO_PCT, 'Definir probabilidade (%)', async () => {
      const v = await clowPrompt('Probabilidade 0-100:', String(card.probability ?? 50), { title: 'Definir probabilidade', type: 'number' });
      if (v == null) return;
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || n > 100) return toast('0-100', 'error');
      await patchCardSafe(card.id, { probability: n });
    }),
    ctxItem(ICO_CAL, 'Definir vencimento', async () => {
      const cur = card.dueDate ? new Date(card.dueDate).toISOString().slice(0, 10) : '';
      const v = await clowPrompt('Deixe em branco pra remover.', cur, { title: 'Definir vencimento', type: 'date' });
      if (v == null) return;
      const ms = v.trim() ? Date.parse(v) : null;
      if (v.trim() && !Number.isFinite(ms)) return toast('Data invalida', 'error');
      await patchCardSafe(card.id, { dueDate: ms });
    }),
    ctxItem(ICO_LABEL, 'Etiquetas...', async () => {
      const cur = (card.labels || []).join(', ');
      const v = await clowPrompt('Etiquetas (separadas por virgula):', cur, { title: 'Etiquetas' });
      if (v == null) return;
      const labels = v.split(',').map(s => s.trim()).filter(Boolean);
      await patchCardSafe(card.id, { labels });
    }),
    ctxSep(),
    ctxItem(ICO_USER, 'Atribuir agente...', () => showAssignSubmenu(card, x, y)),
    ctxItem(ICO_MOVE, 'Mover para coluna...', () => showMoveSubmenu(card, x, y)),
    ctxSep(),
    ctxItem(ICO_WIN, 'Marcar como Ganho', () => markCardWon(card)),
    ctxItem(ICO_LOSS, 'Marcar como Perdido', () => markCardLost(card)),
    ctxSep(),
    ctxItem(ICO_REPEAT, 'Criar cobranca mensal', () => createSubscriptionForCard(card)),
    ctxSep(),
    ctxItem(ICO_TRASH, 'Apagar card', async () => {
      if (!(await clowConfirm('Apagar o card "' + (card.title || '') + '"? Esta acao e permanente.', { title: 'Apagar card', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/cards/' + card.id, { method: 'DELETE' });
        toast('Card apagado', 'success');
        await refreshBoard();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    }, { danger: true }),
  );

  showMenu(menu, x, y);
}

function showAssignSubmenu(card, x, y) {
  closeCtxMenus();
  ensureCtxMenuStyles();
  const menu = el('div', { class: 'ctx-menu' });
  menu.append(ctxHeader('Atribuir agente'));
  const agents = (state.agents || []);
  if (!agents.length) {
    menu.append(el('div', { class: 'ctx-sub' }, 'Nenhum agente cadastrado'));
  } else {
    agents.forEach(a => {
      menu.append(ctxItem('', a.name + (a.id === card.assignedAgentId ? ' (atual)' : ''), async () => {
        await patchCardSafe(card.id, { assignedAgentId: a.id });
      }));
    });
  }
  menu.append(ctxSep(), ctxItem('', 'Remover atribuicao', async () => {
    await patchCardSafe(card.id, { assignedAgentId: null });
  }));
  showMenu(menu, x, y);
}

function showMoveSubmenu(card, x, y) {
  closeCtxMenus();
  ensureCtxMenuStyles();
  const menu = el('div', { class: 'ctx-menu' });
  menu.append(ctxHeader('Mover para coluna'));
  const cols = state.pipeline?.columns || [];
  if (!cols.length) menu.append(el('div', { class: 'ctx-sub' }, 'Sem colunas'));
  cols.forEach(col => {
    const isCurrent = col.id === card.columnId;
    menu.append(ctxItem('', col.name + (isCurrent ? ' (atual)' : ''), async () => {
      if (isCurrent) return;
      try {
        await api('/cards/' + card.id + '/move', { method: 'POST', body: { toColumnId: col.id } });
        toast('Movido pra ' + col.name, 'success');
        await refreshBoard();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    }));
  });
  showMenu(menu, x, y);
}

async function markCardWon(card) {
  const cols = state.pipeline?.columns || [];
  const won = cols.find(c => (c.stageType === 'won' || /ganho|fechado|won/i.test(c.name)));
  if (!won) return toast('Coluna de Ganho nao encontrada. Crie uma.', 'error');
  try {
    await api('/cards/' + card.id + '/move', { method: 'POST', body: { toColumnId: won.id } });
    toast('Parabens! Card marcado como Ganho', 'success');
    await refreshBoard();
  } catch (err) { toast('Erro: ' + err.message, 'error'); }
}

async function markCardLost(card) {
  const cols = state.pipeline?.columns || [];
  const lost = cols.find(c => (c.stageType === 'lost' || /perdido|lost/i.test(c.name)));
  if (!lost) return toast('Coluna de Perdido nao encontrada. Crie uma.', 'error');
  try {
    await api('/cards/' + card.id + '/move', { method: 'POST', body: { toColumnId: lost.id } });
    toast('Card marcado como Perdido', 'success');
    await refreshBoard();
  } catch (err) { toast('Erro: ' + err.message, 'error'); }
}

async function createSubscriptionForCard(card) {
  // Pega o contact do card primeiro
  let contactId = card.contactId;
  if (!contactId) {
    try {
      const r = await api('/cards/' + card.id);
      contactId = r.card?.contactId || r.contact?.id;
    } catch { /* silent */ }
  }
  if (!contactId) return toast('Card sem contato associado. Abra e vincule um.', 'error');

  const planName = await clowPrompt('Nome do plano (ex: Plano Premium):', card.title || '', { title: 'Criar cobranca mensal' });
  if (!planName) return;
  const amtStr = await clowPrompt('Valor mensal em R$ (ex: 497.00):', ((card.valueCents || 0) / 100).toFixed(2), { title: 'Cobranca — valor' });
  if (amtStr == null) return;
  const amountCents = Math.round(parseFloat(String(amtStr).replace(',', '.')) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return toast('Valor invalido', 'error');

  const cycle = await clowSelect('Ciclo:', [{value:'monthly',label:'Mensal'},{value:'weekly',label:'Semanal'},{value:'quarterly',label:'Trimestral'},{value:'yearly',label:'Anual'},{value:'one_time',label:'Uma vez'}], { title: 'Cobranca — ciclo', defaultValue: 'monthly' });
  if (!cycle) return;

  const nextStr = await clowPrompt('Proxima cobranca:', new Date(Date.now() + 30*86400000).toISOString().slice(0,10), { title: 'Cobranca — proxima data', type: 'date' });
  if (!nextStr) return;
  const nextChargeAt = Date.parse(nextStr);
  if (!Number.isFinite(nextChargeAt)) return toast('Data invalida', 'error');

  try {
    await api('/subscriptions', {
      method: 'POST',
      body: { contactId, planName, amountCents, cycle, nextChargeAt },
    });
    toast('Cobranca mensal criada!', 'success');
  } catch (err) { toast('Erro: ' + err.message, 'error'); }
}

async function patchCardSafe(cardId, patch) {
  try {
    await api('/cards/' + cardId, { method: 'PATCH', body: patch });
    toast('Salvo', 'success');
    await refreshBoard();
  } catch (err) { toast('Erro: ' + err.message, 'error'); }
}

function positionMenu(menu, x, y) {
  // Estima 280x400 antes de medir; ajusta se sair da viewport
  menu.style.left = Math.min(x, window.innerWidth - 260) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 420) + 'px';
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

async function refreshBoard() {
  try {
    await loadPipeline?.();
    renderBoard?.();
  } catch { /* silent */ }
}


// ═══ GENERIC LIST CONTEXT MENU HELPER ═════════════════════════════════════
function attachListItemContextMenu(itemEl, showMenuFn) {
  itemEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenuFn(e.clientX, e.clientY);
  });
  let _lpTimer = null, _lpStart = null;
  itemEl.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; if (!t) return;
    _lpStart = { x: t.clientX, y: t.clientY };
    _lpTimer = setTimeout(() => {
      if (_lpStart) { navigator.vibrate?.(20); showMenuFn(_lpStart.x, _lpStart.y); _lpStart = null; }
    }, 550);
  }, { passive: true });
  itemEl.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t || !_lpStart) return;
    if (Math.abs(t.clientX - _lpStart.x) > 10 || Math.abs(t.clientY - _lpStart.y) > 10) {
      clearTimeout(_lpTimer); _lpStart = null;
    }
  }, { passive: true });
  itemEl.addEventListener('touchend', () => { clearTimeout(_lpTimer); _lpStart = null; });
  itemEl.addEventListener('touchcancel', () => { clearTimeout(_lpTimer); _lpStart = null; });
}

// Icones SVG compartilhados
const CTX_ICO = {
  open:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  edit:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  send:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  card:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  copy:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  play:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="20 6 9 17 4 12"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  json:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

function buildMenu(items, headerText) {
  ensureCtxMenuStyles();
  const menu = el('div', { class: 'ctx-menu' });
  if (headerText) menu.append(ctxHeader(headerText));
  for (const it of items) {
    if (it === 'sep') { menu.append(ctxSep()); continue; }
    menu.append(ctxItem(it.icon, it.label, it.onClick, { danger: it.danger }));
  }
  return menu;
}

// ═══ CONTACT context menu ═════════════════════════════════════════════════
function showContactContextMenu(contact, x, y) {
  closeCtxMenus();
  const items = [
    { icon: CTX_ICO.open, label: 'Abrir (card vinculado)', onClick: async () => {
      try {
        const detail = await api('/contacts/' + contact.id);
        const card = detail.cards?.[0];
        if (card) openCardPanel(card.id);
        else toast('Contato sem card vinculado', '');
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    { icon: CTX_ICO.edit, label: 'Editar contato', onClick: async () => {
      const name = await clowPrompt('Nome:', contact.name || '', { title: 'Editar contato' });
      if (name == null) return;
      const phone = await clowPrompt('Telefone:', contact.phone || '', { title: 'Editar contato', type: 'tel' });
      if (phone == null) return;
      const email = await clowPrompt('Email:', contact.email || '', { title: 'Editar contato', type: 'email' });
      if (email == null) return;
      try {
        await api('/contacts/' + contact.id, { method: 'PATCH', body: { name: name.trim(), phone: phone.trim(), email: email.trim() } });
        toast('Atualizado', 'success');
        await loadContacts(); renderContactsList();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    'sep',
    { icon: CTX_ICO.card, label: 'Criar card no pipeline', onClick: async () => {
      const title = await clowPrompt('Titulo do card:', contact.name || '', { title: 'Novo card' });
      if (!title) return;
      try {
        const boards = state.boards || [];
        const board = boards[0];
        if (!board) return toast('Nenhum board. Crie um primeiro.', 'error');
        const cols = state.pipeline?.columns?.length ? state.pipeline.columns :
          (await api('/boards/' + board.id + '/columns')).columns;
        const firstCol = cols.find(c => !c.isTerminal) || cols[0];
        await api('/cards', { method: 'POST', body: {
          boardId: board.id, columnId: firstCol.id, title, contactId: contact.id,
        } });
        toast('Card criado em ' + firstCol.name, 'success');
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    'sep',
    { icon: CTX_ICO.trash, label: 'Apagar contato', danger: true, onClick: async () => {
      if (!(await clowConfirm('Apagar "' + contact.name + '"? Cards vinculados ficam sem contato.', { title: 'Apagar contato', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/contacts/' + contact.id, { method: 'DELETE' });
        toast('Contato apagado', 'success');
        await loadContacts(); renderContactsList();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = buildMenu(items, truncate(contact.name || 'Contato', 30));
  showMenu(menu, x, y);
}

// ═══ CHANNEL context menu ═════════════════════════════════════════════════
function showChannelContextMenu(channel, x, y) {
  closeCtxMenus();
  const whUrl = location.origin + '/webhooks/crm/' + channel.type + '/' + channel.webhookSecret;
  const items = [
    { icon: CTX_ICO.edit, label: 'Editar canal', onClick: () => openEditChannelModal(channel) },
    { icon: CTX_ICO.copy, label: 'Copiar webhook URL', onClick: async () => {
      try { await navigator.clipboard.writeText(whUrl); toast('Webhook copiado', 'success'); }
      catch { toast('URL: ' + whUrl, ''); }
    }},
    'sep',
    { icon: channel.status === 'active' ? CTX_ICO.pause : CTX_ICO.play,
      label: channel.status === 'active' ? 'Pausar canal' : 'Ativar canal',
      onClick: async () => {
        try {
          const newStatus = channel.status === 'active' ? 'paused' : 'active';
          await api('/channels/' + channel.id, { method: 'PATCH', body: { status: newStatus } });
          toast(newStatus === 'active' ? 'Canal ativado' : 'Canal pausado', 'success');
          await loadChannels?.(); renderChannelsList();
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
      }},
    'sep',
    { icon: CTX_ICO.trash, label: 'Apagar canal', danger: true, onClick: async () => {
      if (!(await clowConfirm('Apagar canal "' + channel.name + '"? Mensagens recebidas continuam no historico.', { title: 'Apagar canal', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/channels/' + channel.id, { method: 'DELETE' });
        toast('Canal apagado', 'success');
        await loadChannels?.(); renderChannelsList();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = buildMenu(items, truncate(channel.name || 'Canal', 30));
  showMenu(menu, x, y);
}

// ═══ AGENT context menu ═══════════════════════════════════════════════════
function showAgentContextMenu(agent, x, y) {
  closeCtxMenus();
  const items = [
    { icon: CTX_ICO.edit, label: 'Editar agente', onClick: () => openEditAgentModal(agent) },
    { icon: CTX_ICO.chart, label: 'Ver metricas', onClick: async () => {
      try {
        const m = await api('/agents/' + agent.id + '/metrics');
        await clowAlert(
          `Agente: ${agent.name}
` +
          `Cards atribuidos: ${m.cardsAssigned || 0}
` +
          `Cards ganhos: ${m.cardsWon || 0}
` +
          `Conversao: ${((m.conversionRate || 0) * 100).toFixed(1)}%
` +
          `Tempo medio resposta: ${m.avgResponseMinutes || 0}min
` +
          `Receita: ${fmtMoney((m.revenueWonCents || 0))}`,
          { title: 'Metricas do agente' }
        );
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    'sep',
    { icon: CTX_ICO.trash, label: 'Apagar agente', danger: true, onClick: async () => {
      if (!(await clowConfirm('Apagar "' + agent.name + '"? Cards atribuidos ficam sem dono.', { title: 'Apagar agente', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/agents/' + agent.id, { method: 'DELETE' });
        toast('Agente apagado', 'success');
        await loadAgents?.(); renderAgentsList();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = buildMenu(items, truncate(agent.name || 'Agente', 30));
  showMenu(menu, x, y);
}

// ═══ INVENTORY context menu ═══════════════════════════════════════════════
function showInventoryContextMenu(item, x, y) {
  closeCtxMenus();
  const items = [
    { icon: CTX_ICO.edit, label: 'Editar produto', onClick: () => openEditInventoryModal(item) },
    { icon: CTX_ICO.stock, label: 'Ajustar estoque', onClick: async () => {
      const v = await clowPrompt('Delta de estoque (ex: +5 ou -2):', '0', { title: 'Ajustar estoque', hint: 'Use sinal + ou -. Estoque atual: ' + item.stock });
      if (v == null) return;
      const delta = parseInt(String(v).replace(/[^\-\d]/g, ''), 10);
      if (!Number.isFinite(delta)) return toast('Valor invalido', 'error');
      try {
        await api('/inventory/' + item.id + '/stock', { method: 'POST', body: { delta } });
        toast('Estoque ajustado em ' + (delta > 0 ? '+' : '') + delta, 'success');
        await loadInventory?.(); renderInventoryList();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    'sep',
    { icon: CTX_ICO.trash, label: 'Apagar produto', danger: true, onClick: async () => {
      if (!(await clowConfirm('Apagar produto "' + item.name + '"?', { title: 'Apagar produto', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/inventory/' + item.id, { method: 'DELETE' });
        toast('Produto apagado', 'success');
        await loadInventory?.(); renderInventoryList();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = buildMenu(items, truncate(item.name || 'Produto', 30));
  showMenu(menu, x, y);
}



// ─── Side panel ────────────────────────────────────────────────────────
async function openCardPanel(cardId) {
  // Onda 48: zerar badge WhatsApp ao abrir o card (fire-and-forget)
  try { api(`/cards/${cardId}/mark-read`, { method: 'POST' }).catch(()=>{}); } catch {}

  try {
    const r = await api(`/cards/${cardId}`);
    state.currentCard = { card: r.card, contact: r.contact, activities: r.activities };
    $('#sidePanel').classList.remove('hide');
    $('#app').classList.add('panel-open');
    renderPanel();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function refreshCurrentCard() {
  if (!state.currentCard) return;
  try {
    const r = await api(`/cards/${state.currentCard.card.id}`);
    const prevLen = state.currentCard.activities.length;
    state.currentCard = { card: r.card, contact: r.contact, activities: r.activities };
    if (r.activities.length !== prevLen) renderMessages();
  } catch { /* silent */ }
}

function closeCardPanel() {
  $('#sidePanel').classList.add('hide');
  $('#app').classList.remove('panel-open');
  state.currentCard = null;
}

function renderPanel() {
  const { card, contact, activities } = state.currentCard;
  $('#pAvatar').textContent = initials(contact?.name || card.title);
  $('#pName').textContent = contact?.name || card.title;
  $('#pPhone').textContent = contact?.phone || '—';
  // Populate channel select
  const sel = $('#sendChannelSelect');
  sel.innerHTML = '';
  for (const ch of state.channels.filter(c => c.status !== 'disabled')) {
    sel.append(el('option', { value: ch.id }, `${ch.name} (${ch.type.toUpperCase()})`));
  }
  if (state.channels.length === 0) {
    sel.append(el('option', { value: '' }, 'Nenhum canal configurado'));
  }
  renderMessages();
  renderInfoTab();
  renderEditTab();
}


// Onda 51: renderizar texto WhatsApp-style (escape + markdown + urls)
function renderTextHTML(text) {
  if (!text) return '';
  // 1. Escape HTML (XSS safety)
  let s = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // 2. Markdown WhatsApp:
  //    *bold* _italic_ ~strike~ ```code```
  // Code blocks PRIMEIRO (pra nao ser interpretado como bold/italic)
  s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  // Bold *abc* (nao deve estar no meio de palavra)
  s = s.replace(/(^|\s)\*([^\s*][^*]*[^\s*]|[^\s*])\*(?=\s|$|[.,!?;:])/g, '$1<b>$2</b>');
  // Italic _abc_
  s = s.replace(/(^|\s)_([^\s_][^_]*[^\s_]|[^\s_])_(?=\s|$|[.,!?;:])/g, '$1<i>$2</i>');
  // Strike ~abc~
  s = s.replace(/(^|\s)~([^\s~][^~]*[^\s~]|[^\s~])~(?=\s|$|[.,!?;:])/g, '$1<s>$2</s>');
  // 3. URLs clicaveis (http/https/www)
  s = s.replace(/((?:https?:\/\/|www\.)[^\s<]+[^\s<.,!?;:)])/g, (url) => {
    const href = url.startsWith('http') ? url : 'https://' + url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
  return s;
}

function renderMessages() {
  const list = $('#messagesList');
  list.innerHTML = '';
  const activities = state.currentCard?.activities || [];
  for (const a of activities) {
    const isIn = a.direction === 'in';
    const isOut = a.direction === 'out';
    const isMsg = a.type === 'message_in' || a.type === 'message_out';
    if (!isMsg) {
      // System/stage_change — render as centered system line
      list.append(el('div', { class: 'msg system' }, `• ${a.content || a.type} — ${fmtDate(a.createdAt)}`));
      continue;
    }
    const bubble = el('div', { class: `msg ${isIn ? 'in' : 'out'}` });
    if (a.mediaUrl && a.mediaType === 'image') {
      const imgEl = el('img', { loading: 'lazy' });
      bubble.append(el('div', { class: 'msg-media' }, imgEl));
      loadMediaWithAuth(a.mediaUrl, imgEl);
    } else if (a.mediaUrl && a.mediaType === 'audio') {
      const audioEl = el('audio', { controls: '' });
      bubble.append(el('div', { class: 'msg-media' }, audioEl));
      loadMediaWithAuth(a.mediaUrl, audioEl);
    } else if (a.mediaUrl && a.mediaType === 'video') {
      const videoEl = el('video', { controls: '' });
      bubble.append(el('div', { class: 'msg-media' }, videoEl));
      loadMediaWithAuth(a.mediaUrl, videoEl);
    } else if (a.mediaUrl && a.mediaType === 'document') {
      const docName = a.metadata?.savedFilename || 'Documento';
      const docLink = el('a', { class: 'doc', href: '#' }, '📄 ', docName);
      docLink.addEventListener('click', (e) => {
        e.preventDefault();
        downloadMediaWithAuth(a.mediaUrl, docName);
      });
      bubble.append(el('div', { class: 'msg-media' }, docLink));
    }
    // Onda 51: renderizar texto/caption SEM truncar — preserva
    // newlines via white-space:pre-wrap no CSS, e markdown WhatsApp
    // via renderTextHTML.
    if (a.content) {
      // Skip se for o label antigo "[Image]" — legado pre-Onda 51
      const isOldLabel = /^\[[A-Za-zÀ-ÿ]+\]$/.test(a.content) && a.mediaUrl;
      if (!isOldLabel) {
        const textLine = el('div', { class: 'msg-text' });
        textLine.innerHTML = renderTextHTML(a.content);
        bubble.append(textLine);
      }
    }
    bubble.append(el('div', { class: 'msg-meta' }, fmtDate(a.createdAt)));
    list.append(bubble);
  }
  list.scrollTop = list.scrollHeight;
}

function renderInfoTab() {
  const { card, contact } = state.currentCard;
  const sec = $('#infoSection');
  sec.innerHTML = '';
  sec.append(
    el('div', { class: 'field' }, el('label', {}, 'Título'), el('div', {}, card.title)),
    contact ? el('div', { class: 'field' }, el('label', {}, 'Contato'),
      el('div', {}, `${contact.name} (${contact.phone || '—'})`),
    ) : null,
    el('div', { class: 'field' }, el('label', {}, 'Valor'), el('div', {}, fmtMoney(card.valueCents))),
    el('div', { class: 'field' }, el('label', {}, 'Probabilidade'), el('div', {}, `${card.probability}%`)),
    card.dueDate ? el('div', { class: 'field' }, el('label', {}, 'Vencimento'),
      el('div', {}, new Date(card.dueDate).toLocaleDateString('pt-BR')),
    ) : null,
    (card.labels || []).length ? el('div', { class: 'field' },
      el('label', {}, 'Labels'),
      el('div', { class: 'card-labels' }, ...card.labels.map(l => el('span', { class: 'card-label' }, l))),
    ) : null,
    card.description ? el('div', { class: 'field' },
      el('label', {}, 'Descrição'),
      el('div', { style: 'white-space:pre-wrap;color:var(--text-2);font-size:13px' }, card.description),
    ) : null,
    el('hr', { style: 'border:0;border-top:1px solid var(--border);margin:14px 0' }),
    el('div', { style: 'display:flex;gap:8px' },
      el('button', {
        class: 'save-btn',
        style: 'background:transparent;border:1px solid var(--red);color:var(--red);flex:1',
        on: { click: async () => {
          if (!await confirmDialog('Apagar card', 'Essa ação não pode ser desfeita. O histórico de conversação permanece.', 'Apagar')) return;
          try {
            await api(`/cards/${card.id}`, { method: 'DELETE' });
            toast('Card removido', 'success');
            closeCardPanel();
            await loadPipeline(state.currentBoardId);
            renderKanban();
          } catch (e) { toast('Erro: ' + e.message, 'error'); }
        } },
      }, 'Apagar card'),
    ),
  );
}

function renderEditTab() {
  const { card } = state.currentCard;
  const sec = $('#editSection');
  sec.innerHTML = '';
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {
      title: fd.get('title'),
      valueCents: parseInt(fd.get('valueCents'), 10) || 0,
      probability: parseInt(fd.get('probability'), 10) || 0,
      description: fd.get('description') || null,
      dueDate: fd.get('dueDate') ? new Date(fd.get('dueDate')).getTime() : null,
      labels: (fd.get('labels') || '').split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      await api(`/cards/${card.id}`, { method: 'PATCH', body: patch });
      toast('Salvo', 'success');
      await refreshCurrentCard();
      renderEditTab();
      await loadPipeline(state.currentBoardId);
      renderKanban();
    } catch (e) { toast('Erro: ' + e.message, 'error'); }
  } } });
  form.append(
    field('Título', 'title', 'text', card.title),
    field('Valor (R$)', 'valueCents', 'number', card.valueCents, { step: '100', min: '0' }),
    field('Probabilidade (%)', 'probability', 'number', card.probability, { min: '0', max: '100' }),
    field('Vencimento', 'dueDate', 'datetime-local', card.dueDate ? new Date(card.dueDate).toISOString().slice(0, 16) : ''),
    field('Labels (vírgulas)', 'labels', 'text', (card.labels || []).join(', ')),
    fieldTextarea('Descrição', 'description', card.description || ''),
    el('button', { class: 'save-btn', type: 'submit' }, 'Salvar alterações'),
  );
  sec.append(form);
}

function field(label, name, type, value, extra = {}) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    el('input', { name, type, value: value ?? '', ...extra }),
  );
}
function fieldTextarea(label, name, value) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    el('textarea', { name, rows: '4' }, value),
  );
}

// ─── Composer (send) ───────────────────────────────────────────────────
async function sendCurrentMessage(text, mediaUrl, mediaType, mediaFilename) {
  const card = state.currentCard?.card;
  if (!card) return;
  const channelId = $('#sendChannelSelect').value;
  if (!channelId) return toast('Configure um canal WhatsApp primeiro', 'error');
  const contact = state.currentCard.contact;
  if (!contact?.phone) return toast('Contato sem telefone', 'error');
  try {
    await api(`/channels/${channelId}/send`, { method: 'POST', body: {
      to: contact.phone, text, mediaUrl, mediaType, mediaFilename, cardId: card.id, contactId: contact.id,
    } });
    $('#composerText').value = '';
    await refreshCurrentCard();
  } catch (e) {
    toast('Erro ao enviar: ' + e.message, 'error');
  }
}

async function uploadAndSendFile(file) {
  // Upload to media endpoint, then send with returned URL
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/media/upload', { method: 'POST', body: fd });
    const mt = file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('audio/') ? 'audio'
      : file.type.startsWith('video/') ? 'video' : 'document';
    await sendCurrentMessage($('#composerText').value || undefined, r.url, mt, file.name);
  } catch (e) {
    toast('Upload falhou: ' + e.message, 'error');
  }
}

// Audio recording via MediaRecorder
let mediaRecorder = null;
let recordedChunks = [];
let recordedStream = null;

function pickAudioMime() {
  if (!window.MediaRecorder) return null;
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return ''; // browser picks default
}

async function toggleRecording() {
  const btn = $('#recordBtn');
  if (!btn) return;

  // Stop if already recording
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch (e) {}
    btn.classList.remove('recording');
    return;
  }

  // Browser support check
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return toast('Navegador não suporta gravação de áudio', 'error');
  }
  if (!window.MediaRecorder) {
    return toast('Navegador não tem MediaRecorder', 'error');
  }

  // Secure context check (mic requires HTTPS or localhost)
  if (!window.isSecureContext) {
    return toast('Microfone só funciona via HTTPS', 'error');
  }

  try {
    recordedStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    let msg = 'Microfone bloqueado';
    if (e.name === 'NotAllowedError') msg = 'Você precisa permitir o microfone no navegador (cadeado na barra de endereço → Site settings → Microfone)';
    else if (e.name === 'NotFoundError') msg = 'Nenhum microfone detectado no dispositivo';
    else if (e.name === 'NotReadableError') msg = 'Microfone está em uso por outro app';
    else if (e.message) msg = msg + ': ' + e.message;
    return toast(msg, 'error');
  }

  const mime = pickAudioMime();
  try {
    mediaRecorder = mime ? new MediaRecorder(recordedStream, { mimeType: mime }) : new MediaRecorder(recordedStream);
  } catch (e) {
    recordedStream.getTracks().forEach(t => t.stop());
    return toast('Erro ao iniciar gravador: ' + (e.message || e.name), 'error');
  }

  recordedChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onerror = (e) => {
    toast('Erro na gravação: ' + (e.error?.name || 'desconhecido'), 'error');
    btn.classList.remove('recording');
    if (recordedStream) recordedStream.getTracks().forEach(t => t.stop());
  };
  mediaRecorder.onstop = async () => {
    try {
      if (recordedStream) recordedStream.getTracks().forEach(t => t.stop());
      if (recordedChunks.length === 0) {
        return toast('Gravação vazia (segura o botão alguns segundos)', 'error');
      }
      const finalMime = mediaRecorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(recordedChunks, { type: finalMime });
      const ext = finalMime.includes('ogg') ? 'ogg' : finalMime.includes('mp4') ? 'm4a' : 'webm';
      const file = new File([blob], 'audio-' + Date.now() + '.' + ext, { type: finalMime });
      await uploadAndSendFile(file);
      toast('Áudio enviado', 'success');
    } catch (e) {
      toast('Erro ao processar áudio: ' + (e.message || ''), 'error');
    }
  };

  try {
    mediaRecorder.start();
    btn.classList.add('recording');
    toast('Gravando... clique de novo pra parar', '');
  } catch (e) {
    toast('Não pude iniciar: ' + (e.message || e.name), 'error');
    if (recordedStream) recordedStream.getTracks().forEach(t => t.stop());
  }
}

// ─── New card modal ────────────────────────────────────────────────────
async function openNewCardModal(columnId = null) {
  const contacts = state.contacts.length ? state.contacts : (await loadContacts(), state.contacts);
  const backdrop = el('div', { class: 'modal-backdrop' });
  const columns = state.pipeline?.columns || [];
  const col0 = columnId || columns[0]?.id;
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const contactMode = fd.get('contactMode');
    let contactId = fd.get('existingContactId');
    if (contactMode === 'new' && fd.get('newName')) {
      const c = await api('/contacts', { method: 'POST', body: {
        name: fd.get('newName'), phone: fd.get('newPhone') || null,
      } });
      contactId = c.contact.id;
    }
    try {
      await api('/cards', { method: 'POST', body: {
        boardId: state.currentBoardId,
        columnId: fd.get('columnId'),
        title: fd.get('title'),
        contactId: contactId || null,
        valueCents: parseInt(fd.get('valueCents'), 10) || 0,
        probability: parseInt(fd.get('probability'), 10) || 50,
      } });
      backdrop.remove();
      await loadPipeline(state.currentBoardId);
      renderKanban();
      toast('Card criado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } },
    field('Título', 'title', 'text', '', { required: true, placeholder: 'Ex: Interessado no plano Pro' }),
    el('div', { class: 'field' },
      el('label', {}, 'Coluna'),
      (() => {
        const sel = el('select', { name: 'columnId', required: true });
        for (const col of columns) {
          sel.append(el('option', { value: col.id, selected: col.id === col0 ? '' : null }, col.name));
        }
        return sel;
      })(),
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Contato'),
      el('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:8px' },
        el('label', { style: 'font-size:12px' },
          el('input', { type: 'radio', name: 'contactMode', value: 'existing', checked: '' }), ' Existente',
        ),
        el('label', { style: 'font-size:12px' },
          el('input', { type: 'radio', name: 'contactMode', value: 'new' }), ' Novo',
        ),
        el('label', { style: 'font-size:12px' },
          el('input', { type: 'radio', name: 'contactMode', value: 'none' }), ' Sem contato',
        ),
      ),
      (() => {
        const sel = el('select', { name: 'existingContactId' },
          el('option', { value: '' }, 'Selecione...'),
          ...contacts.map(c => el('option', { value: c.id }, `${c.name}${c.phone ? ' (' + c.phone + ')' : ''}`)),
        );
        return sel;
      })(),
      el('input', { name: 'newName', type: 'text', placeholder: 'Nome do novo contato', style: 'margin-top:6px' }),
      el('input', { name: 'newPhone', type: 'tel', placeholder: 'Telefone (opcional)', style: 'margin-top:6px' }),
    ),
    el('div', { style: 'display:flex;gap:10px' },
      field('Valor (R$)', 'valueCents', 'number', '0', { step: '100', style: 'flex:1' }),
      field('Prob (%)', 'probability', 'number', '50', { min: '0', max: '100', style: 'flex:1' }),
    ),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Criar card'),
    ),
  );
  const modal = el('div', { class: 'modal' }, el('h3', {}, 'Novo card'), form);
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

// ─── Views: Contacts / Channels / Agents / Inventory / Stats ──────────
async function showView(viewName) {
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === viewName));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === viewName));
  if (viewName === 'kanban') {
    await loadPipeline(state.currentBoardId);
    renderKanban();
  } else if (viewName === 'contacts') { await loadContacts(); renderContactsList(); }
  else if (viewName === 'channels') { await loadChannels(); renderChannelsList(); }
  else if (viewName === 'agents') { await loadAgents(); renderAgentsList(); }
  else if (viewName === 'inventory') { await loadInventory(); renderInventoryList(); }
  else if (viewName === 'stats') renderStats();
  else if (viewName === 'tasks') { await renderTasksView(); }
  else if (viewName === 'agenda') { await renderAgendaView(); }
  else if (viewName === 'documents') { await renderDocumentsView(); }
  else if (viewName === 'forms') { await renderFormsView(); }
  else if (viewName === 'campaigns') { await renderCampaignsView(); }
}

// ═══ ONDA 35-36: NEW VIEWS (interactivo) ═══════════════════════════════

// ─── Helpers comuns ────────────────────────────────────────────────────
function openModal({ title, bodyEl, width = '480px' }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: `max-width:${width}` });
  const head = el('div', { class: 'modal-head', style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' },
    el('h3', { style: 'margin:0' }, title),
    el('button', { class: 'close-modal', style: 'background:transparent;border:0;color:var(--text-dim);font-size:24px;cursor:pointer;padding:0 4px;line-height:1', on: { click: () => backdrop.remove() } }, '×'),
  );
  modal.append(head, bodyEl);
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.addEventListener('keydown', function escListen(e) {
    if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escListen); }
  });
  document.body.append(backdrop);
  return { backdrop, modal };
}

function showContextMenu(evt, items) {
  evt.preventDefault();
  const old = document.querySelector('.ctx-menu');
  if (old) old.remove();
  const menu = el('div', { class: 'ctx-menu', style: `position:fixed;top:${evt.clientY}px;left:${evt.clientX}px;background:var(--bg-2);border:1px solid var(--border-2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:10001;min-width:180px;padding:6px 0;` });
  for (const it of items) {
    if (it === '-') {
      menu.append(el('div', { style: 'height:1px;background:var(--border);margin:4px 0' }));
      continue;
    }
    const item = el('button', { style: `display:block;width:100%;text-align:left;padding:8px 14px;background:transparent;border:0;color:${it.danger ? '#ef4444' : 'var(--text)'};cursor:pointer;font-size:13px;font-family:inherit`, on: {
      click: () => { menu.remove(); it.action(); },
      mouseenter: (e) => e.target.style.background = 'var(--bg-3)',
      mouseleave: (e) => e.target.style.background = 'transparent',
    } }, it.label);
    menu.append(item);
  }
  document.body.append(menu);
  // Close on click elsewhere
  setTimeout(() => {
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 50);
}

async function authenticatedDownload(path, filename) {
  try {
    const r = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${state.apiKey}` } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

function copyTextDialog(label, text) {
  const body = el('div', {},
    el('p', { style: 'color:var(--text-dim);font-size:13px;margin-bottom:10px' }, label),
    el('input', { type: 'text', value: text, readonly: '', style: 'width:100%;padding:10px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:monospace;font-size:12px;margin-bottom:12px', on: { click: (e) => e.target.select() } }),
    el('button', {
      style: 'width:100%;padding:10px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600',
      on: { click: async () => {
        try { await navigator.clipboard.writeText(text); toast('Copiado!', 'success'); }
        catch { toast('Selecione e Ctrl+C', 'info'); }
      } },
    }, '📋 Copiar'),
  );
  openModal({ title: 'Link', bodyEl: body });
}

function inputField(name, label, opts = {}) {
  const wrap = el('div', { style: 'margin-bottom:10px' });
  wrap.append(el('label', { style: 'display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px' }, label));
  const input = el(opts.tag || 'input', {
    name, ...(opts.attrs || {}),
    style: 'width:100%;padding:10px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:6px;box-sizing:border-box;font-family:inherit;font-size:14px',
  });
  if (opts.value !== undefined) input.value = opts.value;
  if (opts.required) input.required = true;
  wrap.append(input);
  return wrap;
}

function selectField(name, label, options, currentValue) {
  const wrap = el('div', { style: 'margin-bottom:10px' });
  wrap.append(el('label', { style: 'display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px' }, label));
  const sel = el('select', { name, style: 'width:100%;padding:10px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:6px;box-sizing:border-box;font-family:inherit;font-size:14px' });
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (o.value === currentValue) opt.selected = true;
    sel.append(opt);
  }
  wrap.append(sel);
  return wrap;
}

// ───────────────────────────────────────────────────────────────────────
// TAREFAS
// ───────────────────────────────────────────────────────────────────────
async function renderTasksView() {
  try {
    const stats = await api('/tasks/stats');
    const s = stats.stats;
    const statsEl = $('#tasksStats');
    if (statsEl) {
      statsEl.innerHTML = '';
      for (const [label, val, color] of [
        ['Abertas', s.open, 'var(--blue)'],
        ['Atrasadas', s.overdue, '#EF4444'],
        ['Hoje', s.dueToday, 'var(--amber)'],
        ['Esta semana', s.dueThisWeek, 'var(--purple)'],
        ['Concluídas 7d', s.completedLast7d, 'var(--green)'],
      ]) {
        statsEl.append(el('div', { style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:12px' },
          el('div', { style: 'font-size:11px;color:var(--text-dim);text-transform:uppercase' }, label),
          el('div', { style: `font-size:22px;font-weight:700;color:${color}` }, String(val)),
        ));
      }
    }

    const view = $('#tasksFilterView')?.value || 'all';
    const priority = $('#tasksFilterPriority')?.value || '';
    const q = [];
    if (view === 'overdue') q.push('view=overdue');
    else if (view === 'upcoming') q.push('view=upcoming');
    else if (view === 'completed') q.push('status=completed');
    if (priority) q.push('priority=' + priority);

    const data = await api('/tasks' + (q.length ? '?' + q.join('&') : ''));
    const l = $('#tasksList');
    l.innerHTML = '';
    if (!data.tasks || data.tasks.length === 0) {
      l.append(el('div', { style: 'padding:40px;text-align:center;color:var(--text-dim)' }, 'Nenhuma tarefa'));
      return;
    }
    for (const t of data.tasks) {
      const priorityColor = { urgent: '#DC2626', high: '#F97316', med: '#F59E0B', low: '#64748B' }[t.priority] || '#64748B';
      const typeIcon = { call: '📞', email: '✉️', meeting: '👥', followup: '🔄', other: '📌' }[t.type] || '📌';
      const dueStr = t.dueAt ? new Date(t.dueAt).toLocaleString('pt-BR') : 'Sem prazo';
      const overdue = t.dueAt && t.dueAt < Date.now() && t.status === 'open';
      const row = el('div', {
        style: `background:var(--bg-2);border:1px solid var(--border);border-left:4px solid ${priorityColor};border-radius:8px;padding:14px;margin-bottom:8px;display:flex;gap:14px;align-items:center;cursor:pointer` + (t.status === 'completed' ? ';opacity:.5' : ''),
        on: {
          click: (e) => {
            if (e.target.closest('button')) return;
            openTaskEditModal(t);
          },
          contextmenu: (e) => showContextMenu(e, [
            { label: '✏️ Editar', action: () => openTaskEditModal(t) },
            ...(t.status === 'open' ? [{ label: '✓ Concluir', action: async () => { await api(`/tasks/${t.id}/complete`, { method: 'POST', body: {} }); renderTasksView(); } }] : []),
            { label: '📋 Duplicar', action: async () => {
              const clone = { ...t, title: t.title + ' (copia)', id: undefined, dueAt: t.dueAt };
              delete clone.id; delete clone.createdAt; delete clone.updatedAt;
              await api('/tasks', { method: 'POST', body: clone }); renderTasksView();
            } },
            '-',
            { label: '🗑️ Deletar', danger: true, action: async () => {
              if (!confirm('Deletar tarefa?')) return;
              await api(`/tasks/${t.id}`, { method: 'DELETE' }); renderTasksView();
            } },
          ]),
        },
      },
        el('div', { style: 'font-size:22px' }, typeIcon),
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { style: 'font-weight:600;margin-bottom:2px' + (t.status === 'completed' ? ';text-decoration:line-through' : '') }, t.title),
          el('div', { style: 'font-size:12px;color:var(--text-dim)' },
            `${t.priority} • ${t.type} • ${dueStr}` + (overdue ? ' ⚠️ ATRASADA' : '')),
        ),
        t.status === 'open' ? el('button', {
          style: 'background:var(--green);color:#fff;border:0;padding:6px 14px;border-radius:6px;cursor:pointer',
          on: { click: async () => {
            await api(`/tasks/${t.id}/complete`, { method: 'POST', body: {} });
            renderTasksView();
          } },
        }, '✓ Concluir') : null,
      );
      l.append(row);
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

function openTaskEditModal(task) {
  const isNew = !task;
  task = task || {};
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const due = fd.get('dueAt') ? new Date(fd.get('dueAt')).getTime() : null;
    const body = {
      title: fd.get('title'), type: fd.get('type'), priority: fd.get('priority'),
      dueAt: due, description: fd.get('description'),
      alertMinutesBefore: fd.get('alert') ? Number(fd.get('alert')) : null,
    };
    try {
      if (isNew) await api('/tasks', { method: 'POST', body });
      else await api(`/tasks/${task.id}`, { method: 'PATCH', body });
      backdrop.remove();
      renderTasksView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });

  const dueDateLocal = task.dueAt ? new Date(task.dueAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

  form.append(
    inputField('title', 'Título *', { required: true, value: task.title || '' }),
    selectField('type', 'Tipo', [
      { value: 'call', label: '📞 Ligação' },
      { value: 'email', label: '✉️ Email' },
      { value: 'meeting', label: '👥 Reunião' },
      { value: 'followup', label: '🔄 Follow-up' },
      { value: 'other', label: '📌 Outro' },
    ], task.type || 'other'),
    selectField('priority', 'Prioridade', [
      { value: 'urgent', label: '🔴 Urgente' },
      { value: 'high', label: '🟠 Alta' },
      { value: 'med', label: '🟡 Média' },
      { value: 'low', label: '⚪ Baixa' },
    ], task.priority || 'med'),
    inputField('dueAt', 'Prazo', { attrs: { type: 'datetime-local' }, value: dueDateLocal }),
    inputField('alert', 'Alerta (min antes)', { attrs: { type: 'number', placeholder: '30' }, value: task.alertMinutesBefore || '' }),
    inputField('description', 'Descrição', { tag: 'textarea', attrs: { rows: 3 }, value: task.description || '' }),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;margin-top:8px' }, isNew ? 'Criar' : 'Salvar'),
  );

  const { backdrop } = openModal({ title: isNew ? 'Nova Tarefa' : 'Editar Tarefa', bodyEl: form });
}

// ───────────────────────────────────────────────────────────────────────
// AGENDA
// ───────────────────────────────────────────────────────────────────────
async function renderAgendaView() {
  try {
    const from = Date.now();
    const to = from + 30 * 86400000;
    const data = await api(`/appointments?from=${from}&to=${to}`);
    const container = $('#agendaUpcoming');
    container.innerHTML = '';
    if (!data.appointments || data.appointments.length === 0) {
      container.append(el('div', { style: 'padding:40px;text-align:center;color:var(--text-dim)' }, 'Nenhum compromisso nos próximos 30 dias. Crie um!'));
      return;
    }
    for (const a of data.appointments) {
      const when = new Date(a.startsAt);
      const row = el('div', {
        style: 'background:var(--bg-2);border:1px solid var(--border);border-left:4px solid var(--purple);border-radius:8px;padding:16px;margin-bottom:10px;cursor:pointer',
        on: {
          click: (e) => { if (e.target.closest('a')) return; openAppointmentEditModal(a); },
          contextmenu: (e) => showContextMenu(e, [
            { label: '✏️ Editar', action: () => openAppointmentEditModal(a) },
            { label: '✅ Marcar concluído', action: async () => { await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: 'completed' } }); renderAgendaView(); } },
            { label: '❌ Cancelar', action: async () => { await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: 'cancelled' } }); renderAgendaView(); } },
            '-',
            { label: '🗑️ Deletar', danger: true, action: async () => {
              if (!confirm('Deletar compromisso?')) return;
              await api(`/appointments/${a.id}`, { method: 'DELETE' }); renderAgendaView();
            } },
          ]),
        },
      },
        el('div', { style: 'display:flex;gap:16px;align-items:flex-start' },
          el('div', { style: 'text-align:center;background:var(--purple);color:#fff;padding:10px 14px;border-radius:8px;min-width:70px' },
            el('div', { style: 'font-size:11px;text-transform:uppercase;opacity:.8' }, when.toLocaleDateString('pt-BR', { month: 'short' })),
            el('div', { style: 'font-size:24px;font-weight:700' }, String(when.getDate())),
            el('div', { style: 'font-size:11px;opacity:.8' }, when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })),
          ),
          el('div', { style: 'flex:1' },
            el('div', { style: 'font-weight:600;font-size:16px;margin-bottom:4px' }, a.title),
            a.description ? el('div', { style: 'color:var(--text-dim);font-size:13px;margin-bottom:6px' }, a.description) : null,
            el('div', { style: 'font-size:12px;color:var(--text-dim)' },
              `Status: ${a.status}` + (a.meetingUrl ? ` • ` : ''),
              a.meetingUrl ? el('a', { href: a.meetingUrl, target: '_blank', style: 'color:var(--purple)' }, 'Link da reunião') : null,
            ),
          ),
        ),
      );
      container.append(row);
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

function openAppointmentEditModal(appt) {
  const isNew = !appt;
  appt = appt || {};
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const startsAt = fd.get('startsAt') ? new Date(fd.get('startsAt')).getTime() : null;
    const durMin = Number(fd.get('duration') || 60);
    const body = {
      title: fd.get('title'), description: fd.get('description'),
      startsAt, endsAt: startsAt + durMin * 60000,
      meetingUrl: fd.get('meetingUrl'), location: fd.get('location'),
      reminderMinutes: fd.get('reminder') ? Number(fd.get('reminder')) : 30,
    };
    try {
      if (isNew) await api('/appointments', { method: 'POST', body });
      else await api(`/appointments/${appt.id}`, { method: 'PATCH', body });
      backdrop.remove();
      renderAgendaView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });

  const startLocal = appt.startsAt ? new Date(appt.startsAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  const dur = appt.startsAt && appt.endsAt ? Math.round((appt.endsAt - appt.startsAt) / 60000) : 60;

  form.append(
    inputField('title', 'Título *', { required: true, value: appt.title || '' }),
    inputField('startsAt', 'Início *', { attrs: { type: 'datetime-local', required: true }, value: startLocal }),
    inputField('duration', 'Duração (minutos)', { attrs: { type: 'number', placeholder: '60' }, value: dur }),
    inputField('meetingUrl', 'Link da reunião (Meet/Zoom)', { value: appt.meetingUrl || '' }),
    inputField('location', 'Local', { value: appt.location || '' }),
    inputField('reminder', 'Lembrete (min antes)', { attrs: { type: 'number', placeholder: '30' }, value: appt.reminderMinutes || 30 }),
    inputField('description', 'Descrição', { tag: 'textarea', attrs: { rows: 3 }, value: appt.description || '' }),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;margin-top:8px' }, isNew ? 'Criar' : 'Salvar'),
  );

  const { backdrop } = openModal({ title: isNew ? 'Novo Compromisso' : 'Editar Compromisso', bodyEl: form });
}

async function openSchedulingLinksModal() {
  let links = [];
  try { links = (await api('/scheduling-links')).links || []; }
  catch (e) { toast('Erro: ' + e.message, 'error'); return; }

  const list = el('div', { style: 'max-height:300px;overflow:auto;margin-bottom:14px' });
  const renderList = () => {
    list.innerHTML = '';
    if (!links.length) { list.append(el('div', { style: 'color:var(--text-dim);padding:20px;text-align:center' }, 'Nenhum link de agendamento')); return; }
    for (const lk of links) {
      const url = `${location.origin}/p/book/${lk.slug}`;
      list.append(el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:6px' },
        el('div', { style: 'font-weight:600;margin-bottom:4px' }, lk.title),
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:6px' }, `${lk.durationMinutes}min • ${lk.totalBookings || 0} agendamentos`),
        el('div', { style: 'display:flex;gap:6px' },
          el('button', { style: 'flex:1;padding:6px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:4px;cursor:pointer;font-size:11px', on: { click: () => copyTextDialog('URL pública:', url) } }, '🔗 Link'),
          el('button', { style: 'padding:6px 10px;background:transparent;border:1px solid #ef4444;color:#ef4444;border-radius:4px;cursor:pointer;font-size:11px', on: { click: async () => {
            if (!confirm('Deletar?')) return;
            await api(`/scheduling-links/${lk.id}`, { method: 'DELETE' });
            links = links.filter(x => x.id !== lk.id); renderList();
          } } }, '🗑️'),
        ),
      ));
    }
  };

  const form = el('form', { style: 'border-top:1px solid var(--border);padding-top:14px', on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await api('/scheduling-links', { method: 'POST', body: {
        title: fd.get('title'),
        durationMinutes: Number(fd.get('duration')),
        availability: { weekdays: { 1: ['09:00-12:00','14:00-18:00'], 2: ['09:00-12:00','14:00-18:00'], 3: ['09:00-12:00','14:00-18:00'], 4: ['09:00-12:00','14:00-18:00'], 5: ['09:00-12:00','14:00-18:00'] } },
      } });
      links.unshift(r.link); renderList(); form.reset();
      toast('Link criado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    el('h4', { style: 'margin:0 0 8px;font-size:13px;color:var(--text-dim)' }, 'Novo link'),
    inputField('title', 'Título', { required: true, attrs: { placeholder: 'Ex: 30 min com Daniel' } }),
    inputField('duration', 'Duração (min)', { attrs: { type: 'number', placeholder: '30', required: true } }),
    el('button', { type: 'submit', style: 'width:100%;padding:10px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600' }, 'Criar Link'),
  );

  const body = el('div', {});
  body.append(list, form);
  openModal({ title: 'Links de Agendamento', bodyEl: body, width: '560px' });
  renderList();
}

async function showIcsFeed() {
  try {
    const r = await api('/calendar/ics-url');
    copyTextDialog('Adicione esta URL no seu Google Calendar / Outlook / Apple Calendar:', r.url);
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

// ───────────────────────────────────────────────────────────────────────
// DOCUMENTOS
// ───────────────────────────────────────────────────────────────────────
async function renderDocumentsView() {
  try {
    const status = $('#docsFilterStatus')?.value;
    const data = await api('/documents' + (status ? '?status=' + status : ''));
    const l = $('#documentsList');
    l.innerHTML = '';
    if (!data.documents || data.documents.length === 0) {
      l.append(el('div', { style: 'padding:40px;text-align:center;color:var(--text-dim)' }, 'Nenhum documento. Crie um template e gere seu primeiro documento.'));
      return;
    }
    for (const d of data.documents) {
      const statusColor = { draft: '#64748B', sent: '#3B82F6', viewed: '#F59E0B', signed: '#10B981', cancelled: '#EF4444' }[d.status] || '#64748B';
      const row = el('div', {
        style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px;display:flex;gap:14px;align-items:center;cursor:pointer',
        on: {
          click: (e) => { if (e.target.closest('button')) return; openDocumentEditModal(d); },
          contextmenu: (e) => showContextMenu(e, [
            { label: '✏️ Editar', action: () => openDocumentEditModal(d) },
            { label: '🔗 Copiar link público', action: async () => {
              const r = await api(`/documents/${d.id}/public-link`);
              copyTextDialog('Link público (válido até ser revogado):', r.url);
            } },
            { label: '📄 Baixar PDF', action: () => authenticatedDownload(`/documents/${d.id}/pdf`, `${d.title}-v${d.version}.pdf`) },
            { label: '📋 Clonar como nova versão', action: async () => {
              await api(`/documents/${d.id}/clone`, { method: 'POST' }); renderDocumentsView();
            } },
            '-',
            { label: '🗑️ Deletar', danger: true, action: async () => {
              if (!confirm('Deletar?')) return;
              await api(`/documents/${d.id}`, { method: 'DELETE' }); renderDocumentsView();
            } },
          ]),
        },
      },
        el('div', { style: `background:${statusColor}20;color:${statusColor};padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase` }, d.status),
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { style: 'font-weight:600' }, d.title + ' v' + d.version),
          el('div', { style: 'font-size:12px;color:var(--text-dim)' },
            `${d.viewedCount || 0} views • ${new Date(d.createdAt).toLocaleDateString('pt-BR')}` +
            (d.signedAt ? ` • Assinado por ${d.signedBy}` : '')),
        ),
        el('button', {
          style: 'background:var(--bg-1);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;cursor:pointer',
          on: { click: async () => {
            const r = await api(`/documents/${d.id}/public-link`);
            copyTextDialog('Link público (cliente abre, lê e assina aqui):', r.url);
          } },
        }, '🔗 Link'),
        el('button', {
          style: 'background:var(--purple);color:#fff;border:0;padding:6px 12px;border-radius:6px;cursor:pointer',
          on: { click: () => authenticatedDownload(`/documents/${d.id}/pdf`, `${d.title}-v${d.version}.pdf`) },
        }, 'PDF'),
      );
      l.append(row);
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

async function openDocumentEditModal(doc) {
  const isNew = !doc;
  let templates = [];
  try { templates = (await api('/document-templates')).templates || []; } catch {}
  doc = doc || {};

  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const variables = {};
    for (const [k, v] of fd.entries()) {
      if (k.startsWith('var_')) variables[k.slice(4)] = v;
    }
    const body = {
      title: fd.get('title'),
      bodyHtml: fd.get('bodyHtml'),
      templateId: fd.get('templateId') || undefined,
      variables,
    };
    try {
      if (isNew) await api('/documents', { method: 'POST', body });
      else await api(`/documents/${doc.id}`, { method: 'PATCH', body });
      backdrop.remove(); renderDocumentsView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });

  form.append(
    inputField('title', 'Título *', { required: true, value: doc.title || '' }),
    selectField('templateId', 'Usar template (opcional)', [
      { value: '', label: '— Sem template —' },
      ...templates.map(t => ({ value: t.id, label: `${t.kind}: ${t.name}` })),
    ], doc.templateId || ''),
    inputField('bodyHtml', 'Conteúdo HTML', { tag: 'textarea', attrs: { rows: 10, placeholder: '<h2>Contrato</h2><p>...</p>' }, value: doc.bodyHtml || '' }),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;margin-top:8px' }, isNew ? 'Criar Documento' : 'Salvar'),
  );

  const { backdrop } = openModal({ title: isNew ? 'Novo Documento' : doc.title + ' v' + doc.version, bodyEl: form, width: '640px' });
}

async function openDocTemplateModal() {
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/document-templates', { method: 'POST', body: {
        name: fd.get('name'), kind: fd.get('kind'), bodyHtml: fd.get('bodyHtml'),
      } });
      backdrop.remove(); toast('Template criado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('name', 'Nome *', { required: true, attrs: { placeholder: 'Contrato Padrão' } }),
    selectField('kind', 'Tipo', [
      { value: 'contract', label: 'Contrato' },
      { value: 'nda', label: 'NDA' },
      { value: 'proposal', label: 'Proposta' },
      { value: 'sow', label: 'SOW' },
      { value: 'custom', label: 'Outro' },
    ], 'contract'),
    inputField('bodyHtml', 'HTML *', { tag: 'textarea', required: true, attrs: { rows: 10, placeholder: '<h2>{{client_name}}</h2><p>...</p>' } }),
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin:-6px 0 10px' }, 'Use {{placeholder}} para variáveis. Exemplo: {{client_name}}, {{amount}}'),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Criar Template'),
  );
  const { backdrop } = openModal({ title: 'Novo Template', bodyEl: form, width: '600px' });
}

// ───────────────────────────────────────────────────────────────────────
// FORMULÁRIOS
// ───────────────────────────────────────────────────────────────────────
async function renderFormsView() {
  try {
    const formsData = await api('/forms');
    const hooksData = await api('/webhooks');
    const l = $('#formsList');
    l.innerHTML = '';

    l.append(el('h3', { style: 'margin:0 0 12px;color:var(--text)' }, 'Formulários'));
    if (!formsData.forms || formsData.forms.length === 0) {
      l.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim);background:var(--bg-2);border-radius:8px;margin-bottom:20px' }, 'Nenhum formulário ainda'));
    } else {
      for (const f of formsData.forms) {
        const origin = location.origin;
        const embedUrl = `${origin}/p/forms/${f.slug}/embed.js`;
        const hostedUrl = `${origin}/p/forms/${f.slug}`;
        const snippet = `<script src="${embedUrl}" data-target="#clow-form"></` + `script>`;
        const row = el('div', {
          style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px;cursor:pointer',
          on: {
            click: (e) => { if (e.target.closest('button') || e.target.closest('code')) return; openFormEditModal(f); },
            contextmenu: (e) => showContextMenu(e, [
              { label: '✏️ Editar', action: () => openFormEditModal(f) },
              { label: '🔗 Abrir página hospedada', action: () => window.open(hostedUrl, '_blank') },
              { label: '📋 Copiar embed', action: () => copyTextDialog('Cole no HTML do seu site:', snippet) },
              { label: '📋 Copiar URL hospedada', action: () => copyTextDialog('URL pública:', hostedUrl) },
              { label: '📊 Ver submissões', action: async () => {
                const r = await api(`/forms/${f.id}/submissions`);
                openSubmissionsModal(f, r.submissions || []);
              } },
              '-',
              { label: '🗑️ Deletar', danger: true, action: async () => {
                if (!confirm('Deletar formulário?')) return;
                await api(`/forms/${f.id}`, { method: 'DELETE' }); renderFormsView();
              } },
            ]),
          },
        },
          el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:8px' },
            el('div', { style: 'flex:1' },
              el('div', { style: 'font-weight:600' }, f.name),
              el('div', { style: 'font-size:12px;color:var(--text-dim)' },
                `${f.totalSubmissions || 0} submissões • slug: ${f.slug}`),
            ),
            el('button', {
              style: 'background:var(--bg-1);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;cursor:pointer',
              on: { click: () => window.open(hostedUrl, '_blank') },
            }, '🔗 Abrir'),
            el('button', {
              style: 'background:var(--purple);color:#fff;border:0;padding:6px 12px;border-radius:6px;cursor:pointer',
              on: { click: () => copyTextDialog('Cole no HTML do seu site:', snippet) },
            }, '📋 Embed'),
          ),
          el('code', { style: 'font-size:11px;color:var(--text-dim);background:var(--bg-1);padding:4px 8px;border-radius:4px;display:block;word-break:break-all' }, snippet),
        );
        l.append(row);
      }
    }

    l.append(el('h3', { style: 'margin:24px 0 12px;color:var(--text)' }, 'Webhooks (Zapier / Make / n8n)'));
    if (!hooksData.webhooks || hooksData.webhooks.length === 0) {
      l.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim);background:var(--bg-2);border-radius:8px' }, 'Nenhum webhook'));
    } else {
      for (const h of hooksData.webhooks) {
        const hookUrl = `${location.origin}/p/hooks/${h.hookKey}`;
        l.append(el('div', {
          style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px;cursor:pointer',
          on: {
            click: (e) => { if (e.target.closest('button') || e.target.closest('code')) return; copyTextDialog('Cole esta URL no Zapier/Make/n8n:', hookUrl); },
            contextmenu: (e) => showContextMenu(e, [
              { label: '🔗 Copiar URL', action: () => copyTextDialog('URL:', hookUrl) },
              { label: h.enabled ? '⏸️ Desabilitar' : '▶️ Habilitar', action: async () => {
                await api(`/webhooks/${h.id}/toggle`, { method: 'POST', body: { enabled: !h.enabled } }); renderFormsView();
              } },
              '-',
              { label: '🗑️ Deletar', danger: true, action: async () => {
                if (!confirm('Deletar webhook?')) return;
                await api(`/webhooks/${h.id}`, { method: 'DELETE' }); renderFormsView();
              } },
            ]),
          },
        },
          el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' },
            el('div', { style: 'font-weight:600' }, h.name),
            el('span', { style: `padding:3px 10px;border-radius:12px;font-size:11px;background:${h.enabled ? '#10B98120' : '#64748B20'};color:${h.enabled ? '#10B981' : '#64748B'}` }, h.enabled ? 'ATIVO' : 'INATIVO'),
          ),
          el('code', { style: 'font-size:11px;color:var(--text-dim);background:var(--bg-1);padding:6px 10px;border-radius:4px;display:block;word-break:break-all' }, hookUrl),
          el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:6px' }, `${h.totalReceived || 0} recebidos`),
        ));
      }
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

function openFormEditModal(form) {
  const isNew = !form;
  form = form || { fields: [], mapping: {} };
  const fieldsContainer = el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px' });
  const fields = JSON.parse(JSON.stringify(form.fields || []));

  const renderFields = () => {
    fieldsContainer.innerHTML = '';
    fieldsContainer.append(el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:8px' }, 'Campos do formulário:'));
    fields.forEach((f, i) => {
      fieldsContainer.append(el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px' },
        el('input', { value: f.name, placeholder: 'name', style: 'flex:1;padding:6px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:12px', on: { input: (e) => fields[i].name = e.target.value } }),
        el('input', { value: f.label, placeholder: 'Label', style: 'flex:1;padding:6px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:12px', on: { input: (e) => fields[i].label = e.target.value } }),
        (() => { const s = el('select', { style: 'padding:6px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:12px', on: { change: (e) => fields[i].type = e.target.value } });
          for (const t of ['text','email','phone','textarea','select','number']) {
            const o = el('option', { value: t }, t);
            if (f.type === t) o.selected = true;
            s.append(o);
          }
          return s; })(),
        el('button', { type: 'button', style: 'background:transparent;border:1px solid #ef4444;color:#ef4444;padding:4px 8px;border-radius:4px;cursor:pointer', on: { click: () => { fields.splice(i, 1); renderFields(); } } }, '×'),
      ));
    });
    fieldsContainer.append(el('button', { type: 'button', style: 'background:var(--bg-1);border:1px dashed var(--border);color:var(--text-dim);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;width:100%;margin-top:4px', on: { click: () => { fields.push({ name: 'field_' + Date.now(), label: 'Novo campo', type: 'text' }); renderFields(); } } }, '+ Adicionar campo'));
  };
  renderFields();

  const formEl = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(formEl);
    const mapping = {};
    for (const f of fields) {
      mapping[f.name] = `contact.customFields.${f.name}`;
    }
    // common defaults if user named these
    if (fields.find(f => f.name === 'name')) mapping['name'] = 'contact.name';
    if (fields.find(f => f.name === 'email')) mapping['email'] = 'contact.email';
    if (fields.find(f => f.name === 'phone')) mapping['phone'] = 'contact.phone';
    const body = {
      name: fd.get('name'), fields, mapping,
      defaultSource: fd.get('source') || 'form',
    };
    try {
      if (isNew) await api('/forms', { method: 'POST', body });
      else await api(`/forms/${form.id}`, { method: 'PATCH', body });
      backdrop.remove(); renderFormsView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  formEl.append(
    inputField('name', 'Nome *', { required: true, value: form.name || '' }),
    inputField('source', 'Fonte default', { value: form.defaultSource || 'form' }),
    fieldsContainer,
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;margin-top:8px' }, isNew ? 'Criar Formulário' : 'Salvar'),
  );

  const { backdrop } = openModal({ title: isNew ? 'Novo Formulário' : form.name, bodyEl: formEl, width: '640px' });
}

function openSubmissionsModal(form, subs) {
  const body = el('div', {});
  if (!subs.length) body.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Nenhuma submissão ainda'));
  else {
    for (const s of subs) {
      const payload = JSON.parse(s.payload_json || '{}');
      body.append(el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:6px' },
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:4px' }, new Date(s.created_at).toLocaleString('pt-BR') + ' • ' + (s.ip || 'unknown')),
        el('pre', { style: 'background:var(--bg-1);padding:8px;border-radius:4px;font-size:11px;overflow:auto;margin:0' }, JSON.stringify(payload, null, 2)),
      ));
    }
  }
  openModal({ title: `Submissões: ${form.name}`, bodyEl: body, width: '640px' });
}

function openHookModal() {
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/webhooks', { method: 'POST', body: {
        name: fd.get('name'),
        mapping: {
          name: 'contact.name', email: 'contact.email', phone: 'contact.phone',
          Name: 'contact.name', Email: 'contact.email', Phone: 'contact.phone',
        },
        defaultSource: fd.get('source') || 'webhook',
      } });
      backdrop.remove(); renderFormsView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('name', 'Nome *', { required: true, attrs: { placeholder: 'Zapier Lead Gen' } }),
    inputField('source', 'Fonte default', { value: 'zapier' }),
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:14px' }, 'Mapping default: aceita name/email/phone (lowercase ou Capitalized).'),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Criar Webhook'),
  );
  const { backdrop } = openModal({ title: 'Novo Webhook', bodyEl: form });
}

// ───────────────────────────────────────────────────────────────────────
// CAMPANHAS
// ───────────────────────────────────────────────────────────────────────
async function renderCampaignsView() {
  try {
    const data = await api('/campaigns');
    const l = $('#campaignsList');
    l.innerHTML = '';
    if (!data.campaigns || data.campaigns.length === 0) {
      l.append(el('div', { style: 'padding:40px;text-align:center;color:var(--text-dim)' }, 'Nenhuma campanha ainda'));
      return;
    }
    for (const c of data.campaigns) {
      const statusColor = { draft: '#64748B', scheduled: '#F59E0B', sending: '#3B82F6', sent: '#10B981', paused: '#F97316' }[c.status] || '#64748B';
      const openRate = c.stats_sent > 0 ? ((c.stats_opened / c.stats_sent) * 100).toFixed(1) + '%' : '—';
      const clickRate = c.stats_sent > 0 ? ((c.stats_clicked / c.stats_sent) * 100).toFixed(1) + '%' : '—';
      l.append(el('div', {
        style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px;cursor:pointer',
        on: {
          click: (e) => { if (e.target.closest('button')) return; openCampaignDetailModal(c); },
          contextmenu: (e) => showContextMenu(e, [
            { label: '📊 Ver detalhes', action: () => openCampaignDetailModal(c) },
            ...(c.status === 'draft' ? [{ label: '▶️ Enviar agora', action: async () => {
              await api(`/campaigns/${c.id}/send`, { method: 'POST' }); toast('Campanha disparada', 'success'); renderCampaignsView();
            } }] : []),
            ...(c.status === 'sending' ? [{ label: '⏸️ Pausar', action: async () => {
              await api(`/campaigns/${c.id}/pause`, { method: 'POST' }); renderCampaignsView();
            } }] : []),
            ...(c.status === 'paused' ? [{ label: '▶️ Retomar', action: async () => {
              await api(`/campaigns/${c.id}/resume`, { method: 'POST' }); renderCampaignsView();
            } }] : []),
          ]),
        },
      },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px' },
          el('div', {},
            el('div', { style: 'font-weight:600' }, c.name),
            el('div', { style: 'font-size:12px;color:var(--text-dim)' }, c.subject),
          ),
          el('span', { style: `padding:4px 12px;border-radius:12px;font-size:11px;font-weight:600;background:${statusColor}20;color:${statusColor};text-transform:uppercase` }, c.status),
        ),
        el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;font-size:12px' },
          el('div', {}, el('div', { style: 'color:var(--text-dim)' }, 'Enviados'), el('div', { style: 'font-weight:600;font-size:16px' }, String(c.stats_sent || 0))),
          el('div', {}, el('div', { style: 'color:var(--text-dim)' }, 'Abertos'), el('div', { style: 'font-weight:600;font-size:16px;color:var(--green)' }, `${c.stats_opened || 0} (${openRate})`)),
          el('div', {}, el('div', { style: 'color:var(--text-dim)' }, 'Cliques'), el('div', { style: 'font-weight:600;font-size:16px;color:var(--blue)' }, `${c.stats_clicked || 0} (${clickRate})`)),
          el('div', {}, el('div', { style: 'color:var(--text-dim)' }, 'Bounced'), el('div', { style: 'font-weight:600;font-size:16px;color:#EF4444' }, String(c.stats_bounced || 0))),
        ),
      ));
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

async function openCampaignDetailModal(c) {
  const stats = await api(`/campaigns/${c.id}/stats`).catch(() => ({}));
  const body = el('div', {},
    el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:6px;margin-bottom:14px' },
      el('div', { style: 'color:var(--text-dim);font-size:12px;margin-bottom:4px' }, 'Subject'),
      el('div', { style: 'font-weight:600' }, c.subject),
    ),
    el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:6px;margin-bottom:14px;max-height:200px;overflow:auto' },
      el('div', { style: 'color:var(--text-dim);font-size:12px;margin-bottom:6px' }, 'Body HTML preview'),
      el('div', { html: c.body_html || '' }),
    ),
    el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:10px' },
      el('button', {
        style: 'padding:10px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600',
        on: { click: async () => {
          if (c.status !== 'draft') return toast('Só pode enviar campanhas em draft', 'info');
          await api(`/campaigns/${c.id}/send`, { method: 'POST' }); toast('Disparada', 'success'); renderCampaignsView();
        } },
      }, '▶️ Enviar Agora'),
      el('button', {
        style: 'padding:10px;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer',
        on: { click: () => toast('Edit em breve', 'info') },
      }, '✏️ Editar'),
    ),
  );
  openModal({ title: c.name, bodyEl: body, width: '600px' });
}

async function openNewCampaignModal() {
  let segments = [], templates = [];
  try {
    segments = (await api('/segments')).segments || [];
    templates = (await api('/email-templates')).templates || [];
  } catch {}

  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/campaigns', { method: 'POST', body: {
        name: fd.get('name'),
        segmentId: fd.get('segmentId'),
        templateId: fd.get('templateId') || undefined,
        subject: fd.get('subject'),
        bodyHtml: fd.get('bodyHtml'),
      } });
      backdrop.remove(); renderCampaignsView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('name', 'Nome *', { required: true }),
    selectField('segmentId', 'Segmento *', segments.length ? segments.map(s => ({ value: s.id, label: s.name })) : [{ value: '', label: 'Crie um segmento primeiro' }]),
    selectField('templateId', 'Template (opcional)', [{ value: '', label: '— Sem template —' }, ...templates.map(t => ({ value: t.id, label: t.name }))]),
    inputField('subject', 'Assunto *', { required: true, attrs: { placeholder: 'Olá {{firstName}}, novidade!' } }),
    inputField('bodyHtml', 'HTML do email *', { tag: 'textarea', required: true, attrs: { rows: 10, placeholder: '<p>Olá {{firstName}},</p><p>...</p>' } }),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;margin-top:8px' }, 'Criar (Draft)'),
  );
  const { backdrop } = openModal({ title: 'Nova Campanha', bodyEl: form, width: '640px' });
}

async function openEmailTemplateModal() {
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/email-templates', { method: 'POST', body: {
        name: fd.get('name'), subject: fd.get('subject'), bodyHtml: fd.get('bodyHtml'),
      } });
      backdrop.remove(); toast('Template criado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('name', 'Nome *', { required: true, attrs: { placeholder: 'Boas-vindas' } }),
    inputField('subject', 'Subject *', { required: true, attrs: { placeholder: 'Olá {{firstName}}!' } }),
    inputField('bodyHtml', 'HTML *', { tag: 'textarea', required: true, attrs: { rows: 10 } }),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Criar Template'),
  );
  const { backdrop } = openModal({ title: 'Novo Template Email', bodyEl: form, width: '600px' });
}

async function openSequencesModal() {
  const data = await api('/sequences').catch(() => ({ sequences: [] }));
  const body = el('div', {});
  if (!data.sequences || !data.sequences.length) {
    body.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Nenhuma sequência drip criada'));
  } else {
    for (const s of data.sequences) {
      body.append(el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:6px' },
        el('div', { style: 'font-weight:600' }, s.name),
        el('div', { style: 'font-size:12px;color:var(--text-dim)' }, `${JSON.parse(s.steps_json || '[]').length} steps • ${s.enabled ? 'ATIVO' : 'PAUSADO'}`),
      ));
    }
  }
  openModal({ title: 'Sequências Drip', bodyEl: body, width: '560px' });
}

async function openUnsubsModal() {
  const data = await api('/unsubscribes').catch(() => ({ unsubscribes: [] }));
  const body = el('div', {});
  if (!data.unsubscribes || !data.unsubscribes.length) {
    body.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Nenhum opt-out'));
  } else {
    for (const u of data.unsubscribes) {
      body.append(el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:4px;display:flex;justify-content:space-between' },
        el('div', { style: 'font-size:13px' }, u.email),
        el('div', { style: 'font-size:11px;color:var(--text-dim)' }, new Date(u.created_at).toLocaleDateString('pt-BR')),
      ));
    }
  }
  openModal({ title: 'Opt-outs (Unsubscribes)', bodyEl: body, width: '480px' });
}

// ─── Wire all buttons ──────────────────────────────────────────────────
function wireOnda35Buttons() {
  $('#tasksFilterView')?.addEventListener('change', renderTasksView);
  $('#tasksFilterPriority')?.addEventListener('change', renderTasksView);
  $('#newTaskBtn')?.addEventListener('click', () => openTaskEditModal(null));

  $('#newAppointmentBtn')?.addEventListener('click', () => openAppointmentEditModal(null));
  $('#schedLinksBtn')?.addEventListener('click', openSchedulingLinksModal);
  $('#icsFeedBtn')?.addEventListener('click', showIcsFeed);

  $('#docsFilterStatus')?.addEventListener('change', renderDocumentsView);
  $('#newDocBtn')?.addEventListener('click', () => openDocumentEditModal(null));
  $('#newDocTemplateBtn')?.addEventListener('click', openDocTemplateModal);

  $('#newFormBtn')?.addEventListener('click', () => openFormEditModal(null));
  $('#newHookBtn')?.addEventListener('click', openHookModal);

  $('#newCampaignBtn')?.addEventListener('click', openNewCampaignModal);
  $('#newEmailTemplateBtn')?.addEventListener('click', openEmailTemplateModal);
  $('#viewSequencesBtn')?.addEventListener('click', openSequencesModal);
  $('#viewUnsubsBtn')?.addEventListener('click', openUnsubsModal);
}

document.addEventListener('DOMContentLoaded', wireOnda35Buttons);
if (document.readyState !== 'loading') wireOnda35Buttons();


function renderContactsList() {
  const l = $('#contactsList');
  l.innerHTML = '';
  if (!state.contacts.length) { l.append(el('div', { class: 'empty' }, 'Nenhum contato ainda.')); return; }
  for (const c of state.contacts) {
    const item = el('div', { class: 'list-item', on: { click: async () => {
      const detail = await api(`/contacts/${c.id}`);
      const card = detail.cards?.[0];
      if (card) openCardPanel(card.id);
      else toast('Esse contato ainda não tem card', '');
    } } },
      el('div', { class: 'list-item-left' },
        el('div', { class: 'contact-avatar' }, initials(c.name)),
        el('div', {},
          el('div', { class: 'list-item-title' }, c.name),
          el('div', { class: 'list-item-sub' }, [c.phone, c.email].filter(Boolean).join(' · ') || '—'),
        ),
      ),
      c.source ? el('span', { class: 'pill purple' }, c.source) : null,
    );
    attachListItemContextMenu(item, (x, y) => showContactContextMenu(c, x, y));
    l.append(item);
  }
}

function renderChannelsList() {
  const l = $('#channelsList');
  l.innerHTML = '';
  if (!state.channels.length) {
    l.append(el('div', { class: 'empty' }, 'Nenhum canal configurado. Clique "+ Novo Canal" pra conectar WhatsApp.'));
    return;
  }
  for (const ch of state.channels) {
    const whUrl = `${location.origin}/webhooks/crm/${ch.type}/${ch.webhookSecret}`;
    const chRow = el('div', { class: 'list-item', style: 'cursor:pointer;flex-direction:column;align-items:stretch', on: { click: (e) => { if (e.target.closest('button') || e.target.closest('input') || e.target.closest('code')) return; openEditChannelModal(ch); } } },
      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px' },
        el('div', { class: 'list-item-left' },
          el('div', { class: 'contact-avatar' }, ch.type === 'meta' ? 'M' : 'Z'),
          el('div', {},
            el('div', { class: 'list-item-title' }, ch.name),
            el('div', { class: 'list-item-sub' }, `${ch.type.toUpperCase()} · ${ch.phoneNumber || ch.phoneNumberId || '—'}`),
          ),
        ),
        el('span', { class: `pill ${ch.status === 'active' ? 'green' : ch.status === 'error' ? 'red' : 'amber'}` }, ch.status),
      ),
      el('div', { style: 'margin-top:10px;font-size:11px;color:var(--text-dim)' },
        el('strong', {}, 'Webhook URL (cole no painel do Meta/Z-API): '),
        el('code', { style: 'display:block;background:var(--bg-3);padding:6px 8px;border-radius:6px;margin-top:4px;word-break:break-all;user-select:all' }, whUrl),
      ),
      el('div', { style: 'margin-top:10px;display:flex;gap:6px' },
        el('button', { class: 'save-btn', style: 'flex:1;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;font-size:12px;padding:9px',
          on: { click: () => showWebhookSetup(ch, false) } }, '📡 Ver webhook URL & instruções'),
        el('button', { class: 'save-btn', style: 'background:transparent;border:1px solid var(--red);color:var(--red);padding:9px 16px;font-size:12px',
          on: { click: async () => {
            if (!await confirmDialog('Remover canal', `Apagar canal "${ch.name}"? Atividades antigas permanecem.`, 'Apagar')) return;
            await api(`/channels/${ch.id}`, { method: 'DELETE' });
            await loadChannels();
            renderChannelsList();
            toast('Canal removido', 'success');
          } } }, 'Remover'),
      ),
    );
    attachListItemContextMenu(chRow, (x, y) => showChannelContextMenu(ch, x, y));
    l.append(chRow);
  }
}


// ─── Webhook helpers ───────────────────────────────────────────────────
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copiado!', 'success'),
      () => fallbackCopy(text),
    );
  } else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); toast('Copiado!', 'success'); }
  catch (e) { toast('Copia manual: ' + text.slice(0, 40), 'error'); }
  ta.remove();
}

function copyableField(label, value) {
  const wrap = el('div', { style: 'margin-bottom:14px' });
  const inp = el('input', {
    type: 'text', readonly: '', value: value || '',
    style: 'flex:1;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:monospace;font-size:12px;user-select:all',
    on: { focus: (e) => e.target.select() },
  });
  const btn = el('button', {
    type: 'button',
    style: 'padding:0 14px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:11px;cursor:pointer;font-family:inherit',
    on: { click: () => copyToClipboard(value) },
  }, 'Copiar');
  wrap.append(
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px' }, label),
    el('div', { style: 'display:flex;gap:6px;align-items:stretch' }, inp, btn),
  );
  return wrap;
}

function showWebhookSetup(channel, isNew) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const isMeta = channel.type === 'meta';
  const whUrl = location.origin + '/webhooks/crm/' + channel.type + '/' + channel.webhookSecret;
  const verifyTok = (channel.credentials && channel.credentials.verifyToken) || '';

  const headerColor = isNew ? 'var(--green)' : 'var(--purple)';
  const title = isNew ? '✓ Canal criado — agora configure no provedor' : 'Webhook do canal ' + channel.name;

  const metaInstr = el('div', {
    style: 'background:rgba(74,158,255,.08);border:1px solid rgba(74,158,255,.25);padding:14px;border-radius:10px;margin-bottom:16px;font-size:12px;line-height:1.65;color:var(--text-2)',
    html: '<div style="font-weight:700;color:var(--blue);margin-bottom:8px">📋 Como configurar no Meta</div>1. Acesse <strong>Meta for Developers</strong> → seu app → <strong>WhatsApp → Configuração</strong><br>2. No bloco <strong>Webhook</strong>, clique <strong>Editar</strong><br>3. Cole a <strong>Webhook URL</strong> abaixo no campo <em>"URL de retorno de chamada"</em><br>4. Cole o <strong>Verify Token</strong> abaixo no campo <em>"Verificar token"</em><br>5. Clique <strong>Verificar e salvar</strong> (deve ficar verde)<br>6. Em <strong>Campos do webhook</strong>, marque <code>messages</code> e <strong>Inscrever</strong>',
  });
  const zapiInstr = el('div', {
    style: 'background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);padding:14px;border-radius:10px;margin-bottom:16px;font-size:12px;line-height:1.65;color:var(--text-2)',
    html: '<div style="font-weight:700;color:var(--green);margin-bottom:8px">📋 Como configurar na Z-API</div>1. Acesse o painel da <strong>Z-API</strong> → sua instância<br>2. Vá em <strong>Webhooks</strong> no menu lateral<br>3. Cole a URL abaixo nos campos <strong>"Ao receber"</strong> (mensagens recebidas)<br>4. Marque a opção <strong>"Notificar mensagens enviadas por mim também"</strong> se quiser sync de outbound<br>5. Salve as alterações',
  });

  const fields = [copyableField('Webhook URL', whUrl)];
  if (isMeta && verifyTok) fields.push(copyableField('Verify Token', verifyTok));

  const modal = el('div', { class: 'modal', style: 'max-width:600px' },
    el('h3', { style: 'color:' + headerColor + ';margin:0 0 6px;font-size:18px' }, title),
    el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:18px' }, channel.name + ' · ' + (isMeta ? 'Meta Cloud API' : 'Z-API') + (channel.phoneNumber ? ' · ' + channel.phoneNumber : '')),
    isMeta ? metaInstr : zapiInstr,
    ...fields,
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'confirm', on: { click: () => backdrop.remove() } }, 'Concluído'),
    ),
  );
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}


async function openNewChannelModal(presetType) {
  // Pre-generate webhook secret so we can show the URL inside the form
  const presetSecret = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  let currentType = presetType || 'zapi';

  const backdrop = el('div', { class: 'modal-backdrop' });

  // Live webhook URL display — updates when provider changes
  const whUrlInput = el('input', {
    type: 'text', readonly: '',
    value: location.origin + '/webhooks/crm/zapi/' + presetSecret,
    style: 'flex:1;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:monospace;font-size:11px;user-select:all',
    on: { focus: (e) => e.target.select() },
  });
  const whCopyBtn = el('button', {
    type: 'button',
    style: 'padding:0 14px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:11px;cursor:pointer;font-family:inherit',
    on: { click: () => copyToClipboard(whUrlInput.value) },
  }, 'Copiar');
  const whBlock = el('div', { style: 'background:rgba(155,89,252,.06);border:1px solid rgba(155,89,252,.18);padding:12px;border-radius:10px;margin-bottom:14px' },
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px' }, '🔗 WEBHOOK URL (cole no painel do provedor)'),
    el('div', { style: 'display:flex;gap:6px;align-items:stretch' }, whUrlInput, whCopyBtn),
    el('div', { id: 'whInstr', style: 'font-size:11px;color:var(--text-dim);margin-top:8px;line-height:1.5' }),
  );

  // Verify token preview (Meta only)
  const verifyTokDefault = 'clow_verify_' + Math.random().toString(36).slice(2, 10);
  const verifyTokInput = el('input', {
    type: 'text', readonly: '', value: verifyTokDefault,
    style: 'flex:1;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:monospace;font-size:11px;user-select:all',
    on: { focus: (e) => e.target.select() },
  });
  const verifyTokBlock = el('div', { style: 'background:rgba(74,158,255,.06);border:1px solid rgba(74,158,255,.18);padding:12px;border-radius:10px;margin-bottom:14px;display:none' },
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px' }, '🔑 VERIFY TOKEN (cole no campo "Verificar token" do Meta)'),
    el('div', { style: 'display:flex;gap:6px;align-items:stretch' }, verifyTokInput,
      el('button', { type: 'button', style: 'padding:0 14px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:11px;cursor:pointer;font-family:inherit', on: { click: () => copyToClipboard(verifyTokInput.value) } }, 'Copiar'),
    ),
  );

  function refreshWebhookUI(type) {
    currentType = type || 'zapi';
    whUrlInput.value = location.origin + '/webhooks/crm/' + currentType + '/' + presetSecret;
    const instr = document.getElementById('whInstr');
    if (instr) {
      instr.innerHTML = currentType === 'meta'
        ? '<strong>Meta:</strong> Configuração → Webhook → Editar → cole acima na <em>URL de retorno</em> + <em>Verificar token</em> abaixo → Verificar e salvar.'
        : '<strong>Z-API:</strong> Painel da instância → Webhooks → cole acima no campo <em>"Ao receber"</em>.';
    }
    verifyTokBlock.style.display = currentType === 'meta' ? '' : 'none';
  }

  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const type = currentType;
    const credentials = type === 'meta' ? {
      accessToken: fd.get('metaToken'),
      phoneNumberId: fd.get('metaPhoneId'),
      verifyToken: verifyTokInput.value,
      apiVersion: 'v22.0',
    } : {
      instanceId: fd.get('zapiInstance'),
      token: fd.get('zapiToken'),
      clientToken: fd.get('zapiClientToken') || undefined,
    };
    try {
      const r = await api('/channels', { method: 'POST', body: {
        type, name: fd.get('name'), credentials,
        phoneNumber: fd.get('phoneDisplay') || undefined,
        webhookSecret: presetSecret,
      } });
      backdrop.remove();
      await loadChannels();
      renderChannelsList();
      showWebhookSetup(r.channel, true);
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });

  const fieldsMeta = el('div', { style: 'display:none' },
    field('Access Token', 'metaToken', 'text', ''),
    field('Phone Number ID', 'metaPhoneId', 'text', ''),
  );
  const fieldsZapi = el('div', { style: 'display:none' },
    field('Instance ID', 'zapiInstance', 'text', ''),
    field('Token', 'zapiToken', 'text', ''),
    field('Client-Token (opcional)', 'zapiClientToken', 'text', ''),
  );

  form.append(
    field('Nome do canal', 'name', 'text', '', { placeholder: 'Ex: WA Vendas' }),
    field('Telefone (display, opcional)', 'phoneDisplay', 'text', '', { placeholder: '+55 21 99999-9999' }),
    el('div', { class: 'field' },
      el('label', {}, 'Provedor'),
      (() => {
        const sel = el('select', { name: 'type', on: { change: (e) => {
          const v = e.target.value;
          fieldsMeta.style.display = v === 'meta' ? '' : 'none';
          fieldsZapi.style.display = v === 'zapi' ? '' : 'none';
          refreshWebhookUI(v);
        } } },
          el('option', { value: 'zapi' }, 'Z-API'),
          el('option', { value: 'meta' }, 'Meta Cloud API (oficial)'),
        );
        return sel;
      })(),
    ),
    fieldsZapi,
    fieldsMeta,
    whBlock,
    verifyTokBlock,
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Criar'),
    ),
  );

  backdrop.append(el('div', { class: 'modal', style: 'max-width:540px' }, el('h3', {}, 'Novo canal WhatsApp'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);

  // Initialize: default to Z-API since it's first option
  setTimeout(() => {
    fieldsZapi.style.display = '';
    refreshWebhookUI('zapi');
  }, 0);
}

function renderAgentsList() {
  const l = $('#agentsList');
  l.innerHTML = '';
  if (!state.agents.length) { l.append(el('div', { class: 'empty' }, 'Nenhum agente cadastrado.')); return; }
  for (const a of state.agents) {
    const item = el('div', { class: 'list-item', style: 'cursor:pointer', on: { click: (e) => { if (e.target.closest('button')) return; openEditAgentModal(a); } } },
      el('div', { class: 'list-item-left' },
        el('div', { class: 'contact-avatar' }, initials(a.name)),
        el('div', {},
          el('div', { class: 'list-item-title' }, a.name),
          el('div', { class: 'list-item-sub' }, `${a.email} · ${a.phone || 'sem telefone'}`),
        ),
      ),
      el('span', { class: 'pill purple' }, a.role),
    );
    attachListItemContextMenu(item, (x, y) => showAgentContextMenu(a, x, y));
    l.append(item);
  }
}

function renderInventoryList() {
  const l = $('#inventoryList');
  l.innerHTML = '';
  if (!state.inventory.length) { l.append(el('div', { class: 'empty' }, 'Estoque vazio.')); return; }
  for (const it of state.inventory) {
    const item = el('div', { class: 'list-item', style: 'cursor:pointer', on: { click: (e) => { if (e.target.closest('button')) return; openEditInventoryModal(it); } } },
      el('div', { class: 'list-item-left' },
        el('div', {},
          el('div', { class: 'list-item-title' }, it.name),
          el('div', { class: 'list-item-sub' }, `SKU ${it.sku} · ${fmtMoney(it.priceCents)}`),
        ),
      ),
      el('span', { class: `pill ${it.stock > 5 ? 'green' : it.stock > 0 ? 'amber' : 'red'}` }, `${it.stock} em estoque`),
    );
    attachListItemContextMenu(item, (x, y) => showInventoryContextMenu(it, x, y));
    l.append(item);
  }
}

async function renderStats() {
  // Lazy-init state for chart instances
  if (!window._rptCharts) window._rptCharts = {};

  // Wire header controls (only once)
  if (!window._rptWired) {
    window._rptWired = true;
    const setDefaults = () => {
      const to = new Date(); to.setUTCHours(23,59,59,999);
      const from = new Date(); from.setUTCDate(from.getUTCDate() - 30); from.setUTCHours(0,0,0,0);
      const f = $('#reportsFrom'); const t = $('#reportsTo');
      if (f && !f.value) f.value = from.toISOString().slice(0,10);
      if (t && !t.value) t.value = to.toISOString().slice(0,10);
    };
    setDefaults();
    $('#reportsRefresh')?.addEventListener('click', () => renderStats());
    $('#reportsSchedulesBtn')?.addEventListener('click', () => openSchedulesModal());
    // Export buttons
    document.querySelectorAll('.rpt-card').forEach(card => {
      const kind = card.dataset.kind;
      card.querySelector('.rpt-csv')?.addEventListener('click', () => exportReport(kind, 'csv'));
      card.querySelector('.rpt-pdf')?.addEventListener('click', () => exportReport(kind, 'pdf'));
    });
  }

  try {
    const s = await loadStats();
    const grid = $('#statsGrid');
    grid.innerHTML = '';
    const cards = [
      { label: 'Cards total', value: s.totalCards, color: 'var(--blue)' },
      { label: 'Pipeline bruto', value: fmtMoney(s.totalValueCents), color: 'var(--green)' },
      { label: 'Forecast ponderado', value: fmtMoney(s.weightedValueCents), color: 'var(--amber)' },
      { label: 'Contatos', value: s.totalContacts, color: 'var(--text)' },
      { label: 'Agentes', value: s.totalAgents, color: 'var(--text)' },
      { label: 'Assinaturas ativas', value: s.totalSubscriptionsActive, color: 'var(--green)' },
    ];
    for (const c of cards) {
      grid.append(el('div', {
        style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px',
      },
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px' }, c.label),
        el('div', { style: `font-size:22px;font-weight:700;color:${c.color}` }, String(c.value)),
      ));
    }
  } catch (e) { toast('Erro nos cards: ' + e.message, 'error'); }

  // Fetch and render all 4 reports in parallel
  const win = reportWindowParams();
  const bucket = $('#reportsBucket')?.value || 'week';
  await Promise.allSettled([
    fetchAndPlot('sales',       `/reports/sales?bucket=${bucket}&${win}`,    'chartSales',   plotSales),
    fetchAndPlot('agents',      `/reports/agent-activities?${win}`,          'chartAgents',  plotAgents),
    fetchAndPlot('sources',     `/reports/lead-sources?${win}`,              'chartSources', plotSources),
    fetchAndPlot('lost-reasons',`/reports/lost-reasons?${win}`,              'chartLost',    plotLost),
  ]);
}

function reportWindowParams() {
  const from = $('#reportsFrom')?.value;
  const to   = $('#reportsTo')?.value;
  const p = [];
  if (from) p.push('from=' + new Date(from + 'T00:00:00Z').getTime());
  if (to)   p.push('to='   + new Date(to   + 'T23:59:59Z').getTime());
  return p.join('&');
}

async function fetchAndPlot(kind, path, canvasId, plotter) {
  try {
    const data = await api(path);
    plotter(canvasId, data.rows || []);
  } catch (e) {
    console.warn('[report]', kind, e.message);
  }
}

function destroyChart(id) {
  const c = window._rptCharts[id];
  if (c) { c.destroy(); delete window._rptCharts[id]; }
}

function plotSales(canvasId, rows) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  if (rows.length === 0) { emptyMsg(ctx); return; }
  window._rptCharts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => r.bucket),
      datasets: [
        { label: 'Vendas (count)', data: rows.map(r => r.dealsWon), borderColor: '#9B59FC', backgroundColor: 'rgba(155,89,252,.2)', yAxisID: 'y' },
        { label: 'Receita (R$)', data: rows.map(r => r.totalValueCents / 100), borderColor: '#22C55E', backgroundColor: 'rgba(34,197,94,.2)', yAxisID: 'y1' },
      ],
    },
    options: chartDefaults({ dualAxis: true }),
  });
}

function plotAgents(canvasId, rows) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  if (rows.length === 0) { emptyMsg(ctx); return; }
  const types = [...new Set(rows.flatMap(r => Object.keys(r.byType)))];
  const palette = ['#9B59FC', '#22C55E', '#F59E0B', '#3B82F6', '#EF4444', '#06B6D4', '#EC4899'];
  window._rptCharts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.agentName),
      datasets: types.map((t, i) => ({
        label: t,
        data: rows.map(r => r.byType[t] || 0),
        backgroundColor: palette[i % palette.length],
      })),
    },
    options: chartDefaults({ stacked: true }),
  });
}

function plotSources(canvasId, rows) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  if (rows.length === 0) { emptyMsg(ctx); return; }
  window._rptCharts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => r.source),
      datasets: [{
        data: rows.map(r => r.contactCount),
        backgroundColor: ['#9B59FC', '#22C55E', '#F59E0B', '#3B82F6', '#EF4444', '#06B6D4', '#EC4899', '#64748B'],
      }],
    },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#cbd5e1' } } } },
  });
}

function plotLost(canvasId, rows) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  if (rows.length === 0) { emptyMsg(ctx); return; }
  window._rptCharts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.reason),
      datasets: [{
        label: 'Cards perdidos',
        data: rows.map(r => r.cardCount),
        backgroundColor: '#EF4444',
      }],
    },
    options: chartDefaults({ horizontal: true }),
  });
}

function chartDefaults(o = {}) {
  const opts = {
    responsive: true,
    plugins: {
      legend: { labels: { color: '#cbd5e1' } },
    },
    scales: {
      x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.1)' }, stacked: !!o.stacked },
      y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.1)' }, stacked: !!o.stacked, beginAtZero: true },
    },
  };
  if (o.dualAxis) {
    opts.scales.y1 = { position: 'right', ticks: { color: '#94a3b8' }, grid: { drawOnChartArea: false }, beginAtZero: true };
  }
  if (o.horizontal) opts.indexAxis = 'y';
  return opts;
}

function emptyMsg(ctx) {
  ctx.save();
  ctx.fillStyle = '#94a3b8';
  ctx.font = '13px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Sem dados no período', ctx.canvas.width / 2, ctx.canvas.height / 2);
  ctx.restore();
}

async function exportReport(kind, format) {
  const win = reportWindowParams();
  const bucket = $('#reportsBucket')?.value || 'week';
  let path;
  if (kind === 'sales')              path = `/reports/sales?bucket=${bucket}&${win}&format=${format}`;
  else if (kind === 'agents')        path = `/reports/agent-activities?${win}&format=${format}`;
  else if (kind === 'sources')       path = `/reports/lead-sources?${win}&format=${format}`;
  else if (kind === 'lost-reasons')  path = `/reports/lost-reasons?${win}&format=${format}`;
  else return;

  try {
    const r = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${state.apiKey}` } });
    if (!r.ok) throw new Error(await r.text());
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}-${Date.now()}.${format}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

async function openSchedulesModal() {
  let schedules = [];
  try { schedules = (await api('/scheduled-reports')).scheduledReports || []; }
  catch (e) { toast('Erro: ' + e.message, 'error'); return; }

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: 'max-width:640px' });
  const renderList = () => {
    const list = modal.querySelector('.sched-list');
    if (!list) return;
    list.innerHTML = '';
    if (schedules.length === 0) {
      list.append(el('div', { style: 'color:var(--text-dim);padding:20px;text-align:center' }, 'Nenhum agendamento.'));
      return;
    }
    for (const s of schedules) {
      const row = el('div', { style: 'display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px' },
        el('div', { style: 'flex:1' },
          el('div', { style: 'font-weight:600' }, s.name),
          el('div', { style: 'font-size:12px;color:var(--text-dim)' },
            `${s.kind} • ${s.interval} • ${s.format.toUpperCase()} → ${s.email_to}`,
          ),
        ),
        el('button', { on: { click: async () => {
          try { await api(`/scheduled-reports/${s.id}/run`, { method: 'POST' }); toast('Enviado!', 'success'); }
          catch (e) { toast('Erro: ' + e.message, 'error'); }
        } } }, 'Enviar agora'),
        el('button', { on: { click: async () => {
          try {
            await api(`/scheduled-reports/${s.id}`, { method: 'DELETE' });
            schedules = schedules.filter(x => x.id !== s.id);
            renderList();
          } catch (e) { toast('Erro: ' + e.message, 'error'); }
        } }, style: 'color:#ef4444' }, 'Remover'),
      );
      list.append(row);
    }
  };

  modal.append(
    el('div', { class: 'modal-head' },
      el('h3', {}, 'Agendamentos de relatórios'),
      el('button', { class: 'close-modal', on: { click: () => backdrop.remove() } }, '×'),
    ),
    el('div', { class: 'modal-body' },
      el('div', { class: 'sched-list', style: 'max-height:240px;overflow:auto;margin-bottom:14px' }),
      el('h4', { style: 'margin:12px 0 8px' }, 'Novo agendamento'),
      el('form', { class: 'sched-form', style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px', on: { submit: async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {
          name: fd.get('name'),
          kind: fd.get('kind'),
          interval: fd.get('interval'),
          format: fd.get('format'),
          emailTo: fd.get('emailTo'),
        };
        try {
          const r = await api('/scheduled-reports', { method: 'POST', body });
          toast('Agendado!', 'success');
          schedules = (await api('/scheduled-reports')).scheduledReports || [];
          renderList();
          e.target.reset();
        } catch (err) { toast('Erro: ' + err.message, 'error'); }
      } } },
        el('input', { name: 'name', placeholder: 'Nome (ex: Vendas semanais)', required: '', style: 'grid-column:span 2' }),
        (() => { const s = el('select', { name: 'kind', required: '' });
          s.append(el('option', { value: 'sales' }, 'Vendas por período'));
          s.append(el('option', { value: 'agents' }, 'Atividades por agente'));
          s.append(el('option', { value: 'sources' }, 'Origem de leads'));
          s.append(el('option', { value: 'lost-reasons' }, 'Razões de perda'));
          return s; })(),
        (() => { const s = el('select', { name: 'interval', required: '' });
          s.append(el('option', { value: 'daily' }, 'Diário'));
          s.append(el('option', { value: 'weekly', selected: '' }, 'Semanal'));
          s.append(el('option', { value: 'monthly' }, 'Mensal'));
          return s; })(),
        (() => { const s = el('select', { name: 'format', required: '' });
          s.append(el('option', { value: 'pdf' }, 'PDF'));
          s.append(el('option', { value: 'csv' }, 'CSV'));
          return s; })(),
        el('input', { name: 'emailTo', type: 'email', placeholder: 'email@exemplo.com', required: '' }),
        el('button', { type: 'submit', style: 'grid-column:span 2;background:var(--purple);color:#fff;border:0;padding:10px;border-radius:8px;cursor:pointer' }, 'Criar agendamento'),
      ),
    ),
  );
  backdrop.append(modal);
  document.body.append(backdrop);
  renderList();
}



// ─── Missing modals (v2 — these were declared in wireEvents but never defined) ─
async function openNewContactModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/contacts', { method: 'POST', body: {
        name: fd.get('name'),
        phone: fd.get('phone') || null,
        email: fd.get('email') || null,
        source: fd.get('source') || 'manual',
        tags: (fd.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean),
      } });
      backdrop.remove();
      await loadContacts();
      renderContactsList();
      toast('Contato criado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    field('Nome', 'name', 'text', '', { required: '', placeholder: 'João Silva' }),
    field('Telefone', 'phone', 'tel', '', { placeholder: '5521999998888' }),
    field('Email', 'email', 'email', '', { placeholder: 'joao@exemplo.com' }),
    field('Origem', 'source', 'text', '', { placeholder: 'Instagram, indicação, site...' }),
    field('Tags (vírgulas)', 'tags', 'text', '', { placeholder: 'vip, premium' }),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Criar contato'),
    ),
  );
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Novo contato'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

async function openNewAgentModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/agents', { method: 'POST', body: {
        name: fd.get('name'),
        email: fd.get('email'),
        phone: fd.get('phone') || null,
        role: fd.get('role'),
      } });
      backdrop.remove();
      await loadAgents();
      renderAgentsList();
      toast('Agente cadastrado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  const roleSel = el('select', { name: 'role' });
  for (const [v, label] of [['agent', 'Atendente / Vendedor'], ['admin', 'Administrador'], ['owner', 'Proprietário'], ['viewer', 'Apenas leitura']]) {
    roleSel.append(el('option', { value: v }, label));
  }
  form.append(
    field('Nome', 'name', 'text', '', { required: '', placeholder: 'Maria Vendedora' }),
    field('Email', 'email', 'email', '', { required: '', placeholder: 'maria@empresa.com' }),
    field('Telefone (opcional)', 'phone', 'tel', '', { placeholder: '5521988887777' }),
    el('div', { class: 'field' }, el('label', {}, 'Papel'), roleSel),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Cadastrar'),
    ),
  );
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Novo membro da equipe'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

async function openNewInventoryModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/inventory', { method: 'POST', body: {
        sku: fd.get('sku'),
        name: fd.get('name'),
        description: fd.get('description') || null,
        priceCents: Math.round(parseFloat(fd.get('price') || '0') * 100),
        stock: parseInt(fd.get('stock') || '0', 10),
        category: fd.get('category') || null,
      } });
      backdrop.remove();
      await loadInventory();
      renderInventoryList();
      toast('Item adicionado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    field('SKU', 'sku', 'text', '', { required: '', placeholder: 'PRD-001' }),
    field('Nome do produto', 'name', 'text', '', { required: '', placeholder: 'Plano Premium Anual' }),
    fieldTextarea('Descrição', 'description', ''),
    el('div', { style: 'display:flex;gap:10px' },
      field('Preço (R$)', 'price', 'number', '0', { step: '0.01', style: 'flex:1' }),
      field('Estoque', 'stock', 'number', '0', { min: '0', style: 'flex:1' }),
    ),
    field('Categoria', 'category', 'text', '', { placeholder: 'Serviços, Produtos físicos...' }),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Adicionar'),
    ),
  );
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Novo item de estoque'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}


// ─── EDIT MODALS (channel / agent / inventory) ─────────────────────────
async function openEditChannelModal(ch) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const isMeta = ch.type === 'meta';
  const c = ch.credentials || {};
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {
      name: fd.get('name'),
      status: fd.get('status'),
      phoneNumber: fd.get('phoneNumber') || undefined,
    };
    const newToken = fd.get('credToken');
    if (newToken && !newToken.includes('...')) {
      patch.credentials = isMeta
        ? { accessToken: newToken, phoneNumberId: fd.get('phoneNumberId'), verifyToken: c.verifyToken, apiVersion: c.apiVersion || 'v22.0' }
        : { instanceId: fd.get('instanceId'), token: newToken, clientToken: fd.get('clientToken') || undefined };
    }
    try {
      await api('/channels/' + ch.id, { method: 'PATCH', body: patch });
      backdrop.remove();
      await loadChannels();
      renderChannelsList();
      toast('Canal atualizado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  const statusSel = el('select', { name: 'status' });
  for (const st of ['active', 'disabled', 'pending', 'error']) {
    const opt = el('option', { value: st }, st);
    if (st === ch.status) opt.selected = true;
    statusSel.append(opt);
  }
  const credsBlock = el('div', { style: 'border-top:1px solid var(--border);padding-top:14px;margin-top:6px' },
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:600' },
      'Credenciais ' + (isMeta ? 'Meta' : 'Z-API')),
  );
  if (isMeta) {
    credsBlock.append(field('Phone Number ID', 'phoneNumberId', 'text', c.phoneNumberId || ''));
    credsBlock.append(field('Access Token (deixa como esta pra nao alterar)', 'credToken', 'text', c.accessToken || ''));
  } else {
    credsBlock.append(field('Instance ID', 'instanceId', 'text', c.instanceId || ''));
    credsBlock.append(field('Token (deixa como esta pra nao alterar)', 'credToken', 'text', c.token || ''));
    credsBlock.append(field('Client-Token (opcional)', 'clientToken', 'text', c.clientToken || ''));
  }
  form.append(
    field('Nome do canal', 'name', 'text', ch.name, { required: '' }),
    field('Telefone (display)', 'phoneNumber', 'text', ch.phoneNumber || ''),
    el('div', { class: 'field' }, el('label', {}, 'Status'), statusSel),
    credsBlock,
    el('div', { style: 'background:var(--bg-3);padding:10px;border-radius:8px;margin:14px 0;font-size:11px;color:var(--text-dim);word-break:break-all' },
      'Webhook URL: ', el('br'),
      el('code', { style: 'color:var(--text-2);user-select:all' }, location.origin + '/webhooks/crm/' + ch.type + '/' + ch.webhookSecret),
    ),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Salvar alterações'),
    ),
  );
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Editar canal'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

async function openEditAgentModal(a) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/agents/' + a.id, { method: 'PATCH', body: {
        name: fd.get('name'),
        email: fd.get('email'),
        phone: fd.get('phone') || null,
        role: fd.get('role'),
        active: fd.get('active') === 'on',
      } });
      backdrop.remove();
      await loadAgents();
      renderAgentsList();
      toast('Agente atualizado', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  const roleSel = el('select', { name: 'role' });
  for (const [v, label] of [['agent', 'Atendente / Vendedor'], ['admin', 'Administrador'], ['owner', 'Proprietário'], ['viewer', 'Apenas leitura']]) {
    const opt = el('option', { value: v }, label);
    if (v === a.role) opt.selected = true;
    roleSel.append(opt);
  }
  form.append(
    field('Nome', 'name', 'text', a.name, { required: '' }),
    field('Email', 'email', 'email', a.email, { required: '' }),
    field('Telefone', 'phone', 'tel', a.phone || ''),
    el('div', { class: 'field' }, el('label', {}, 'Papel'), roleSel),
    el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer;margin:8px 0 16px' },
      el('input', { type: 'checkbox', name: 'active', checked: a.active ? '' : null }),
      'Ativo (pode receber atribuições)',
    ),
    el('div', { class: 'modal-actions' },
      el('button', {
        type: 'button',
        style: 'background:transparent;border:1px solid var(--red);color:var(--red);padding:9px 16px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;margin-right:auto',
        on: { click: async () => {
          if (!await confirmDialog('Remover agente', 'Apagar ' + a.name + '? Cards atribuídos ficam sem dono.', 'Apagar')) return;
          await api('/agents/' + a.id, { method: 'DELETE' });
          backdrop.remove();
          await loadAgents();
          renderAgentsList();
          toast('Agente removido', 'success');
        } },
      }, 'Apagar'),
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Salvar'),
    ),
  );
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Editar agente'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

async function openEditInventoryModal(it) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const newStock = parseInt(fd.get('stock') || '0', 10);
      const delta = newStock - it.stock;
      if (delta !== 0) {
        await api('/inventory/' + it.id + '/stock', { method: 'POST', body: { delta } });
      }
      backdrop.remove();
      await loadInventory();
      renderInventoryList();
      toast('Estoque atualizado (' + (delta >= 0 ? '+' : '') + delta + ')', 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    el('div', { style: 'background:var(--bg-3);padding:12px;border-radius:10px;margin-bottom:14px' },
      el('div', { style: 'font-weight:600;color:var(--text);font-size:14px' }, it.name),
      el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:4px' },
        'SKU ' + it.sku + ' · R$ ' + (it.priceCents / 100).toFixed(2)),
    ),
    field('Estoque atual', 'stock', 'number', String(it.stock), { min: '0', required: '' }),
    el('div', { style: 'font-size:11px;color:var(--text-dim);margin:-8px 0 14px' },
      'A diferença entre o valor atual e o novo vira movimentação de estoque.'),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Salvar'),
    ),
  );
  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Editar produto'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

// ─── Event wiring ──────────────────────────────────────────────────────
function wireEvents() {
  // Helper: safe wire — null-tolerant + try/catch around addEventListener
  const wire = (sel, ev, fn) => {
    try {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (el && fn) el.addEventListener(ev, fn);
    } catch (e) { console.warn('[wire]', sel, ev, e.message); }
  };
  const wireAll = (sel, ev, fn) => {
    try {
      document.querySelectorAll(sel).forEach(el => {
        try { el.addEventListener(ev, fn); } catch (e) { console.warn('[wireAll]', sel, e.message); }
      });
    } catch (e) { console.warn('[wireAll-outer]', sel, e.message); }
  };

  // Login (form may be absent — that's by design)
  const lf = document.getElementById('loginForm');
  if (lf) lf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('#apiKeyInput').value.trim();
    const errEl = $('#loginErr');
    errEl.classList.add('hide');
    try {
      await attemptLogin(key);
      $('#loginScreen').classList.add('hide');
      $('#app').classList.remove('hide');
      await bootstrap();
    } catch (err) {
      errEl.textContent = err.message || 'Erro de autenticação';
      errEl.classList.remove('hide');
    }
  });

  wire('#logoutBtn', 'click', logout);

  // Nav
  wireAll('.nav-item', 'click', (e) => {
    const v = e.currentTarget?.dataset?.view;
    if (v) showView(v);
  });

  // Refresh + new buttons
  wire('#refreshBtn', 'click', async () => {
    await loadPipeline(state.currentBoardId);
    renderKanban();
    toast('Atualizado', 'success');
  });
  wire('#newCardBtn', 'click', () => openNewCardModal());
  wire('#newChannelBtn', 'click', openNewChannelModal);
  wire('#newContactBtn', 'click', openNewContactModal);
  wire('#newAgentBtn', 'click', openNewAgentModal);
  wire('#newInventoryBtn', 'click', openNewInventoryModal);

  // Side panel — close + tabs (delegation pra pegar abas adicionadas dinamicamente)
  wire('#closePanelBtn', 'click', closeCardPanel);
  document.body.addEventListener('click', (e) => {
    const tab = e.target.closest('.panel-tab');
    if (!tab) return;
    const tabId = tab.dataset.tab;
    document.querySelectorAll('.panel-tab').forEach(x => x.classList.toggle('active', x === tab));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.toggle('active', s.dataset.tab === tabId));
    // Render fresh content para abas Onda 37
    const card = state.currentCard?.card;
    if (card) {
      if (tabId === 'ai' && typeof renderAITab === 'function') renderAITab(card).catch(() => {});
      else if (tabId === 'links' && typeof renderLinksTab === 'function') renderLinksTab(card).catch(() => {});
      else if (tabId === 'comments' && typeof renderCommentsTab === 'function') renderCommentsTab(card).catch(() => {});
    }
  });

  // Composer
  wire('#sendMsgBtn', 'click', () => {
    const t = document.getElementById('composerText');
    const txt = (t?.value || '').trim();
    if (txt) sendCurrentMessage(txt);
  });
  wire('#composerText', 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const txt = (e.currentTarget.value || '').trim();
      if (txt) sendCurrentMessage(txt);
    }
  });
  wire('#attachBtn', 'click', () => {
    const f = document.getElementById('attachFile');
    if (f) f.click();
  });
  wire('#attachFile', 'change', (e) => {
    const file = e.target?.files?.[0];
    if (file) uploadAndSendFile(file);
    if (e.target) e.target.value = '';
  });
  wire('#recordBtn', 'click', toggleRecording);

  // Contact search
  wire('#contactSearchInput', 'input', async (e) => {
    clearTimeout(window.__searchT);
    window.__searchT = setTimeout(async () => {
      await loadContacts(e.target.value);
      renderContactsList();
    }, 250);
  });
}


// ─── Auto-login via System Clow session ───────────────────────────────
async function tryExchange() {
  const sessionToken = localStorage.getItem('clow_token');
  if (!sessionToken) return null;
  try {
    const r = await fetch('/v1/crm/auth/exchange', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.api_key;
  } catch (e) { return null; }
}

async function tryAutoLogin() {
  // 1. Try cached CRM api_key
  if (state.apiKey) {
    try { await attemptLogin(state.apiKey); return true; }
    catch (e) { state.apiKey = ''; localStorage.removeItem('clow_crm_key'); }
  }
  // 2. Try exchange via System Clow session
  const fresh = await tryExchange();
  if (fresh) {
    state.apiKey = fresh;
    localStorage.setItem('clow_crm_key', fresh);
    try { await attemptLogin(fresh); return true; }
    catch (e) { state.apiKey = ''; localStorage.removeItem('clow_crm_key'); }
  }
  return false;
}

function showLoginRequired() {
  const ls = $('#loginScreen');
  if (!ls) return;
  ls.innerHTML = '<div class="login-card" style="text-align:center"><h1>Acesso restrito</h1><p>Você precisa estar logado no System Clow para acessar o CRM.</p><a href="/" style="display:inline-block;margin-top:14px;padding:12px 24px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Ir pro System Clow</a></div>';
}

// ─── Boot ──────────────────────────────────────────────────────────────
(async () => {
  // Wire events with safety wrap — never let one missing element kill the boot
  try { wireEvents(); } catch (e) { console.warn('[CRM] wireEvents partial:', e.message); }

  const ls = document.getElementById('loginScreen');

  try {
    const ok = await tryAutoLogin();
    if (ok) {
      if (ls) ls.classList.add('hide');
      const appEl = document.getElementById('app');
      if (appEl) appEl.classList.remove('hide');
      await bootstrap();
    } else {
      showLoginRequired();
    }
  } catch (err) {
    console.error('[CRM] boot failed:', err);
    if (ls) {
      ls.innerHTML = '<div class="login-card" style="text-align:center"><h1 style="color:#EF4444">Erro ao iniciar</h1><p style="color:#9898B8">' + (err && err.message ? err.message : 'desconhecido') + '</p><a href="/" style="display:inline-block;margin-top:14px;padding:12px 24px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Voltar pro System Clow</a></div>';
    }
  }
})();


window.__crmRefresh = async function() { try { if (state.currentBoardId) { await loadPipeline(state.currentBoardId); renderKanban(); } if (state.currentCard) { await refreshCurrentCard(); } } catch(e){} };
window.__crmAppReady = true;

// ═══ EXPORT helpers pro window (crm-extras.js e classic script, nao enxerga module scope) ═══
function showMenu(menu, x, y) {
  closeCtxMenus();
  positionMenu(menu, x, y);
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
}
window.attachListItemContextMenu = attachListItemContextMenu;
window.closeCtxMenus = closeCtxMenus;
window.ctxItem = ctxItem;
window.ctxSep = ctxSep;
window.ctxHeader = ctxHeader;
window.positionMenu = positionMenu;
window.ensureCtxMenuStyles = ensureCtxMenuStyles;
window.buildMenu = buildMenu;
window.truncate = truncate;
window.CTX_ICO = CTX_ICO;
window.showMenu = showMenu;
// APIs que crm-extras.js chama pra refresh de listas
window.loadContacts = loadContacts;
window.renderContactsList = renderContactsList;
window.loadChannels = (typeof loadChannels === 'function') ? loadChannels : null;
window.renderChannelsList = renderChannelsList;
window.loadAgents = (typeof loadAgents === 'function') ? loadAgents : null;
window.renderAgentsList = renderAgentsList;
window.loadInventory = (typeof loadInventory === 'function') ? loadInventory : null;
window.renderInventoryList = renderInventoryList;
window.openEditChannelModal = openEditChannelModal;
window.openEditAgentModal = openEditAgentModal;
window.openEditInventoryModal = openEditInventoryModal;
window.openCardPanel = openCardPanel;
window.fmtMoney = fmtMoney;


// ═══ ONDA 37: 6 VIEWS RESTANTES + CARD SIDE PANEL TABS ═════════════════

// ═════════ BUSCA GLOBAL ═════════════════════════════════════════════════
let _searchTimer = null;
function wireGlobalSearch() {
  const input = $('#globalSearchInput');
  if (!input || input._wired) return;
  input._wired = true;
  input.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => doGlobalSearch(input.value), 300);
  });
}

async function doGlobalSearch(q) {
  const container = $('#globalSearchResults');
  if (!container) return;
  if (!q || q.length < 2) { container.innerHTML = '<div style="color:var(--text-dim);padding:20px;text-align:center">Digite ao menos 2 caracteres</div>'; return; }
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}&limit=50`);
    container.innerHTML = '';
    if (!data.hits || !data.hits.length) {
      container.innerHTML = '<div style="color:var(--text-dim);padding:40px;text-align:center">Nenhum resultado para "' + q + '"</div>';
      return;
    }
    const grouped = { contacts: [], cards: [], activities: [], notes: [] };
    for (const h of data.hits) (grouped[h.entity] || (grouped[h.entity] = [])).push(h);
    const labels = { contacts: '👤 Contatos', cards: '📋 Cards', activities: '⚡ Atividades', notes: '📝 Notas' };
    for (const [entity, items] of Object.entries(grouped)) {
      if (!items.length) continue;
      container.append(el('h3', { style: 'margin:16px 0 8px;color:var(--text)' }, `${labels[entity] || entity} (${items.length})`));
      for (const h of items) {
        container.append(el('div', {
          style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:6px;cursor:pointer',
          on: { click: () => navigateToHit(h) },
        },
          el('div', { style: 'font-weight:600' }, h.title),
          el('div', { style: 'font-size:12px;color:var(--text-dim);margin-top:4px', html: h.snippet || '' }),
          el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:4px' }, `Score: ${h.score.toFixed(2)}`),
        ));
      }
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

function navigateToHit(hit) {
  if (hit.entity === 'contacts') { showView('contacts'); }
  else if (hit.entity === 'cards') { showView('kanban'); setTimeout(() => openCardById(hit.id), 100); }
  else if (hit.entity === 'activities') {
    if (hit.metadata?.cardId) { showView('kanban'); setTimeout(() => openCardById(hit.metadata.cardId), 100); }
  }
}

async function openCardById(id) {
  try {
    const r = await api(`/cards/${id}`);
    if (r.card) openCardPanel(r.card);
  } catch {}
}

// ═════════ INSIGHTS AI ═══════════════════════════════════════════════════
async function renderInsightsView() {
  const container = $('#insightsContent');
  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim)">Carregando...</div>';
  try {
    const forecast = await api('/ai/forecast').catch(() => ({}));
    const cards = await api('/cards-paginated?limit=50').catch(() => ({ cards: [] }));

    container.innerHTML = '';
    // Forecast hero
    container.append(el('div', { style: 'background:linear-gradient(135deg,var(--purple),#6d28d9);color:#fff;padding:24px;border-radius:12px;margin-bottom:20px' },
      el('div', { style: 'font-size:14px;opacity:.85;margin-bottom:6px' }, 'Forecast Pipeline (próximos 30 dias)'),
      el('div', { style: 'font-size:36px;font-weight:700;margin-bottom:8px' }, fmtMoney(forecast.weightedCents || 0)),
      el('div', { style: 'font-size:13px;opacity:.85' }, `Pipeline bruto: ${fmtMoney(forecast.pipelineTotalCents || 0)} • Vendas esperadas: ${forecast.expectedWinsCount || 0}`),
    ));

    if (forecast.byStage?.length) {
      container.append(el('h3', { style: 'margin:0 0 12px' }, 'Por estágio'));
      const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:24px' });
      for (const s of forecast.byStage) {
        grid.append(el('div', { style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px' },
          el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:4px' }, s.stageName),
          el('div', { style: 'font-size:18px;font-weight:600;color:var(--purple)' }, fmtMoney(s.weightedCents)),
          el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:2px' }, `${s.cardCount} cards • bruto ${fmtMoney(s.valueCents)}`),
        ));
      }
      container.append(grid);
    }

    // Top cards by score
    container.append(el('h3', { style: 'margin:24px 0 12px' }, 'Cards prioritários (clique pra ver insights)'));
    const list = el('div', {});
    for (const c of (cards.cards || []).slice(0, 30)) {
      const row = el('div', {
        style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:6px;cursor:pointer;display:flex;justify-content:space-between;align-items:center',
        on: { click: () => openCardAIInsights(c.id) },
      },
        el('div', {},
          el('div', { style: 'font-weight:600' }, c.title),
          el('div', { style: 'font-size:11px;color:var(--text-dim)' }, fmtMoney(c.valueCents || 0)),
        ),
        el('button', { style: 'background:var(--purple);color:#fff;border:0;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px' }, '🧠 Analisar'),
      );
      list.append(row);
    }
    container.append(list);
  } catch (e) { container.innerHTML = '<div style="padding:40px;color:#ef4444">' + e.message + '</div>'; }
}

async function openCardAIInsights(cardId) {
  const body = el('div', {},
    el('div', { id: 'aiInsightsLoad', style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Calculando insights...'),
  );
  const { backdrop } = openModal({ title: '🧠 AI Insights', bodyEl: body, width: '640px' });

  try {
    const score = await api(`/ai/cards/${cardId}/score`).catch(() => null);
    const classify = await api(`/ai/cards/${cardId}/classify`).catch(() => null);
    const sentiment = await api(`/ai/cards/${cardId}/sentiment`).catch(() => null);

    body.innerHTML = '';
    if (score?.insight) {
      const s = score.insight;
      const bd = s.contentJson || {};
      body.append(el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:6px;margin-bottom:14px' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px' },
          el('div', { style: 'font-weight:600' }, 'Lead Score'),
          el('div', { style: `font-size:32px;font-weight:700;color:${s.scoreNumeric > 60 ? 'var(--green)' : s.scoreNumeric > 30 ? 'var(--amber)' : '#ef4444'}` }, s.scoreNumeric + '/100'),
        ),
        el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:11px;color:var(--text-dim)' },
          el('div', {}, `Atividade: ${bd.activity}/25`),
          el('div', {}, `Resposta: ${bd.response}/20`),
          el('div', {}, `Estágio: ${bd.stage}/20`),
          el('div', {}, `Valor: ${bd.value}/15`),
          el('div', {}, `Frescor: ${bd.freshness}/10`),
          el('div', {}, `Proposta: ${bd.proposal}/10`),
        ),
      ));
    }
    if (classify?.insight) {
      const lbl = classify.insight.contentText;
      const colors = { hot: '#ef4444', warm: '#f59e0b', cold: '#3b82f6' };
      body.append(el('div', { style: `background:${colors[lbl]}20;border:1px solid ${colors[lbl]};padding:14px;border-radius:6px;margin-bottom:14px` },
        el('div', { style: 'font-weight:600;margin-bottom:4px' }, '🌡️ Classificação'),
        el('div', { style: `font-size:24px;font-weight:700;color:${colors[lbl]};text-transform:uppercase` }, lbl),
        classify.insight.contentJson?.reasoning ? el('div', { style: 'font-size:12px;color:var(--text-dim);margin-top:6px' }, classify.insight.contentJson.reasoning.join(' • ')) : null,
      ));
    }
    if (sentiment?.insight?.contentJson) {
      const sj = sentiment.insight.contentJson;
      const sColor = { positive: '#10b981', neutral: '#64748b', negative: '#ef4444' }[sj.label];
      body.append(el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:6px;margin-bottom:14px' },
        el('div', { style: 'font-weight:600;margin-bottom:6px' }, '💭 Sentimento (mensagens recentes)'),
        el('div', { style: `color:${sColor};font-size:18px;font-weight:600;text-transform:capitalize` }, `${sj.label} (${(sj.score * 100).toFixed(0)}%)`),
        sj.triggers?.length ? el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:6px' }, 'Palavras-chave: ' + sj.triggers.slice(0, 5).join(', ')) : null,
      ));
    }

    body.append(
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
        el('button', {
          style: 'padding:10px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600',
          on: { click: async () => {
            toast('Gerando próximo passo...', 'info');
            try {
              const r = await api(`/ai/cards/${cardId}/next-step`, { method: 'POST', body: {} });
              if (r.insight?.contentText) alert('Sugestão IA:\n\n' + r.insight.contentText);
            } catch (e) { toast('Erro: ' + e.message, 'error'); }
          } },
        }, '💡 Próximo passo (IA)'),
        el('button', {
          style: 'padding:10px;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer',
          on: { click: async () => {
            toast('Gerando resumo...', 'info');
            try {
              const r = await api(`/ai/cards/${cardId}/summary`, { method: 'POST', body: {} });
              if (r.insight?.contentText) alert('Resumo da conversa:\n\n' + r.insight.contentText);
            } catch (e) { toast('Erro: ' + e.message, 'error'); }
          } },
        }, '📝 Resumo conversa'),
      ),
    );
  } catch (e) { body.innerHTML = '<div style="color:#ef4444">' + e.message + '</div>'; }
}

// ═════════ PERFORMANCE / GAMIFICAÇÃO ═════════════════════════════════════
async function renderPerformanceView() {
  const period = $('#perfPeriod')?.value || 'month';
  const container = $('#performanceContent');
  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim)">Carregando...</div>';
  try {
    const dashboard = await api(`/gamification/dashboard?period=${period}`).catch(() => ({ rows: [], leaderboards: {} }));
    const goals = await api('/goals').catch(() => ({ goals: [] }));
    const badges = await api('/badges').catch(() => ({ badges: [] }));

    container.innerHTML = '';

    // Top performers
    container.append(el('h3', { style: 'margin:0 0 12px' }, '🏆 Ranking de Vendedores'));
    const board = dashboard.leaderboards?.revenue || [];
    if (!board.length) container.append(el('div', { style: 'color:var(--text-dim);padding:14px;background:var(--bg-2);border-radius:8px;margin-bottom:24px' }, 'Sem dados no período'));
    else {
      const podium = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:24px' });
      for (let i = 0; i < Math.min(3, board.length); i++) {
        const r = board[i];
        const medals = ['🥇', '🥈', '🥉'];
        podium.append(el('div', { style: `background:var(--bg-2);border:2px solid ${i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : '#CD7F32'};border-radius:10px;padding:18px;text-align:center` },
          el('div', { style: 'font-size:32px' }, medals[i]),
          el('div', { style: 'font-weight:700;margin-top:8px' }, r.agentName),
          el('div', { style: 'color:var(--purple);font-size:18px;font-weight:600;margin-top:4px' }, fmtMoney(r.value)),
        ));
      }
      container.append(podium);
    }

    // All metrics dashboard
    container.append(el('h3', { style: 'margin:0 0 12px' }, '📊 Dashboard'));
    const grid = el('div', { style: 'overflow-x:auto;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;margin-bottom:24px' });
    const table = el('table', { style: 'width:100%;border-collapse:collapse' });
    const thead = el('thead', {}, el('tr', { style: 'background:var(--bg-3)' },
      el('th', { style: 'text-align:left;padding:10px;font-size:12px;color:var(--text-dim)' }, 'Agente'),
      el('th', { style: 'text-align:right;padding:10px;font-size:12px;color:var(--text-dim)' }, 'Vendas'),
      el('th', { style: 'text-align:right;padding:10px;font-size:12px;color:var(--text-dim)' }, 'Receita'),
      el('th', { style: 'text-align:right;padding:10px;font-size:12px;color:var(--text-dim)' }, 'Atividades'),
      el('th', { style: 'text-align:right;padding:10px;font-size:12px;color:var(--text-dim)' }, 'Tarefas'),
    ));
    const tbody = el('tbody', {});
    for (const r of (dashboard.rows || [])) {
      tbody.append(el('tr', { style: 'border-top:1px solid var(--border)' },
        el('td', { style: 'padding:10px;font-weight:600' }, r.agentName),
        el('td', { style: 'padding:10px;text-align:right' }, String(r.dealsWon || 0)),
        el('td', { style: 'padding:10px;text-align:right;color:var(--green)' }, fmtMoney(r.revenueCents || 0)),
        el('td', { style: 'padding:10px;text-align:right' }, String(r.activities || 0)),
        el('td', { style: 'padding:10px;text-align:right' }, String(r.tasksCompleted || 0)),
      ));
    }
    table.append(thead, tbody);
    grid.append(table);
    container.append(grid);

    // Goals
    container.append(el('h3', { style: 'margin:0 0 12px' }, '🎯 Metas'));
    if (!goals.goals?.length) container.append(el('div', { style: 'color:var(--text-dim);padding:14px;background:var(--bg-2);border-radius:8px;margin-bottom:24px' }, 'Nenhuma meta criada. Clique em "+ Meta"'));
    else {
      const gContainer = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-bottom:24px' });
      for (const g of goals.goals) {
        const prog = await api(`/goals/${g.id}/progress`).catch(() => ({ percent: 0, currentValue: 0 }));
        gContainer.append(el('div', { style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px' },
          el('div', { style: 'font-weight:600;margin-bottom:6px' }, g.title || `${g.kind} ${g.target}`),
          el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:8px' }, `${prog.currentValue || 0} / ${g.target} • ${g.period}`),
          el('div', { style: 'background:var(--bg-1);height:8px;border-radius:4px;overflow:hidden' },
            el('div', { style: `background:var(--purple);height:100%;width:${Math.min(100, prog.percent || 0)}%` }),
          ),
          el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:4px;text-align:right' }, `${prog.percent || 0}%`),
        ));
      }
      container.append(gContainer);
    }

    // Badges catalog
    container.append(el('h3', { style: 'margin:0 0 12px' }, '🏅 Conquistas Disponíveis'));
    if (!badges.badges?.length) container.append(el('div', { style: 'color:var(--text-dim);padding:14px;background:var(--bg-2);border-radius:8px' }, 'Nenhum badge. Clique em "Badges Default"'));
    else {
      const bContainer = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px' });
      for (const b of badges.badges) {
        bContainer.append(el('div', { style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;text-align:center' },
          el('div', { style: 'font-size:32px;margin-bottom:6px' }, b.icon || '🏆'),
          el('div', { style: 'font-weight:600' }, b.name),
          el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:4px' }, b.description || ''),
        ));
      }
      container.append(bContainer);
    }
  } catch (e) { container.innerHTML = '<div style="padding:40px;color:#ef4444">' + e.message + '</div>'; }
}

function openNewGoalModal() {
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/goals', { method: 'POST', body: {
        title: fd.get('title'), kind: fd.get('kind'),
        target: Number(fd.get('target')), period: fd.get('period'),
        agentId: fd.get('agentId') || undefined,
      } });
      backdrop.remove(); renderPerformanceView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('title', 'Título', { attrs: { placeholder: 'Ex: 10 vendas em janeiro' } }),
    selectField('kind', 'Métrica', [
      { value: 'deals_won', label: 'Vendas (deals_won)' },
      { value: 'revenue', label: 'Receita' },
      { value: 'activities', label: 'Atividades' },
      { value: 'tasks_completed', label: 'Tarefas concluídas' },
      { value: 'calls', label: 'Ligações' },
      { value: 'meetings', label: 'Reuniões' },
    ], 'deals_won'),
    inputField('target', 'Meta numérica', { attrs: { type: 'number', required: true } }),
    selectField('period', 'Período', [
      { value: 'day', label: 'Diário' }, { value: 'week', label: 'Semanal' },
      { value: 'month', label: 'Mensal' }, { value: 'quarter', label: 'Trimestral' },
      { value: 'year', label: 'Anual' },
    ], 'month'),
    inputField('agentId', 'ID do agente (opcional, vazio = equipe)', {}),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Criar Meta'),
  );
  const { backdrop } = openModal({ title: 'Nova Meta', bodyEl: form });
}

// ═════════ SEGURANÇA ═════════════════════════════════════════════════════
async function renderSecurityView() {
  const container = $('#securityContent');
  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim)">Carregando...</div>';
  try {
    const roles = await api('/security/roles').catch(() => ({ roles: [] }));
    const ipList = await api('/security/ip-whitelist').catch(() => ({ entries: [] }));

    container.innerHTML = '';

    // Roles
    container.append(el('h3', { style: 'margin:0 0 12px' }, '👥 Roles (RBAC)'));
    if (!roles.roles?.length) container.append(el('div', { style: 'color:var(--text-dim);padding:14px;background:var(--bg-2);border-radius:8px;margin-bottom:24px' }, 'Nenhuma role. Clique em "Roles Default" pra criar owner/admin/agent/viewer'));
    else {
      for (const r of roles.roles) {
        container.append(el('div', {
          style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer',
          on: {
            contextmenu: (e) => showContextMenu(e, [
              { label: '👁️ Ver permissions', action: () => alert(JSON.stringify(r.permissions, null, 2)) },
              { label: '🗑️ Deletar', danger: true, action: async () => {
                if (!confirm('Deletar role?')) return;
                await api(`/security/roles/${r.id}`, { method: 'DELETE' }); renderSecurityView();
              } },
            ]),
          },
        },
          el('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
            el('div', {},
              el('div', { style: 'font-weight:600' }, r.name + (r.isAdmin ? ' 👑' : '')),
              el('div', { style: 'font-size:11px;color:var(--text-dim)' }, r.description || ''),
            ),
            el('span', { style: 'background:var(--purple);color:#fff;padding:3px 10px;border-radius:12px;font-size:11px' }, `${r.permissions.length} permissões`),
          ),
        ));
      }
    }

    // IP Whitelist
    container.append(el('h3', { style: 'margin:24px 0 12px' }, '🌐 IP Whitelist'));
    if (!ipList.entries?.length) container.append(el('div', { style: 'color:var(--text-dim);padding:14px;background:var(--bg-2);border-radius:8px' }, 'Nenhum IP. Vazio = todos liberados.'));
    else {
      for (const ip of ipList.entries) {
        container.append(el('div', {
          style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;cursor:pointer',
          on: {
            contextmenu: (e) => showContextMenu(e, [
              { label: '🗑️ Remover', danger: true, action: async () => {
                await api(`/security/ip-whitelist/${ip.id}`, { method: 'DELETE' }); renderSecurityView();
              } },
            ]),
          },
        },
          el('code', { style: 'font-family:monospace' }, ip.cidr),
          el('span', { style: 'font-size:11px;color:var(--text-dim)' }, ip.label || ''),
        ));
      }
    }
  } catch (e) { container.innerHTML = '<div style="padding:40px;color:#ef4444">' + e.message + '</div>'; }
}

function openNewRoleModal() {
  const allPerms = [
    'contacts.read', 'contacts.write', 'contacts.delete',
    'cards.read', 'cards.write', 'cards.delete', 'cards.move',
    'activities.read', 'activities.write',
    'proposals.read', 'proposals.write', 'proposals.sign_admin',
    'documents.read', 'documents.write', 'documents.sign_admin',
    'campaigns.read', 'campaigns.write', 'campaigns.send',
    'reports.read', 'reports.export',
    'agents.read', 'agents.write',
    'admin.full',
  ];
  const checks = el('div', { style: 'max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px' });
  for (const p of allPerms) {
    const id = 'perm_' + p.replace(/\./g, '_');
    checks.append(el('label', { style: 'display:block;font-size:12px;padding:3px 0' },
      el('input', { type: 'checkbox', value: p, id, style: 'margin-right:8px' }),
      p,
    ));
  }
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const perms = [...checks.querySelectorAll('input:checked')].map(i => i.value);
    try {
      await api('/security/roles', { method: 'POST', body: {
        name: fd.get('name'), description: fd.get('description'),
        permissions: perms, isAdmin: perms.includes('admin.full'),
      } });
      backdrop.remove(); renderSecurityView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('name', 'Nome *', { required: true, attrs: { placeholder: 'manager' } }),
    inputField('description', 'Descrição', {}),
    el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:6px' }, 'Permissions:'),
    checks,
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Criar Role'),
  );
  const { backdrop } = openModal({ title: 'Nova Role', bodyEl: form, width: '560px' });
}

function openNewIpWhitelistModal() {
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/security/ip-whitelist', { method: 'POST', body: {
        cidr: fd.get('cidr'), label: fd.get('label'),
      } });
      backdrop.remove(); renderSecurityView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    inputField('cidr', 'CIDR ou IP *', { required: true, attrs: { placeholder: '192.168.1.0/24 ou 10.0.0.5' } }),
    inputField('label', 'Label', { attrs: { placeholder: 'Escritório SP' } }),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Adicionar'),
  );
  const { backdrop } = openModal({ title: 'Nova entrada IP Whitelist', bodyEl: form });
}

async function openAuditLogModal() {
  const data = await api('/security/audit?limit=100').catch(() => ({ entries: [] }));
  const body = el('div', { style: 'max-height:500px;overflow:auto' });
  if (!data.entries?.length) body.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Audit log vazio'));
  else {
    for (const e of data.entries) {
      body.append(el('div', { style: 'border-bottom:1px solid var(--border);padding:8px 0' },
        el('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px' },
          el('code', { style: 'background:var(--purple);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px' }, e.action),
          el('span', { style: 'color:var(--text-dim)' }, new Date(e.created_at).toLocaleString('pt-BR')),
        ),
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:4px' },
          `${e.entity}: ${e.entity_id || '-'} • actor: ${e.actor_agent_id || 'sistema'} • IP: ${e.ip || '-'}`),
      ));
    }
  }
  openModal({ title: '📜 Audit Log (últimos 100)', bodyEl: body, width: '720px' });
}

// ═════════ PRIVACIDADE / LGPD ════════════════════════════════════════════
async function renderPrivacyView() {
  const container = $('#privacyContent');
  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim)">Carregando...</div>';
  try {
    const policies = await api('/compliance/retention-policies').catch(() => ({ policies: [] }));
    const unsubs = await api('/unsubscribes').catch(() => ({ unsubscribes: [] }));

    container.innerHTML = '';

    // Banner LGPD
    container.append(el('div', { style: 'background:linear-gradient(135deg,#3b82f6,#1e40af);color:#fff;padding:18px;border-radius:10px;margin-bottom:20px' },
      el('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px' }, '⚖️ Conformidade LGPD'),
      el('div', { style: 'font-size:12px;opacity:.9' }, 'Sistema cobre Art 7-8 (consentimento) · Art 15 (retenção) · Art 18 V (portabilidade) · Art 18 VI (esquecimento) · Art 37 (registros)'),
    ));

    // Retention policies
    container.append(el('h3', { style: 'margin:0 0 12px' }, '🗄️ Políticas de Retenção'));
    if (!policies.policies?.length) container.append(el('div', { style: 'color:var(--text-dim);padding:14px;background:var(--bg-2);border-radius:8px;margin-bottom:24px' }, 'Nenhuma política. Crie pra auto-deletar dados antigos.'));
    else {
      for (const p of policies.policies) {
        container.append(el('div', {
          style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;cursor:pointer',
          on: {
            contextmenu: (e) => showContextMenu(e, [
              { label: '🗑️ Deletar', danger: true, action: async () => {
                await api(`/compliance/retention-policies/${p.id}`, { method: 'DELETE' }); renderPrivacyView();
              } },
            ]),
          },
        },
          el('div', {},
            el('div', { style: 'font-weight:600' }, p.entity),
            el('div', { style: 'font-size:11px;color:var(--text-dim)' }, `Manter por ${p.daysToKeep} dias` + (p.autoAnonymize ? ' • Anonimizar' : '')),
          ),
          el('span', { style: `padding:3px 10px;border-radius:12px;font-size:11px;background:${p.enabled ? '#10b98120' : '#64748b20'};color:${p.enabled ? '#10b981' : '#64748b'}` }, p.enabled ? 'ATIVO' : 'INATIVO'),
        ));
      }
    }

    // Per-contact tools
    container.append(el('h3', { style: 'margin:24px 0 12px' }, '👤 Ferramentas por Contato'));
    container.append(el('div', { style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px' },
      el('div', { style: 'font-size:13px;color:var(--text-dim);margin-bottom:8px' }, 'Digite o ID do contato para acessar consentimentos, exportação ou direito ao esquecimento:'),
      el('div', { style: 'display:flex;gap:8px' },
        el('input', { type: 'text', id: 'lgpdContactInput', placeholder: 'crm_contact_xxx', style: 'flex:1;padding:10px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:6px' }),
        el('button', {
          style: 'padding:10px 16px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600',
          on: { click: () => {
            const cid = $('#lgpdContactInput').value.trim();
            if (cid) openLgpdContactModal(cid);
          } },
        }, 'Abrir'),
      ),
    ));

    // Unsubs
    container.append(el('h3', { style: 'margin:24px 0 12px' }, '🚫 Opt-outs (Unsubscribes)'));
    container.append(el('div', { style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:14px' },
      el('div', { style: 'font-size:13px;color:var(--text-dim);margin-bottom:6px' }, `${unsubs.unsubscribes?.length || 0} emails que cancelaram inscrição`),
      ...(unsubs.unsubscribes || []).slice(0, 5).map(u => el('div', { style: 'font-size:11px;font-family:monospace;color:var(--text-dim);padding:2px 0' }, u.email + ' • ' + new Date(u.created_at).toLocaleDateString('pt-BR'))),
    ));
  } catch (e) { container.innerHTML = '<div style="padding:40px;color:#ef4444">' + e.message + '</div>'; }
}

async function openLgpdContactModal(contactId) {
  const body = el('div', {});
  try {
    const consents = await api(`/contacts/${contactId}/consents`).catch(() => ({ consents: [] }));
    body.append(el('h4', { style: 'margin:0 0 8px' }, '✅ Consentimentos'));
    if (!consents.consents?.length) body.append(el('div', { style: 'color:var(--text-dim);font-size:12px;padding:8px' }, 'Nenhum consentimento registrado'));
    else for (const c of consents.consents) {
      body.append(el('div', { style: 'border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:4px;font-size:12px' },
        `${c.channel}/${c.purpose}: ${c.granted ? '✅' : '❌'} (${c.source})`));
    }

    body.append(el('h4', { style: 'margin:16px 0 8px' }, '🔧 Ações'));
    body.append(el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px' },
      el('button', {
        style: 'padding:10px;background:var(--blue);color:#fff;border:0;border-radius:6px;cursor:pointer',
        on: { click: () => window.open(API_BASE + `/contacts/${contactId}/portability?format=download`, '_blank') },
      }, '📤 Exportar (JSON)'),
      el('button', {
        style: 'padding:10px;background:#f59e0b;color:#fff;border:0;border-radius:6px;cursor:pointer',
        on: { click: async () => {
          if (!confirm('Anonimizar este contato? PII será removida (nome, email, phone). Estrutura mantida.')) return;
          try {
            await api(`/contacts/${contactId}/forget`, { method: 'POST', body: { mode: 'anonymize' } });
            toast('Contato anonimizado', 'success');
            backdrop.remove();
          } catch (err) { toast('Erro: ' + err.message, 'error'); }
        } },
      }, '🥸 Anonimizar'),
      el('button', {
        style: 'padding:10px;background:#ef4444;color:#fff;border:0;border-radius:6px;cursor:pointer;grid-column:span 2',
        on: { click: async () => {
          if (!confirm('DELETAR PERMANENTEMENTE este contato e TODOS os dados (cards/atividades/notas)? Sem volta.')) return;
          try {
            await api(`/contacts/${contactId}/forget`, { method: 'POST', body: { mode: 'delete' } });
            toast('Contato deletado', 'success');
            backdrop.remove();
          } catch (err) { toast('Erro: ' + err.message, 'error'); }
        } },
      }, '🗑️ Direito ao Esquecimento (DELETE)'),
    ));
  } catch (e) { body.append(el('div', { style: 'color:#ef4444' }, e.message)); }
  const { backdrop } = openModal({ title: 'LGPD: ' + contactId, bodyEl: body, width: '560px' });
}

function openNewRetentionModal() {
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/compliance/retention-policies', { method: 'POST', body: {
        entity: fd.get('entity'),
        daysToKeep: Number(fd.get('days')),
        autoAnonymize: fd.get('autoAnon') === 'on',
      } });
      backdrop.remove(); renderPrivacyView();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });
  form.append(
    selectField('entity', 'Entidade', [
      { value: 'activities', label: 'Atividades (mensagens, notas)' },
      { value: 'consents', label: 'Consentimentos revogados' },
      { value: 'data_access_log', label: 'Logs de acesso' },
      { value: 'deletion_requests', label: 'Solicitações de deleção' },
      { value: 'contacts_inactive', label: 'Contatos inativos' },
    ], 'activities'),
    inputField('days', 'Manter por (dias) *', { attrs: { type: 'number', required: true, placeholder: '180' } }),
    el('label', { style: 'display:block;margin:8px 0 14px;font-size:13px' },
      el('input', { type: 'checkbox', name: 'autoAnon', style: 'margin-right:6px' }),
      'Auto-anonimizar (em vez de deletar)',
    ),
    el('button', { type: 'submit', style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer' }, 'Criar Política'),
  );
  const { backdrop } = openModal({ title: 'Nova Política de Retenção', bodyEl: form });
}

async function openDeletionsModal() {
  const data = await api('/compliance/deletion-requests').catch(() => ({ requests: [] }));
  const body = el('div', {});
  if (!data.requests?.length) body.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Nenhuma solicitação'));
  else {
    for (const r of data.requests) {
      body.append(el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:6px' },
        el('div', { style: 'display:flex;justify-content:space-between' },
          el('div', { style: 'font-weight:600' }, r.contactId),
          el('span', { style: 'font-size:11px;color:var(--text-dim)' }, r.status),
        ),
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:4px' },
          `Solicitado por: ${r.requestedByEmail} • Modo: ${r.mode} • Executa: ${new Date(r.scheduledFor).toLocaleString('pt-BR')}`),
      ));
    }
  }
  openModal({ title: '🗑️ Solicitações de Deleção', bodyEl: body, width: '560px' });
}

// ═════════ LIXEIRA ═══════════════════════════════════════════════════════
async function renderTrashView() {
  const container = $('#trashContent');
  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim)">Carregando...</div>';
  try {
    const counts = await api('/trash');
    container.innerHTML = '';
    const entities = ['cards', 'contacts', 'activities', 'tasks', 'appointments', 'documents', 'proposals'];
    container.append(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:20px' },
      ...entities.map(e => {
        const tableName = 'crm_' + e;
        const n = counts.counts?.[tableName] || 0;
        return el('div', {
          style: `background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;cursor:${n > 0 ? 'pointer' : 'default'};opacity:${n > 0 ? 1 : .5}`,
          on: n > 0 ? { click: () => showTrashEntity(e) } : {},
        },
          el('div', { style: 'font-size:12px;color:var(--text-dim);text-transform:capitalize' }, e),
          el('div', { style: 'font-size:24px;font-weight:700;color:var(--purple)' }, String(n)),
        );
      }),
    ));
  } catch (e) { container.innerHTML = '<div style="padding:40px;color:#ef4444">' + e.message + '</div>'; }
}

async function showTrashEntity(entity) {
  const data = await api(`/trash/${entity}?limit=200`);
  const body = el('div', { style: 'max-height:500px;overflow:auto' });
  if (!data.items?.length) body.append(el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Vazio'));
  else {
    for (const it of data.items) {
      body.append(el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center' },
        el('div', {},
          el('div', { style: 'font-size:13px;font-weight:600' }, it.title || it.name || it.id),
          el('div', { style: 'font-size:10px;color:var(--text-dim)' }, 'Deletado: ' + new Date(it.deleted_at).toLocaleString('pt-BR')),
        ),
        el('div', { style: 'display:flex;gap:6px' },
          el('button', {
            style: 'background:var(--green);color:#fff;border:0;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px',
            on: { click: async () => {
              await api(`/trash/${entity}/${it.id}/restore`, { method: 'POST' });
              renderTrashView();
            } },
          }, 'Restaurar'),
          el('button', {
            style: 'background:#ef4444;color:#fff;border:0;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px',
            on: { click: async () => {
              if (!confirm('DELETAR permanentemente?')) return;
              await api(`/trash/${entity}/${it.id}/purge`, { method: 'DELETE' });
              renderTrashView();
            } },
          }, 'Purgar'),
        ),
      ));
    }
  }
  openModal({ title: `🗑️ Lixeira: ${entity}`, bodyEl: body, width: '640px' });
}

// ═════════ CARD SIDE PANEL: ABA AI / VÍNCULOS / COMENTÁRIOS ═══════════
async function renderAITab(card) {
  const sec = $('#aiSection');
  if (!sec) return;
  sec.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Calculando...</div>';
  try {
    const score = await api(`/ai/cards/${card.id}/score`).catch(() => null);
    const classify = await api(`/ai/cards/${card.id}/classify`).catch(() => null);
    sec.innerHTML = '';
    sec.append(el('div', { style: 'padding:14px' },
      el('div', { style: 'background:var(--bg-3);padding:12px;border-radius:8px;margin-bottom:10px' },
        el('div', { style: 'font-size:11px;color:var(--text-dim);text-transform:uppercase' }, 'Lead Score'),
        el('div', { style: `font-size:28px;font-weight:700;color:${score?.insight?.scoreNumeric > 60 ? 'var(--green)' : score?.insight?.scoreNumeric > 30 ? 'var(--amber)' : '#ef4444'}` },
          (score?.insight?.scoreNumeric || 0) + '/100'),
      ),
      classify?.insight ? el('div', { style: 'background:var(--bg-3);padding:12px;border-radius:8px;margin-bottom:10px' },
        el('div', { style: 'font-size:11px;color:var(--text-dim);text-transform:uppercase' }, 'Classificação'),
        el('div', { style: 'font-size:18px;font-weight:600;text-transform:uppercase;color:' + ({ hot: '#ef4444', warm: '#f59e0b', cold: '#3b82f6' }[classify.insight.contentText] || 'var(--text)') }, classify.insight.contentText),
      ) : null,
      el('button', {
        style: 'width:100%;padding:10px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;margin-bottom:6px',
        on: { click: () => openCardAIInsights(card.id) },
      }, '🧠 Análise completa'),
      el('button', {
        style: 'width:100%;padding:10px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer',
        on: { click: async () => {
          toast('Gerando próximo passo...', 'info');
          const r = await api(`/ai/cards/${card.id}/next-step`, { method: 'POST', body: {} }).catch(() => null);
          if (r?.insight?.contentText) alert('💡 ' + r.insight.contentText);
        } },
      }, '💡 Sugerir próximo passo'),
    ));
  } catch (e) { sec.innerHTML = '<div style="padding:20px;color:#ef4444">' + e.message + '</div>'; }
}

async function renderLinksTab(card) {
  const sec = $('#linksSection');
  if (!sec) return;
  sec.innerHTML = '<div style="padding:20px;color:var(--text-dim);text-align:center">Carregando...</div>';
  try {
    const tasks = await api(`/cards/${card.id}/tasks`).catch(() => ({ tasks: [] }));
    const docs = await api(`/cards/${card.id}/documents`).catch(() => ({ documents: [] }));
    const props = await api(`/cards/${card.id}/proposals`).catch(() => ({ proposals: [] }));
    sec.innerHTML = '';
    const wrap = el('div', { style: 'padding:14px' });
    wrap.append(el('h4', { style: 'margin:0 0 8px;font-size:13px' }, '✅ Tarefas (' + (tasks.tasks?.length || 0) + ')'));
    if (tasks.tasks?.length) {
      for (const t of tasks.tasks) {
        wrap.append(el('div', { style: 'background:var(--bg-3);padding:8px;border-radius:4px;margin-bottom:4px;font-size:12px' },
          el('div', { style: 'font-weight:600' }, t.title),
          el('div', { style: 'color:var(--text-dim);font-size:11px' }, `${t.priority} • ${t.status}`),
        ));
      }
    }
    wrap.append(el('h4', { style: 'margin:16px 0 8px;font-size:13px' }, '📄 Documentos (' + (docs.documents?.length || 0) + ')'));
    if (docs.documents?.length) {
      for (const d of docs.documents) {
        wrap.append(el('div', { style: 'background:var(--bg-3);padding:8px;border-radius:4px;margin-bottom:4px;font-size:12px' },
          el('div', { style: 'font-weight:600' }, d.title + ' v' + d.version),
          el('div', { style: 'color:var(--text-dim);font-size:11px' }, d.status),
        ));
      }
    }
    wrap.append(el('h4', { style: 'margin:16px 0 8px;font-size:13px' }, '💼 Propostas (' + (props.proposals?.length || 0) + ')'));
    if (props.proposals?.length) {
      for (const p of props.proposals) {
        wrap.append(el('div', { style: 'background:var(--bg-3);padding:8px;border-radius:4px;margin-bottom:4px;font-size:12px' },
          el('div', { style: 'font-weight:600' }, 'v' + p.version + ' — ' + fmtMoney(p.totalCents || 0)),
          el('div', { style: 'color:var(--text-dim);font-size:11px' }, p.status),
        ));
      }
    }
    sec.append(wrap);
  } catch (e) { sec.innerHTML = '<div style="padding:20px;color:#ef4444">' + e.message + '</div>'; }
}

async function renderCommentsTab(card) {
  const sec = $('#commentsSection');
  if (!sec) return;
  sec.innerHTML = '<div style="padding:20px;color:var(--text-dim)">Carregando...</div>';
  try {
    const r = await api(`/cards/${card.id}/comments`);
    sec.innerHTML = '';
    const wrap = el('div', { style: 'padding:14px' });
    if (!r.comments?.length) wrap.append(el('div', { style: 'color:var(--text-dim);padding:14px;text-align:center;font-size:13px' }, 'Nenhum comentário'));
    else for (const c of r.comments) {
      wrap.append(el('div', { style: 'background:var(--bg-3);padding:10px;border-radius:6px;margin-bottom:6px' },
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:4px' },
          (c.authorAgentId || 'sistema') + ' • ' + new Date(c.createdAt).toLocaleString('pt-BR')),
        el('div', { style: 'font-size:13px' }, c.content),
        c.mentions?.length ? el('div', { style: 'font-size:11px;color:var(--purple);margin-top:4px' }, '@ ' + c.mentions.join(', @')) : null,
      ));
    }
    // New comment form
    const form = el('form', { style: 'margin-top:14px', on: { submit: async (e) => {
      e.preventDefault();
      const ta = form.querySelector('textarea');
      if (!ta.value.trim()) return;
      try {
        await api(`/cards/${card.id}/comments`, { method: 'POST', body: { content: ta.value } });
        renderCommentsTab(card);
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    } } });
    form.append(
      el('textarea', { rows: 3, placeholder: 'Comentário (use @nome para mencionar agentes)', style: 'width:100%;padding:8px;background:var(--bg-1);border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:inherit;font-size:13px;box-sizing:border-box' }),
      el('button', { type: 'submit', style: 'margin-top:6px;padding:8px 16px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px' }, 'Comentar'),
    );
    wrap.append(form);
    sec.append(wrap);
  } catch (e) { sec.innerHTML = '<div style="padding:20px;color:#ef4444">' + e.message + '</div>'; }
}

// Hook: when openCardPanel runs, populate the new tabs (AI/Links/Comments)
// IMPORTANT: original openCardPanel(cardId) is async and sets state.currentCard
// = {card, contact, activities}. Do NOT overwrite that.
if (typeof openCardPanel === 'function' && !openCardPanel._wrapped) {
  const origFn = openCardPanel;
  window.openCardPanel = async function(cardOrId) {
    // Accept either string id (legacy) or full card object (Onda 37 callers)
    const cardId = (cardOrId && typeof cardOrId === 'object') ? cardOrId.id : cardOrId;
    await origFn.call(this, cardId);
    // After original sets state.currentCard properly, render extra tabs
    const cur = state.currentCard?.card;
    if (cur) {
      renderAITab(cur).catch(() => {});
      renderLinksTab(cur).catch(() => {});
      renderCommentsTab(cur).catch(() => {});
    }
  };
  window.openCardPanel._wrapped = true;
}

// ═════════ HOOK: ROTAS NOVAS NO showView ════════════════════════════════
const _origShowView = (typeof showView === 'function') ? showView : null;
if (_origShowView && !_origShowView._wrappedV37) {
  window.showView = async function(viewName) {
    await _origShowView(viewName);
    if (viewName === 'search') { wireGlobalSearch(); }
    else if (viewName === 'insights') { renderInsightsView(); }
    else if (viewName === 'performance') { renderPerformanceView(); }
    else if (viewName === 'security') { renderSecurityView(); }
    else if (viewName === 'privacy') { renderPrivacyView(); }
    else if (viewName === 'trash') { renderTrashView(); }
  };
  window.showView._wrappedV37 = true;
}

// ═════════ WIRE BUTTONS NOVOS ═══════════════════════════════════════════
function wireOnda37Buttons() {
  $('#batchScoreBtn')?.addEventListener('click', async () => {
    toast('Re-scorando 20 cards...', 'info');
    try { await api('/ai/batch-score', { method: 'POST', body: { limit: 20 } }); toast('Pronto', 'success'); renderInsightsView(); }
    catch (e) { toast('Erro: ' + e.message, 'error'); }
  });
  $('#perfPeriod')?.addEventListener('change', renderPerformanceView);
  $('#newGoalBtn')?.addEventListener('click', openNewGoalModal);
  $('#seedBadgesBtn')?.addEventListener('click', async () => {
    try { await api('/badges/seed-defaults', { method: 'POST', body: {} }); toast('Badges criados', 'success'); renderPerformanceView(); }
    catch (e) { toast('Erro: ' + e.message, 'error'); }
  });
  $('#seedRolesBtn')?.addEventListener('click', async () => {
    try { await api('/security/roles/seed-defaults', { method: 'POST', body: {} }); toast('Roles criadas', 'success'); renderSecurityView(); }
    catch (e) { toast('Erro: ' + e.message, 'error'); }
  });
  $('#newRoleBtn')?.addEventListener('click', openNewRoleModal);
  $('#newIpBtn')?.addEventListener('click', openNewIpWhitelistModal);
  $('#auditLogBtn')?.addEventListener('click', openAuditLogModal);
  $('#newRetentionBtn')?.addEventListener('click', openNewRetentionModal);
  $('#viewDeletionsBtn')?.addEventListener('click', openDeletionsModal);
}

document.addEventListener('DOMContentLoaded', wireOnda37Buttons);
if (document.readyState !== 'loading') wireOnda37Buttons();

// ═════════ KANBAN: RIGHT-CLICK NO CARD ══════════════════════════════════
function wireKanbanContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    const cardEl = e.target.closest('.kanban-card, [data-card-id]');
    if (!cardEl) return;
    const cardId = cardEl.dataset.cardId || cardEl.getAttribute('data-card-id');
    if (!cardId) return;
    const card = (state.cards || []).find(c => c.id === cardId);
    if (!card) return;
    showContextMenu(e, [
      { label: '✏️ Abrir card', action: () => openCardPanel(card) },
      { label: '🧠 AI Insights', action: () => openCardAIInsights(card.id) },
      { label: '✅ Nova tarefa pra este card', action: () => openTaskEditModal({ cardId: card.id, contactId: card.contactId }) },
      { label: '📄 Novo documento pra este card', action: () => openDocumentEditModal({ cardId: card.id, contactId: card.contactId }) },
      '-',
      { label: '🗑️ Deletar', danger: true, action: async () => {
        if (!confirm('Deletar card?')) return;
        await api(`/cards/${card.id}`, { method: 'DELETE' });
        if (state.currentBoardId) { await loadPipeline(state.currentBoardId); renderKanban(); }
      } },
    ]);
  });
}
wireKanbanContextMenu();

// ═══ ONDA 38: AUTH-AWARE MEDIA LOADER ════════════════════════════════
// O endpoint /v1/crm/media/:tenantId/:date/:filename requer Bearer token.
// Browsers nao mandam Authorization em <audio src>/<img src>, entao
// fazemos fetch com auth, criamos blob URL e setamos como src.
const _mediaBlobCache = new Map();

async function loadMediaWithAuth(mediaUrl, el) {
  if (!mediaUrl || !el) return;
  if (_mediaBlobCache.has(mediaUrl)) {
    el.src = _mediaBlobCache.get(mediaUrl);
    return;
  }
  // Strip /v1/crm prefix if present (api() prepends API_BASE)
  const path = mediaUrl.startsWith(API_BASE) ? mediaUrl.slice(API_BASE.length) : mediaUrl.replace(/^\/v1\/crm/, '');
  try {
    const r = await fetch(API_BASE + path, { headers: { Authorization: 'Bearer ' + state.apiKey } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    _mediaBlobCache.set(mediaUrl, url);
    el.src = url;
  } catch (e) {
    console.warn('[media-load]', mediaUrl, e.message);
    if (el.tagName === 'IMG') el.alt = 'Erro carregando midia';
  }
}

async function downloadMediaWithAuth(mediaUrl, filename) {
  const path = mediaUrl.startsWith(API_BASE) ? mediaUrl.slice(API_BASE.length) : mediaUrl.replace(/^\/v1\/crm/, '');
  try {
    const r = await fetch(API_BASE + path, { headers: { Authorization: 'Bearer ' + state.apiKey } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'media';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

// Cleanup blob URLs quando trocar de card
if (typeof closeCardPanel === 'function' && !closeCardPanel._cleanupWired) {
  const _origCloseCardPanel = closeCardPanel;
  window.closeCardPanel = function() {
    for (const url of _mediaBlobCache.values()) URL.revokeObjectURL(url);
    _mediaBlobCache.clear();
    return _origCloseCardPanel.call(this);
  };
  window.closeCardPanel._cleanupWired = true;
}


// ═══ ONDA 39: CHANNEL/INSTANCE FILTER NO KANBAN ════════════════════════
let _channelFilter = '';

async function populateChannelFilter() {
  const sel = $('#channelFilterSelect');
  if (!sel) return;
  // Keep current selection
  const current = sel.value || '';
  // Remove previously dynamic options (keep "Todas")
  while (sel.options.length > 1) sel.remove(1);
  try {
    const channels = state.channels || (await api('/channels')).channels || [];
    state.channels = channels;
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      const statusEmoji = ch.status === 'active' ? '🟢' : ch.status === 'pending' ? '🟡' : '🔴';
      opt.textContent = `${statusEmoji} ${ch.name}` + (ch.phoneNumber ? ` (${ch.phoneNumber})` : '');
      sel.append(opt);
    }
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }
  } catch (e) { console.warn('[channelFilter] load failed:', e.message); }
}

// Override loadPipeline to honor _channelFilter
const _origLoadPipeline = (typeof loadPipeline === 'function') ? loadPipeline : null;
if (_origLoadPipeline && !_origLoadPipeline._wrappedV39) {
  window.loadPipeline = async function(boardId) {
    if (!boardId) return;
    const q = _channelFilter ? `?channelId=${encodeURIComponent(_channelFilter)}` : '';
    const r = await api(`/boards/${boardId}/pipeline${q}`);
    state.pipeline = r;
  };
  window.loadPipeline._wrappedV39 = true;
}

function wireChannelFilter() {
  const sel = $('#channelFilterSelect');
  if (!sel || sel._wired) return;
  sel._wired = true;
  sel.addEventListener('change', async () => {
    _channelFilter = sel.value;
    if (state.currentBoardId) {
      await loadPipeline(state.currentBoardId);
      renderKanban();
      // Visual feedback
      const txt = _channelFilter ? sel.options[sel.selectedIndex].textContent : 'Todas as instâncias';
      toast(`Filtro: ${txt}`, 'info');
    }
  });
}

// Hook: ao iniciar e cada vez que voltar pro kanban, popular o seletor
const _origShowViewV39 = (typeof showView === 'function') ? showView : null;
if (_origShowViewV39 && !_origShowViewV39._wrappedV39) {
  window.showView = async function(viewName) {
    await _origShowViewV39(viewName);
    if (viewName === 'kanban') {
      await populateChannelFilter();
      wireChannelFilter();
    }
  };
  window.showView._wrappedV39 = true;
}

// Tambem popular logo apos boot
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    populateChannelFilter().catch(() => {});
    wireChannelFilter();
  }, 1500);
});
if (document.readyState !== 'loading') {
  setTimeout(() => {
    populateChannelFilter().catch(() => {});
    wireChannelFilter();
  }, 1500);
}


// ═══ ONDA 41/43: MOBILE SIDEBAR TOGGLE (event delegation) ═════════════
// Usa delegation no document — funciona mesmo se botao foi adicionado
// dinamicamente apos o boot ou antes do JS rodar.
function _toggleMobileSidebar(open) {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;
  const shouldOpen = open !== undefined ? open : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', shouldOpen);
  if (backdrop) backdrop.style.display = shouldOpen ? 'block' : 'none';
  // Tambem inline transform pra garantir override CSS
  sidebar.style.transform = shouldOpen ? 'translateX(0)' : '';
}

// Click delegation — qualquer click no document
document.addEventListener('click', (e) => {
  // Hamburger toggle
  if (e.target.closest('#sidebarToggle, .sidebar-toggle')) {
    e.preventDefault();
    e.stopPropagation();
    _toggleMobileSidebar();
    return;
  }
  // Backdrop click → fecha
  if (e.target.closest('#sidebarBackdrop, .sidebar-backdrop')) {
    _toggleMobileSidebar(false);
    return;
  }
  // Nav-item click no mobile → auto-fecha
  if (window.innerWidth <= 768 && e.target.closest('.sidebar .nav-item')) {
    setTimeout(() => _toggleMobileSidebar(false), 100);
  }
}, true); // capture phase pra pegar antes de outros handlers

// Reset ao entrar/sair de modo mobile
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) _toggleMobileSidebar(false);
});


// ═══ ONDA 42: CHANNEL INBOX CONFIG (auto-create leads) ════════════════
async function openChannelInboxConfig(channel) {
  const body = el('div', { id: 'inbox-config-body', style: 'min-height:200px' },
    el('div', { style: 'padding:20px;text-align:center;color:var(--text-dim)' }, 'Carregando...'),
  );
  const { backdrop } = openModal({ title: '⚙️ Inbox: ' + channel.name, bodyEl: body, width: '640px' });

  try {
    const info = await api(`/channels/${channel.id}/webhook-info`);
    const boards = (await api('/boards').catch(() => ({ boards: [] }))).boards || [];

    body.innerHTML = '';

    // Webhook URL — copiavel
    body.append(el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:8px;margin-bottom:14px' },
      el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase' }, '🔗 URL do Webhook (cole na Z-API / Meta)'),
      el('div', { style: 'display:flex;gap:6px;align-items:center' },
        el('input', { type: 'text', value: info.url, readonly: '', style: 'flex:1;padding:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:monospace;font-size:11px', on: { click: (e) => e.target.select() } }),
        el('button', { style: 'padding:8px 14px;background:var(--purple);color:#fff;border:0;border-radius:6px;cursor:pointer', on: { click: async () => {
          try { await navigator.clipboard.writeText(info.url); toast('Copiado!', 'success'); } catch { toast('Selecione e copie manualmente', 'info'); }
        } } }, '📋'),
      ),
      el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:8px' },
        'Última mensagem recebida: ',
        el('span', { style: info.lastInboundAt ? 'color:var(--green)' : 'color:#ef4444' },
          info.lastInboundAt ? new Date(info.lastInboundAt).toLocaleString('pt-BR') : '⚠️ Nunca (webhook não configurado?)'),
      ),
    ));

    // Auto-create toggle
    const autoCreateCheckbox = el('input', { type: 'checkbox', id: 'autoCreateChk', style: 'margin-right:8px' });
    autoCreateCheckbox.checked = info.autoCreateCards !== false;
    body.append(el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:8px;margin-bottom:14px' },
      el('label', { style: 'display:flex;align-items:center;cursor:pointer' },
        autoCreateCheckbox,
        el('div', {},
          el('div', { style: 'font-weight:600' }, '🤖 Criar card automaticamente para novo lead'),
          el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:2px' }, 'Toda mensagem nova de contato sem card aberto vira um card na coluna "Lead novo"'),
        ),
      ),
    ));

    // Board + column selector
    const boardSel = el('select', { id: 'inboxBoardSel', style: 'width:100%;padding:10px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:6px;margin-bottom:8px' });
    boardSel.append(el('option', { value: '' }, '— Padrão (Pipeline de Vendas) —'));
    for (const b of boards) {
      const opt = el('option', { value: b.id }, b.name);
      if (b.id === info.inboxBoardId) opt.selected = true;
      boardSel.append(opt);
    }

    const colSel = el('select', { id: 'inboxColSel', style: 'width:100%;padding:10px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:6px' });

    async function reloadCols() {
      colSel.innerHTML = '';
      colSel.append(el('option', { value: '' }, '— Padrão (Lead novo) —'));
      const bid = boardSel.value || boards[0]?.id;
      if (!bid) return;
      try {
        const r = await api(`/boards/${bid}/columns`).catch(() => ({ columns: [] }));
        for (const col of (r.columns || [])) {
          const opt = el('option', { value: col.id }, col.name);
          if (col.id === info.inboxColumnId) opt.selected = true;
          colSel.append(opt);
        }
      } catch {}
    }
    boardSel.addEventListener('change', reloadCols);
    reloadCols();

    body.append(el('div', { style: 'background:var(--bg-1);padding:14px;border-radius:8px;margin-bottom:14px' },
      el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase' }, '📍 Onde criar novos leads'),
      el('label', { style: 'font-size:13px;display:block;margin-bottom:4px' }, 'Quadro'),
      boardSel,
      el('label', { style: 'font-size:13px;display:block;margin-bottom:4px' }, 'Coluna'),
      colSel,
    ));

    // Save button
    body.append(el('button', {
      style: 'width:100%;padding:12px;background:var(--purple);color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer;margin-bottom:14px',
      on: { click: async () => {
        try {
          await api(`/channels/${channel.id}/inbox-config`, { method: 'PATCH', body: {
            autoCreateCards: autoCreateCheckbox.checked,
            inboxBoardId: boardSel.value || null,
            inboxColumnId: colSel.value || null,
          } });
          toast('Salvo!', 'success');
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
      } },
    }, '💾 Salvar configuração'));

    // Diagnostics: simulate inbound
    body.append(el('hr', { style: 'border:0;border-top:1px solid var(--border);margin:14px 0' }));
    body.append(el('h4', { style: 'margin:0 0 8px;font-size:13px' }, '🧪 Simular mensagem recebida'));
    body.append(el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:10px' }, 'Útil pra testar se a auto-criação está funcionando'));

    const simPhone = el('input', { type: 'text', placeholder: '5511900000000', value: '5511' + Math.floor(Math.random() * 900000000 + 100000000), style: 'width:100%;padding:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:6px;margin-bottom:6px' });
    const simName = el('input', { type: 'text', placeholder: 'Nome do contato', value: 'Lead Teste ' + Date.now().toString().slice(-4), style: 'width:100%;padding:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:6px;margin-bottom:6px' });
    const simText = el('input', { type: 'text', placeholder: 'Mensagem', value: 'Olá, vim pelo site!', style: 'width:100%;padding:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text);border-radius:6px;margin-bottom:6px' });
    const simBtn = el('button', {
      style: 'width:100%;padding:10px;background:transparent;border:1px solid var(--purple);color:var(--purple);border-radius:6px;cursor:pointer',
      on: { click: async () => {
        simBtn.disabled = true; simBtn.textContent = 'Disparando...';
        try {
          const r = await api(`/channels/${channel.id}/test-inbound`, { method: 'POST', body: {
            fromPhone: simPhone.value, fromName: simName.value, text: simText.value,
          } });
          if (r?.result?.cardId) toast('✅ Card criado: ' + r.result.cardId, 'success');
          else if (r?.result?.contactId) toast('✅ Activity logada (sem card por config)', 'success');
          else toast('Disparado, ver resultado', 'info');
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
        finally { simBtn.disabled = false; simBtn.textContent = '🚀 Disparar simulação'; }
      } },
    }, '🚀 Disparar simulação');
    body.append(simPhone, simName, simText, simBtn);
  } catch (e) {
    body.innerHTML = '<div style="padding:20px;color:#ef4444">Erro: ' + e.message + '</div>';
  }
}

// Patch renderChannelsList: adicionar botao "⚙️ Config Inbox" em cada canal
const _origRenderChannelsList = (typeof renderChannelsList === 'function') ? renderChannelsList : null;
if (_origRenderChannelsList && !_origRenderChannelsList._wrappedV42) {
  window.renderChannelsList = function(...args) {
    _origRenderChannelsList.apply(this, args);
    // Apos renderizar, injeta botao em cada list-item
    setTimeout(() => {
      document.querySelectorAll('#channelsList .list-item').forEach((item, idx) => {
        if (item.querySelector('.inbox-config-btn')) return;
        const ch = state.channels?.[idx];
        if (!ch) return;
        const btn = document.createElement('button');
        btn.className = 'inbox-config-btn';
        btn.textContent = '⚙️ Inbox';
        btn.style.cssText = 'background:var(--purple);color:#fff;border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:6px';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openChannelInboxConfig(ch);
        });
        item.appendChild(btn);
      });
    }, 50);
  };
  window.renderChannelsList._wrappedV42 = true;
}


// ═══ ONDA 48: SSE + NOTIFICATIONS + BEEP ═══════════════════════════════
(function onda48Realtime() {
  const state48 = { es: null, audioCtx: null, notifPerm: Notification.permission };

  function beep() {
    try {
      if (!state48.audioCtx) state48.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = state48.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      // Tom estilo WhatsApp: 2 beeps curtos 800Hz/1000Hz
      [800, 1000].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.15);
        gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + i * 0.15 + 0.02);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.15 + 0.12);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime + i * 0.15 + 0.13);
      });
    } catch {}
  }

  function askNotifPerm() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => { state48.notifPerm = p; });
    }
  }

  function showNotification(data) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = data.contactName || data.cardTitle || 'Nova mensagem WhatsApp';
    const bodyPreview = data.mediaType && data.mediaType !== 'text'
      ? `[${data.mediaType.toUpperCase()}] ${data.preview || ''}`.trim()
      : (data.preview || 'Mensagem nova');
    try {
      const n = new Notification(title, {
        body: bodyPreview,
        icon: '/crm/icon-192.png',
        badge: '/crm/icon-192.png',
        tag: 'wa-' + (data.cardId || ''),
        renotify: true,
      });
      n.onclick = () => {
        window.focus();
        if (data.cardId && typeof openCardPanel === 'function') openCardPanel(data.cardId);
        n.close();
      };
    } catch (e) { console.warn('[onda48] notif failed', e); }
  }

  function connect() {
    const token = (window.state && window.state.apiKey) || localStorage.getItem('clow_crm_key') || window.__CRM_API_KEY__ || '';
    if (!token) { setTimeout(connect, 3000); return; }
    try {
      if (state48.es) state48.es.close();
      state48.es = new EventSource(`/v1/crm/events?token=${encodeURIComponent(token)}`);
      state48.es.addEventListener('message.in', (ev) => {
        if (window.__onda49) window.__onda49.lastSseMsg = Date.now();
        try {
          const data = JSON.parse(ev.data);
          const openCardId = window.state?.currentCard?.card?.id;
          if (data.cardId !== openCardId) {
            beep();
            showNotification(data);
          }
          // Onda 52: smart refresh — preserva scroll + skip se interagindo
          if (typeof window.__smartRefresh === 'function') {
            window.__smartRefresh('sse:message.in');
          }
        } catch (e) { console.warn('[onda48] message.in parse', e); }
      });
      state48.es.addEventListener('message.read', (ev) => {
        try {
          if (typeof window.__smartRefresh === 'function') {
            window.__smartRefresh('sse:message.read');
          }
        } catch {}
      });
      state48.es.onerror = () => {
        try { state48.es.close(); } catch {}
        setTimeout(connect, 5000); // reconnect
      };
    } catch (e) {
      console.warn('[onda48] SSE connect failed', e);
      setTimeout(connect, 5000);
    }
  }

  function init() {
    askNotifPerm();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expor pra debugging
  window.__onda48 = { beep, showNotification, connect };
})();
// ═══════════════════════════════════════════════════════════════════════


// ═══ ONDA 49: MOBILE SYNC + PUSH NOTIFICATIONS ═══════════════════════
(function onda49Mobile() {
  const sync49 = { lastRefresh: 0, pollTimer: null, sseAlive: false };

  function getToken() {
    return (window.state && window.state.apiKey) || localStorage.getItem('clow_crm_key') || '';
  }

  async function forceRefresh(reason) {
    const now = Date.now();
    if (now - sync49.lastRefresh < 2000) return;
    sync49.lastRefresh = now;
    try {
      // Onda 52: smart refresh preserva scroll e checa interacao
      if (typeof window.__smartRefresh === 'function') {
        await window.__smartRefresh('o49:' + reason);
      } else if (window.state?.currentBoardId && typeof loadPipeline === 'function') {
        await loadPipeline(window.state.currentBoardId);
        if (typeof renderKanban === 'function') renderKanban();
      }
      if (window.state?.currentCard && typeof refreshCurrentCard === 'function') {
        await refreshCurrentCard();
      }
    } catch (e) { console.warn('[onda49] refresh failed:', e); }
  }

  // Auto-refresh quando usuario volta pro app (mobile suspende tabs em bg)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      forceRefresh('visibility');
      // Reconnect SSE se estava morto
      if (!sync49.sseAlive && window.__onda48?.connect) {
        try { window.__onda48.connect(); } catch {}
      }
    }
  });

  // Polling fallback — 30s quando SSE nao confirma vivo
  function startPolling() {
    if (sync49.pollTimer) return;
    sync49.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && !sync49.sseAlive) {
        forceRefresh('polling');
      }
    }, 90000); // Onda 52: 30s → 90s (menos agressivo)
  }
  startPolling();

  // Marcar SSE vivo quando recebe evento
  ['message.in', 'message.read', 'activity'].forEach(ev => {
    window.addEventListener('_onda49_sse_' + ev, () => { sync49.sseAlive = true; });
  });

  // Hook: re-emitir eventos SSE como custom events pra que onda49 saiba
  // que SSE ta recebendo (indicador de conexao viva)
  setTimeout(() => {
    if (window.__onda48 && !window.__onda49_hooked) {
      window.__onda49_hooked = true;
      // Monkey-patch: sempre que onda48 SSE dispara, marcar vivo
      const origConnect = window.__onda48.connect;
      if (origConnect) {
        window.__onda48.connect = function() {
          origConnect.call(this);
          // Piggyback no EventSource — checar sseAlive periodicamente
          setInterval(() => {
            // Heartbeat check: se recebemos qualquer dado nos ultimos 60s
            // (eventos OU comments do server), sse esta vivo
            const now = Date.now();
            sync49.sseAlive = (now - sync49.lastSseMsg) < 60000;
          }, 10000);
        };
      }
    }
  }, 3000);

  // ═══ PUSH NOTIFICATIONS ═══════════════════════════════════════════
  async function registerPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[onda49] push nao suportado');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();

      if (!sub) {
        // Fetch VAPID pub key
        const token = getToken();
        if (!token) { setTimeout(registerPush, 5000); return; }
        const r = await fetch('/v1/crm/push/vapid-public-key', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (!r.ok) { console.warn('[onda49] sem VAPID'); return; }
        const { publicKey } = await r.json();
        if (!publicKey) { console.warn('[onda49] VAPID vazio'); return; }

        // Converter b64url → Uint8Array
        const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);

        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: arr,
        });
      }

      // POST pra subscribe
      const subJson = sub.toJSON();
      await fetch('/v1/crm/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getToken(),
        },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          p256dh: subJson.keys.p256dh,
          auth: subJson.keys.auth,
          ua: navigator.userAgent,
        }),
      });
      console.log('[onda49] push subscription registrada');
    } catch (e) {
      console.warn('[onda49] push register falhou:', e);
    }
  }

  // Registrar SW + push (so depois de login)
  async function initPush() {
    if (!('serviceWorker' in navigator)) return;
    try {
      // Garantir SW registrado
      const regs = await navigator.serviceWorker.getRegistrations();
      if (!regs.some(r => r.active && (r.scope.endsWith('/') || r.scope.includes('/crm')))) {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      }
      // Esperar login (state.apiKey existir)
      const waitLogin = setInterval(() => {
        if (getToken()) {
          clearInterval(waitLogin);
          // Esperar permission granted (Onda 48 ja pede)
          if (Notification.permission === 'granted') {
            registerPush();
          } else {
            const check = setInterval(() => {
              if (Notification.permission === 'granted') {
                clearInterval(check);
                registerPush();
              }
            }, 2000);
          }
        }
      }, 500);
    } catch (e) { console.warn('[onda49] SW init failed:', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPush);
  } else {
    initPush();
  }

  window.__onda49 = { registerPush, forceRefresh };
})();
// ═══════════════════════════════════════════════════════════════════════


// ═══ ONDA 52: SCROLL STABILITY (no mais salto pro topo) ════════════
(function onda52ScrollStable() {
  const stable = {
    interactingUntil: 0,
    pendingRefresh: null,
    lastSnapshot: '',
  };

  // Marcar interacao por 8s a cada touch/scroll/click
  function markInteracting(ms = 8000) {
    stable.interactingUntil = Date.now() + ms;
  }

  ['touchstart', 'touchmove', 'wheel', 'scroll', 'mousedown'].forEach(ev => {
    window.addEventListener(ev, () => markInteracting(), { passive: true, capture: true });
  });

  function isInteracting() {
    return Date.now() < stable.interactingUntil;
  }

  // Snapshot dos scrolls atuais
  function snapshotScrolls() {
    const snap = {
      win: window.scrollY,
      body: document.body.scrollTop,
      cols: [],
      kanbanBoard: null,
    };
    document.querySelectorAll('.col-body').forEach(el => {
      snap.cols.push({ id: el.getAttribute('data-column-id') || el.dataset.columnId || '', top: el.scrollTop });
    });
    const board = document.querySelector('.kanban-board, #kanban');
    if (board) {
      snap.kanbanBoard = { left: board.scrollLeft, top: board.scrollTop };
    }
    return snap;
  }

  function restoreScrolls(snap) {
    try {
      // Restaura proximo frame, depois do reflow
      requestAnimationFrame(() => {
        if (snap.win) window.scrollTo({ top: snap.win, behavior: 'instant' });
        if (snap.body) document.body.scrollTop = snap.body;
        snap.cols.forEach(c => {
          const el = c.id ? document.querySelector(`.col-body[data-column-id="${c.id}"]`) : null;
          if (el) el.scrollTop = c.top;
        });
        const board = document.querySelector('.kanban-board, #kanban');
        if (board && snap.kanbanBoard) {
          board.scrollLeft = snap.kanbanBoard.left;
          board.scrollTop = snap.kanbanBoard.top;
        }
      });
    } catch (e) { /* noop */ }
  }

  // Wrap render que preserva scroll. Usado pelos auto-refresh.
  window.__renderKanbanPreserve = function() {
    if (typeof renderKanban !== 'function') return;
    const snap = snapshotScrolls();
    renderKanban();
    restoreScrolls(snap);
  };

  // Hash simples do pipeline pra detectar se mudou de fato
  function pipelineHash() {
    try {
      const s = window.state;
      if (!s?.pipeline) return '';
      const parts = [];
      for (const col of s.pipeline.columns) {
        const cards = s.pipeline.cardsByColumn[col.id] || [];
        for (const c of cards) {
          parts.push(`${c.id}:${c.position}:${c.unreadCount || 0}:${c.lastActivityAt || 0}`);
        }
      }
      return parts.join('|');
    } catch { return ''; }
  }

  // Refresh inteligente:
  //  - Se user interagindo, agenda pra quando ficar idle
  //  - Se hash igual ao anterior, skip render
  //  - Senao, snapshot scroll + render + restore
  window.__smartRefresh = async function smartRefresh(reason) {
    if (isInteracting()) {
      // Agendar pra daqui 9s (apos interactingUntil)
      if (stable.pendingRefresh) clearTimeout(stable.pendingRefresh);
      const delay = Math.max(stable.interactingUntil - Date.now() + 1000, 1000);
      stable.pendingRefresh = setTimeout(() => smartRefresh('deferred:' + reason), delay);
      return;
    }
    stable.pendingRefresh = null;
    try {
      const s = window.state;
      if (s?.currentBoardId && typeof loadPipeline === 'function') {
        await loadPipeline(s.currentBoardId);
        const newHash = pipelineHash();
        if (newHash === stable.lastSnapshot) {
          // Nada mudou — pular re-render (preserva scroll automaticamente)
          return;
        }
        stable.lastSnapshot = newHash;
        if (typeof renderKanban === 'function') {
          const snap = snapshotScrolls();
          renderKanban();
          restoreScrolls(snap);
        }
      }
    } catch (e) { console.warn('[onda52] smartRefresh:', e); }
  };

  // Replace as chamadas dos blocos onda48/onda49 que fazem renderKanban
  // direto — proximo evento, vao usar __smartRefresh em vez disso.
  window.__onda52 = { snapshotScrolls, restoreScrolls, isInteracting, markInteracting, pipelineHash };
})();
// ═══════════════════════════════════════════════════════════════════════


// ═══ ONDA 53: WhatsApp limits + pre-modal de escolha ═══════════════════
async function loadMyInfo() {
  try {
    const r = await api('/me');
    window.state.me = r;
    return r;
  } catch (e) {
    console.warn('[onda53] loadMyInfo failed:', e && e.message || e);
    // Fallback resiliente: nunca derrubar fluxo do front
    const fb = {
      _fallback: true,
      tenant: { id: null, tier: 'unknown', status: 'unknown', hasStripe: false },
      whatsapp: { included: 1, max: 999, zapiCount: 0, metaCount: 0, totalUsed: 0, extraPaid: 0, available: 999, pricePerExtraBrl: 100 },
    };
    window.state.me = fb;
    return fb;
  }
}

function renderChannelsLimitsBadge() {
  const me = window.state.me;
  if (!me?.whatsapp || me._fallback) return null; // Onda 53j: nao renderizar badge se /me falhou
  const wa = me.whatsapp;
  const fullLabel = wa.totalUsed + ' de ' + wa.max + ' numeros conectados';
  const tierLabel = (me.tenant?.tier || '').toUpperCase();
  const color = wa.available === 0 ? '#EF4444' : (wa.available <= 1 ? '#F59E0B' : '#22C55E');
  return el('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 14px;background:rgba(155,89,252,0.06);border:1px solid rgba(155,89,252,0.18);border-radius:10px;margin-bottom:14px;font-size:13px' },
    el('div', { style: 'display:flex;align-items:center;gap:6px' },
      el('span', { style: 'width:10px;height:10px;border-radius:50%;background:' + color }),
      el('span', { style: 'color:var(--text)' }, fullLabel),
    ),
    el('span', { style: 'color:var(--text-dim);font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(155,89,252,0.15);text-transform:uppercase;letter-spacing:.4px;font-weight:700' }, 'Plano ' + tierLabel),
    me.whatsapp.extraPaid > 0 ? el('span', { style: 'color:var(--text-dim);font-size:11px' }, '· ' + me.whatsapp.extraPaid + ' adicional(is) Z-API ativo(s)') : null,
  );
}

// Pre-modal de escolha Z-API vs Meta
async function openChannelTypePicker() {
  console.log('[picker] openChannelTypePicker chamado');
  let me;
  try {
    me = await loadMyInfo();
  } catch (e) {
    console.error('[picker] loadMyInfo throw:', e);
    me = null;
  }
  if (!me || typeof me !== 'object') {
    me = { _fallback: true, tenant: { id: null, tier: 'unknown', status: 'unknown', hasStripe: false }, whatsapp: null };
  }
  if (!me.tenant) me.tenant = { id: null, tier: 'unknown', status: 'unknown', hasStripe: false };
  if (me._fallback) console.warn('[onda53] picker em modo fallback');
  const wa = me.whatsapp || { included: 1, max: 999, totalUsed: 0, available: 999, extraPaid: 0, pricePerExtraBrl: 100 };

  // Limite atingido?
  if (wa.available <= 0) {
    const dialog = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal', style: 'max-width:460px' },
      el('h3', {}, 'Limite de numeros atingido'),
      el('p', { style: 'color:var(--text-dim);line-height:1.6;font-size:13.5px' },
        'Seu plano ', el('b', {}, (me?.tenant?.tier || 'desconhecido').toUpperCase()),
        ' permite no maximo ', el('b', {}, String(wa.max)),
        ' numero(s) WhatsApp. Voce ja tem ', el('b', {}, String(wa.totalUsed)),
        ' conectado(s).'
      ),
      wa.max < 10 ? el('p', { style: 'color:var(--text-dim);font-size:13px;margin-top:10px' },
        'Pra conectar mais numeros, faca upgrade pro plano superior:'
      ) : null,
      el('div', { class: 'modal-actions', style: 'gap:8px;flex-direction:column' },
        wa.max < 10 ? el('a', { href: '/pricing', target: '_blank', class: 'confirm', style: 'display:block;text-align:center;text-decoration:none;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;padding:11px;border-radius:10px;font-weight:700' }, 'Ver planos →') : null,
        el('button', { class: 'cancel', on: { click: () => dialog.remove() } }, 'Fechar'),
      ),
    );
    dialog.append(modal);
    document.body.append(dialog);
    return;
  }

  // Mostrar picker (Z-API vs Meta)
  const isFirstNumber = wa.totalUsed === 0;
  const willCharge = !isFirstNumber; // primeiro numero e gratis (incluso); seguintes via Z-API custam R$100

  const dialog = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: 'max-width:560px' },
    el('h3', {}, 'Adicionar numero WhatsApp'),
    el('p', { style: 'color:var(--text-dim);font-size:13px;margin:8px 0 18px' },
      'Voce tem ', el('b', { style: 'color:var(--text)' }, String(wa.available)),
      ' vaga(s) disponivel(is) no plano ', el('b', { style: 'color:var(--text)' }, (me?.tenant?.tier || 'desconhecido').toUpperCase()),
      '. Escolha o tipo de conexao:'
    ),

    // OPÇÃO Z-API
    el('button', { type: 'button', class: 'channel-type-btn', style: 'width:100%;text-align:left;background:linear-gradient(135deg,rgba(37,211,102,0.08),rgba(18,140,126,0.04));border:2px solid rgba(37,211,102,0.3);padding:18px;border-radius:14px;margin-bottom:12px;cursor:pointer;color:inherit;font-family:inherit',
      on: { click: async () => {
        if (willCharge) {
          // Onda 53h: ABRIR STRIPE CHECKOUT em nova aba; polling
          // ate cliente pagar; depois libera modal de cadastro.
          dialog.remove();
          await openZapiCheckoutFlow(me);
          return;
        }
        // Primeiro numero (free) — abre modal direto
        dialog.remove();
        await openNewChannelModal('zapi');
      } } },
      el('div', { style: 'display:flex;align-items:center;gap:14px' },
        el('div', { style: 'width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#25D366,#128C7E);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:20px;flex:0 0 auto' }, 'Z'),
        el('div', { style: 'flex:1' },
          el('div', { style: 'font-weight:700;font-size:15px;margin-bottom:4px' }, 'Z-API ' + (isFirstNumber ? '(incluso no plano)' : '— adicional R$ 100/mes')),
          el('div', { style: 'font-size:12px;color:var(--text-dim);line-height:1.5' },
            isFirstNumber
              ? 'Seu numero incluso no plano. Conecta via QR Code, sem cobranca extra.'
              : 'Numero adicional gerenciado por nos. Cobranca recorrente R$ 100/mes via Stripe Checkout.'
          ),
        ),
      ),
    ),

    // OPÇÃO Meta Cloud API
    el('button', { type: 'button', class: 'channel-type-btn-NEW', style: 'width:100%;text-align:left;background:linear-gradient(135deg,rgba(24,119,242,0.08),rgba(13,86,184,0.04));border:2px solid rgba(24,119,242,0.3);padding:18px;border-radius:14px;cursor:pointer;color:inherit;font-family:inherit',
      on: { click: async () => {
        dialog.remove();
        await openNewChannelModal('meta');
      } } },
      el('div', { style: 'display:flex;align-items:center;gap:14px' },
        el('div', { style: 'width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#1877F2,#0d56b8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px;flex:0 0 auto' }, 'M'),
        el('div', { style: 'flex:1' },
          el('div', { style: 'font-weight:700;font-size:15px;margin-bottom:4px' }, 'Meta Cloud API oficial — gratis'),
          el('div', { style: 'font-size:12px;color:var(--text-dim);line-height:1.5' },
            'Voce traz suas credenciais da Meta. Sem custo nosso (paga so as taxas da Meta direto, ~R$ 0,30/conversa iniciada).'
          ),
        ),
      ),
    ),

    el('div', { class: 'modal-actions', style: 'margin-top:18px' },
      el('button', { class: 'cancel', on: { click: () => dialog.remove() } }, 'Cancelar'),
    ),
  );
  try {
    dialog.append(modal);
    document.body.append(dialog);
  } catch (e) {
    console.error('[picker] erro ao montar modal:', e);
    toast('Erro ao abrir picker. Veja o console.', 'error');
  }
}

// Onda 53h: fluxo Stripe Checkout pra Z-API adicional
async function openZapiCheckoutFlow(me) {
  if (!me?.tenant?.id) { toast('Tenant nao identificado', 'error'); return; }

  // Caso admin/sem-subscription: cobra direto sem checkout (modo legacy)
  if (!me.tenant.hasStripe) {
    const confirmed = await confirmDialog(
      'Adicionar numero (modo admin)',
      'Sua conta nao tem assinatura Stripe ativa. Adicionando direto sem cobranca.',
      'Adicionar'
    );
    if (!confirmed) return;
    await openNewChannelModal('zapi');
    return;
  }

  // Mostrar overlay de carregamento
  const loadingDialog = el('div', { class: 'modal-backdrop' });
  const loadingModal = el('div', { class: 'modal', style: 'max-width:420px;text-align:center' },
    el('div', { style: 'width:48px;height:48px;margin:0 auto 16px;border:3px solid rgba(155,89,252,.25);border-top-color:#9B59FC;border-radius:50%;animation:bootspin .9s linear infinite' }),
    el('h3', {}, 'Abrindo pagamento...'),
    el('p', { style: 'color:var(--text-dim);font-size:13px' }, 'Voce sera redirecionado pro Stripe Checkout.'),
  );
  loadingDialog.append(loadingModal);
  document.body.append(loadingDialog);

  let sessionId;
  try {
    const r = await fetch('/api/billing/whatsapp-addon/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.state.apiKey, 'x-clow-tenant-id': me.tenant.id },
      body: JSON.stringify({ tenantId: me.tenant.id, currentTotal: me.whatsapp.totalUsed }),
    });
    const data = await r.json();
    if (!r.ok || !data.url) {
      loadingDialog.remove();
      toast('Erro ao criar checkout: ' + (data.message || data.error || 'desconhecido'), 'error');
      return;
    }
    sessionId = data.session_id;
    // Abrir Stripe em nova aba
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    loadingDialog.remove();
    toast('Erro de rede: ' + e.message, 'error');
    return;
  }

  loadingDialog.remove();

  // Modal de "aguardando pagamento" com polling
  const waitDialog = el('div', { class: 'modal-backdrop' });
  let cancelled = false;
  const waitModal = el('div', { class: 'modal', style: 'max-width:480px;text-align:center' },
    el('div', { style: 'width:48px;height:48px;margin:0 auto 16px;border:3px solid rgba(34,197,94,.25);border-top-color:#22C55E;border-radius:50%;animation:bootspin .9s linear infinite' }),
    el('h3', {}, 'Aguardando pagamento...'),
    el('p', { style: 'color:var(--text-dim);font-size:13px;line-height:1.6' },
      'Complete o pagamento na aba do Stripe que acabou de abrir.',
      el('br', {}),
      'Apos confirmacao, esta tela libera o cadastro do numero automaticamente.'
    ),
    el('div', { class: 'modal-actions', style: 'margin-top:20px' },
      el('button', { class: 'cancel', on: { click: () => { cancelled = true; waitDialog.remove(); } } }, 'Cancelar'),
    ),
  );
  waitDialog.append(waitModal);
  document.body.append(waitDialog);

  // Polling: a cada 3s checa se o pagamento foi confirmado
  let attempts = 0;
  const maxAttempts = 200; // 10 minutos
  const poll = setInterval(async () => {
    if (cancelled) { clearInterval(poll); return; }
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(poll);
      waitDialog.remove();
      toast('Tempo esgotado. Recarregue a pagina e tente de novo.', 'error');
      return;
    }
    try {
      const r = await fetch('/api/billing/whatsapp-addon/checkout-status?session_id=' + encodeURIComponent(sessionId), {
        headers: { 'Authorization': 'Bearer ' + window.state.apiKey, 'x-clow-tenant-id': me.tenant.id },
      });
      const data = await r.json();
      if (data.paid) {
        clearInterval(poll);
        waitDialog.remove();
        toast('Pagamento confirmado! Configure agora seu numero.', 'success');
        await openNewChannelModal('zapi');
      }
    } catch {}
  }, 3000);
}

async function openBillingPortal() {
  try {
    const me = window.state.me || await loadMyInfo();
    if (!me?.tenant?.id) { toast('Tenant nao identificado', 'error'); return; }
    const r = await fetch('/api/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.state.apiKey, 'x-clow-tenant-id': me.tenant.id },
      body: JSON.stringify({ tenantId: me.tenant.id }),
    });
    const data = await r.json();
    if (data.url) {
      window.open(data.url, '_blank');
    } else {
      toast('Erro ao abrir portal: ' + (data.message || data.error), 'error');
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
}

// Wrap renderChannelsList pra adicionar badge no topo
const _originalRenderChannelsList_o53 = window.renderChannelsList;
window.renderChannelsList = function() {
  if (typeof _originalRenderChannelsList_o53 === 'function') _originalRenderChannelsList_o53();
  // Inserir badge no topo da view Channels (acima do #channelsList)
  const list = document.getElementById('channelsList');
  if (!list) return;
  const existing = document.getElementById('chLimitsBadge');
  if (existing) existing.remove();
  const badge = renderChannelsLimitsBadge();
  if (badge) {
    badge.id = 'chLimitsBadge';
    list.parentNode.insertBefore(badge, list);
  }
};

// Hook: quando entrar na view channels, recarregar /me primeiro
const _originalShowView_o53 = window.showView;
if (typeof _originalShowView_o53 === 'function') {
  window.showView = async function(name) {
    if (name === 'channels') {
      await loadMyInfo();
    }
    return _originalShowView_o53.apply(this, arguments);
  };
}

window.__onda53 = { loadMyInfo, openChannelTypePicker, openBillingPortal, renderChannelsLimitsBadge };
// ═══════════════════════════════════════════════════════════════════════

// Onda 53g: interceptar click do #newChannelBtn no capture phase pra
// abrir picker ANTES do handler antigo. openNewChannelModal eh funcao
// local do modulo (nao exposta em window) entao monkey-patch nao
// funciona; event delegation com capture eh a forma robusta.
(function interceptNewChannelClick() {
  if (window.__newChannelIntercepted_o53g) return;
  window.__newChannelIntercepted_o53g = true;
  document.addEventListener('click', function(ev) {
    const btn = ev.target.closest('#newChannelBtn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (typeof openChannelTypePicker === 'function') {
      openChannelTypePicker();
    } else {
      console.warn('[onda53g] openChannelTypePicker indisponivel');
    }
  }, true); // capture = roda antes do handler bubble do wire(...)
  console.log('[onda53g] click #newChannelBtn interceptado em capture');
})();


