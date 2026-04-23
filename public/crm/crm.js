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
      if ($('#kanbanView').classList.contains('active')) {
        await loadPipeline(state.currentBoardId);
        renderKanban();
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

  positionMenu(menu, x, y);
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
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
  positionMenu(menu, x, y);
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
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
  positionMenu(menu, x, y);
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
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


// ─── Side panel ────────────────────────────────────────────────────────
async function openCardPanel(cardId) {
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
      bubble.append(el('div', { class: 'msg-media' }, el('img', { src: a.mediaUrl, loading: 'lazy' })));
    } else if (a.mediaUrl && a.mediaType === 'audio') {
      bubble.append(el('div', { class: 'msg-media' }, el('audio', { controls: '', src: a.mediaUrl })));
    } else if (a.mediaUrl && a.mediaType === 'video') {
      bubble.append(el('div', { class: 'msg-media' }, el('video', { controls: '', src: a.mediaUrl })));
    } else if (a.mediaUrl && a.mediaType === 'document') {
      bubble.append(el('div', { class: 'msg-media' },
        el('a', { class: 'doc', href: a.mediaUrl, target: '_blank' }, '📄 ', a.metadata?.savedFilename || 'Documento'),
      ));
    }
    if (a.content && (!a.mediaUrl || a.content !== `[${a.mediaType}]`)) {
      const textLine = el('div', {}, a.content);
      bubble.append(textLine);
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
}

function renderContactsList() {
  const l = $('#contactsList');
  l.innerHTML = '';
  if (!state.contacts.length) { l.append(el('div', { class: 'empty' }, 'Nenhum contato ainda.')); return; }
  for (const c of state.contacts) {
    l.append(el('div', { class: 'list-item', on: { click: async () => {
      // Open first card linked to this contact (or create one)
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
    ));
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


async function openNewChannelModal() {
  // Pre-generate webhook secret so we can show the URL inside the form
  const presetSecret = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  let currentType = 'zapi';

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
    l.append(el('div', { class: 'list-item', style: 'cursor:pointer', on: { click: (e) => { if (e.target.closest('button')) return; openEditAgentModal(a); } } },
      el('div', { class: 'list-item-left' },
        el('div', { class: 'contact-avatar' }, initials(a.name)),
        el('div', {},
          el('div', { class: 'list-item-title' }, a.name),
          el('div', { class: 'list-item-sub' }, `${a.email} · ${a.phone || 'sem telefone'}`),
        ),
      ),
      el('span', { class: 'pill purple' }, a.role),
    ));
  }
}

function renderInventoryList() {
  const l = $('#inventoryList');
  l.innerHTML = '';
  if (!state.inventory.length) { l.append(el('div', { class: 'empty' }, 'Estoque vazio.')); return; }
  for (const it of state.inventory) {
    l.append(el('div', { class: 'list-item', style: 'cursor:pointer', on: { click: (e) => { if (e.target.closest('button')) return; openEditInventoryModal(it); } } },
      el('div', { class: 'list-item-left' },
        el('div', {},
          el('div', { class: 'list-item-title' }, it.name),
          el('div', { class: 'list-item-sub' }, `SKU ${it.sku} · ${fmtMoney(it.priceCents)}`),
        ),
      ),
      el('span', { class: `pill ${it.stock > 5 ? 'green' : it.stock > 0 ? 'amber' : 'red'}` }, `${it.stock} em estoque`),
    ));
  }
}

async function renderStats() {
  try {
    const s = await loadStats();
    const grid = $('#statsGrid');
    grid.innerHTML = '';
    const cards = [
      { label: 'Boards', value: s.boards, color: 'var(--purple)' },
      { label: 'Cards total', value: s.totalCards, color: 'var(--blue)' },
      { label: 'Pipeline bruto', value: fmtMoney(s.totalValueCents), color: 'var(--green)' },
      { label: 'Forecast ponderado', value: fmtMoney(s.weightedValueCents), color: 'var(--amber)' },
      { label: 'Contatos', value: s.totalContacts, color: 'var(--text)' },
      { label: 'Agentes', value: s.totalAgents, color: 'var(--text)' },
      { label: 'Canais WA', value: s.totalChannels, color: 'var(--text)' },
      { label: 'Assinaturas ativas', value: s.totalSubscriptionsActive, color: 'var(--green)' },
    ];
    for (const c of cards) {
      grid.append(el('div', {
        style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:18px',
      },
        el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px' }, c.label),
        el('div', { style: `font-size:26px;font-weight:700;color:${c.color}` }, String(c.value)),
      ));
    }
  } catch (e) { toast('Erro: ' + e.message, 'error'); }
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

  // Side panel — close + tabs
  wire('#closePanelBtn', 'click', closeCardPanel);
  wireAll('.panel-tab', 'click', (e) => {
    const tab = e.currentTarget;
    const tabId = tab.dataset.tab;
    document.querySelectorAll('.panel-tab').forEach(x => x.classList.toggle('active', x === tab));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.toggle('active', s.dataset.tab === tabId));
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
