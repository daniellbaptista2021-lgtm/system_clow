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
  return c;
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
    l.append(el('div', { class: 'list-item', style: 'cursor:default;flex-direction:column;align-items:stretch' },
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
      el('div', { style: 'margin-top:8px;display:flex;gap:6px' },
        el('button', { class: 'save-btn', style: 'flex:1;background:transparent;border:1px solid var(--red);color:var(--red)', on: { click: async () => {
          if (!await confirmDialog('Remover canal', `Apagar canal "${ch.name}"? Atividades antigas permanecem.`, 'Apagar')) return;
          await api(`/channels/${ch.id}`, { method: 'DELETE' });
          await loadChannels();
          renderChannelsList();
          toast('Canal removido', 'success');
        } } }, 'Remover'),
      ),
    ));
  }
}

async function openNewChannelModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const form = el('form', { on: { submit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const type = fd.get('type');
    const credentials = type === 'meta' ? {
      accessToken: fd.get('metaToken'),
      phoneNumberId: fd.get('metaPhoneId'),
      verifyToken: fd.get('metaVerify') || `cw_${Date.now()}`,
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
      } });
      backdrop.remove();
      await loadChannels();
      renderChannelsList();
      toast(`Canal criado. Use o webhook URL mostrado na lista pra conectar no ${type === 'meta' ? 'Meta' : 'Z-API'}.`, 'success');
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  } } });

  let fieldsMeta = el('div', { style: 'display:none' },
    field('Access Token', 'metaToken', 'text', ''),
    field('Phone Number ID', 'metaPhoneId', 'text', ''),
    field('Verify Token (use ao configurar no Meta)', 'metaVerify', 'text', 'clow_verify_' + Math.random().toString(36).slice(2, 10)),
  );
  let fieldsZapi = el('div', { style: 'display:none' },
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
          fieldsMeta.style.display = e.target.value === 'meta' ? '' : 'none';
          fieldsZapi.style.display = e.target.value === 'zapi' ? '' : 'none';
        } } },
          el('option', { value: '' }, 'Selecione...'),
          el('option', { value: 'meta' }, 'Meta Cloud API (oficial)'),
          el('option', { value: 'zapi' }, 'Z-API'),
        );
        return sel;
      })(),
    ),
    fieldsMeta,
    fieldsZapi,
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
      el('button', { type: 'submit', class: 'confirm' }, 'Criar'),
    ),
  );

  backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Novo canal WhatsApp'), form));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

function renderAgentsList() {
  const l = $('#agentsList');
  l.innerHTML = '';
  if (!state.agents.length) { l.append(el('div', { class: 'empty' }, 'Nenhum agente cadastrado.')); return; }
  for (const a of state.agents) {
    l.append(el('div', { class: 'list-item' },
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
    l.append(el('div', { class: 'list-item' },
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

// ─── Event wiring ──────────────────────────────────────────────────────
function wireEvents() {
  // Login
  $('#loginForm').addEventListener('submit', async (e) => {
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
  $('#logoutBtn').addEventListener('click', logout);

  // Nav
  $$('.nav-item').forEach(n => n.addEventListener('click', () => showView(n.dataset.view)));

  // Refresh
  $('#refreshBtn').addEventListener('click', async () => {
    await loadPipeline(state.currentBoardId);
    renderKanban();
    toast('Atualizado', 'success');
  });

  // Buttons (all "new" buttons in views)
  $('#newCardBtn').addEventListener('click', () => openNewCardModal());
  $('#newChannelBtn')?.addEventListener('click', openNewChannelModal);
  $('#newContactBtn')?.addEventListener('click', openNewContactModal);
  $('#newAgentBtn')?.addEventListener('click', openNewAgentModal);
  $('#newInventoryBtn')?.addEventListener('click', openNewInventoryModal);

  // Side panel
  $('#closePanelBtn').addEventListener('click', closeCardPanel);
  $$('.panel-tab').forEach(t => t.addEventListener('click', () => {
    $$('.panel-tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.tab-section').forEach(s => s.classList.toggle('active', s.dataset.tab === t.dataset.tab));
  }));

  // Composer
  $('#sendMsgBtn').addEventListener('click', () => {
    const txt = $('#composerText').value.trim();
    if (txt) sendCurrentMessage(txt);
  });
  $('#composerText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const txt = $('#composerText').value.trim();
      if (txt) sendCurrentMessage(txt);
    }
  });
  $('#attachBtn').addEventListener('click', () => $('#attachFile').click());
  $('#attachFile').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadAndSendFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#recordBtn').addEventListener('click', toggleRecording);

  // Contact search
  $('#contactSearchInput')?.addEventListener('input', async (e) => {
    clearTimeout(window.__searchT);
    window.__searchT = setTimeout(async () => {
      await loadContacts(e.target.value);
      renderContactsList();
    }, 250);
  });
}

// ─── Boot ──────────────────────────────────────────────────────────────
(async () => {
  wireEvents();
  if (state.apiKey) {
    try {
      await attemptLogin(state.apiKey);
      $('#loginScreen').classList.add('hide');
      $('#app').classList.remove('hide');
      await bootstrap();
    } catch {
      // key invalid, stay on login
      $('#apiKeyInput').value = state.apiKey;
    }
  }
})();


window.__crmRefresh = async function() { try { if (state.currentBoardId) { await loadPipeline(state.currentBoardId); renderKanban(); } if (state.currentCard) { await refreshCurrentCard(); } } catch(e){} };
window.__crmAppReady = true;
