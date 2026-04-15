/**
 * app.js — System Clow Frontend Application (Modular)
 *
 * Separated from inline HTML for maintainability.
 * Modules: Auth, Sessions, Chat, UI, Markdown, Sidebar
 */

// ════════════════════════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════════════════════════

const U = location.origin;
const SESSION_TTL = 3 * 24 * 60 * 60 * 1000;
const SESSIONS_KEY = 'clow_web_sessions_v2';
const ACTIVE_SESSION_KEY = 'clow_web_active_session_v2';
const TOKEN_KEY = 'clow_token';

// ════════════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════════════

let authToken = localStorage.getItem(TOKEN_KEY);
let isProcessing = false;
let abortCtrl = null;
let currentSessionId = null;

// ════════════════════════════════════════════════════════════════════════════
// DOM References
// ════════════════════════════════════════════════════════════════════════════

const LS = document.getElementById('loginScreen');
const AP = document.getElementById('app');
const LU = document.getElementById('loginUser');
const LP = document.getElementById('loginPass');
const LE = document.getElementById('loginError');
const F = document.getElementById('feed');
const I = document.getElementById('msg');
const B = document.getElementById('btn');
const W = document.getElementById('wel');
const recentList = document.getElementById('recentList');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebarOverlay');

// ════════════════════════════════════════════════════════════════════════════
// Tool Labels (i18n pt-BR)
// ════════════════════════════════════════════════════════════════════════════

const TL = {
  Read: 'Leu um arquivo', FileRead: 'Leu um arquivo',
  Bash: 'Executou comando',
  Edit: 'Editou um arquivo', FileEdit: 'Editou um arquivo',
  Write: 'Criou um arquivo', FileWrite: 'Criou um arquivo',
  Glob: 'Buscou arquivos', Grep: 'Pesquisou no codigo',
  Agent: 'Iniciou subagente',
  WebFetch: 'Acessou URL', WebSearch: 'Pesquisou na web',
  Download: 'Preparou download', TodoWrite: 'Atualizou tarefas',
  EnterPlanMode: 'Entrou em modo de plano',
  ExitPlanMode: 'Tentou aprovar o plano',
};

// ════════════════════════════════════════════════════════════════════════════
// Auth Module
// ════════════════════════════════════════════════════════════════════════════

function authHeaders() {
  return authToken
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }
    : { 'Content-Type': 'application/json' };
}

async function doLogin() {
  const u = LU.value.trim(), p = LP.value.trim();
  if (!u || !p) { LE.textContent = 'Preencha todos os campos'; return; }
  document.getElementById('loginBtn').disabled = true;
  LE.textContent = '';
  try {
    const r = await fetch(`${U}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    const d = await r.json();
    if (d.ok) {
      authToken = d.token;
      localStorage.setItem(TOKEN_KEY, d.token);
      await showApp();
    } else {
      LE.textContent = d.error || 'Credenciais invalidas';
    }
  } catch (err) {
    LE.textContent = 'Erro: ' + (err.message || 'conexao falhou') + ' — tente Ctrl+Shift+R';
  }
  document.getElementById('loginBtn').disabled = false;
}

async function verifySavedLogin() {
  try {
    const r = await fetch(`${U}/auth/verify`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (r.ok) await showApp();
    else logout();
  } catch { logout(); }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
}

// ════════════════════════════════════════════════════════════════════════════
// Session Module
// ════════════════════════════════════════════════════════════════════════════

function readSessions() { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') || []; } catch { return []; } }
function writeSessions(list) { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); }

function cleanupSessions() {
  const now = Date.now();
  const cleaned = readSessions()
    .filter(s => s && s.id && s.createdAt && (now - s.createdAt) < SESSION_TTL)
    .map(s => ({ ...s, messages: Array.isArray(s.messages) ? s.messages : [] }))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  writeSessions(cleaned);
  if (currentSessionId && !cleaned.some(s => s.id === currentSessionId)) {
    currentSessionId = null;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  }
  return cleaned;
}

function getSessions() { return cleanupSessions(); }
function getSession(id = currentSessionId) { return getSessions().find(s => s.id === id) || null; }
function getLatestEmptySession() { return getSessions().find(s => (s.messages?.length || 0) === 0) || null; }

function saveSessionPatch(id, patcher) {
  const sessions = getSessions();
  const index = sessions.findIndex(s => s.id === id);
  if (index < 0) return null;
  const updated = patcher({ ...sessions[index], messages: [...sessions[index].messages] });
  sessions[index] = updated;
  sessions.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  writeSessions(sessions);
  return updated;
}

function createLocalSession(serverSessionId = '') {
  const now = Date.now();
  const session = { id: uid(), serverSessionId, title: 'Nova conversa', createdAt: now, updatedAt: now, messages: [] };
  const sessions = getSessions();
  sessions.unshift(session);
  writeSessions(sessions);
  currentSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, currentSessionId);
  renderRecent();
  return session;
}

function setServerSessionId(id, serverSessionId) {
  saveSessionPatch(id, current => ({ ...current, serverSessionId, updatedAt: current.updatedAt || Date.now() }));
}

function deleteSession(id) {
  const sessions = getSessions().filter(s => s.id !== id);
  writeSessions(sessions);
  if (currentSessionId === id) {
    currentSessionId = sessions[0]?.id || null;
    if (currentSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, currentSessionId);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  }
  renderRecent();
  renderConversation(getSession());
}

async function createServerSession() {
  const r = await fetch(`${U}/v1/sessions`, { method: 'POST', headers: authHeaders(), body: '{}' });
  if (!r.ok) { if (r.status === 401) { logout(); return ''; } throw new Error(`Erro ${r.status}`); }
  return (await r.json()).session_id || '';
}

async function ensureCurrentSession(forceNew = false) {
  let session = forceNew ? null : getSession();
  if (!session) session = createLocalSession('');
  if (session.serverSessionId && !forceNew) return session;
  const serverSessionId = await createServerSession();
  if (!serverSessionId) return session;
  setServerSessionId(session.id, serverSessionId);
  session = getSession(session.id);
  return session;
}

// ════════════════════════════════════════════════════════════════════════════
// Message Module
// ════════════════════════════════════════════════════════════════════════════

function createUserMessage(text) { return { id: uid(), role: 'user', text, createdAt: Date.now() }; }
function createAssistantMessage(text = '') { return { id: uid(), role: 'assistant', text, createdAt: Date.now() }; }
function createToolMessage(toolName, toolInput) { return { id: uid(), role: 'tool', toolName, toolInput, createdAt: Date.now() }; }
function createErrorMessage(text) { return { id: uid(), role: 'error', text, createdAt: Date.now() }; }

function appendMessage(message) {
  const session = saveSessionPatch(currentSessionId, current => {
    const messages = [...current.messages, message];
    const firstUser = messages.find(m => m.role === 'user' && m.text);
    return { ...current, messages, updatedAt: Date.now(), title: firstUser ? deriveTitle(firstUser.text) : current.title };
  });
  renderRecent();
  return session;
}

function updateAssistantMessage(messageId, text) {
  saveSessionPatch(currentSessionId, current => ({
    ...current, updatedAt: Date.now(),
    messages: current.messages.map(m => m.id === messageId ? { ...m, text } : m),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// Chat Module (SSE Streaming)
// ════════════════════════════════════════════════════════════════════════════

async function go() {
  const t = (I.value || '').trim();
  if (!t) return;
  if (!authToken) { renderErrorMessage('Sessao expirada. Faca login novamente.'); logout(); return; }

  let session;
  try { session = await ensureCurrentSession(false); } catch (e) {
    renderErrorMessage(e?.message || 'Nao foi possivel iniciar a conversa'); return;
  }
  if (!session?.serverSessionId) return;

  I.value = ''; autoResize(I);
  isProcessing = true; setBtn('stop'); closeSidebar();
  W.classList.add('hide');

  appendMessage(createUserMessage(t));
  let assistantMessage = createAssistantMessage('');
  appendMessage(assistantMessage);
  renderConversation(getSession());
  addProcessing();

  let replyEl = null;
  try {
    abortCtrl = new AbortController();
    const tm = setTimeout(() => abortCtrl.abort(), 300000);
    let r = await fetch(`${U}/v1/sessions/${session.serverSessionId}/messages`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: t }), signal: abortCtrl.signal,
    });
    clearTimeout(tm);
    document.getElementById('proc')?.remove();

    if (r.status === 404) {
      setServerSessionId(session.id, null);
      session = await ensureCurrentSession(true);
      if (session && session.serverSessionId) {
        r = await fetch(`${U}/v1/sessions/${session.serverSessionId}/messages`, {
          method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: t }),
        });
      }
    }

    if (!r.ok) {
      let msg = `Erro ${r.status}`;
      try { const d = await r.json(); msg = d.message || d.error || msg; } catch { try { msg = (await r.text()) || msg; } catch {} }
      saveSessionPatch(currentSessionId, c => ({ ...c, updatedAt: Date.now(), messages: c.messages.filter(m => m.id !== assistantMessage.id) }));
      appendMessage(createErrorMessage(msg));
      renderConversation(getSession());
      return;
    }

    if (!r.body) {
      saveSessionPatch(currentSessionId, c => ({ ...c, updatedAt: Date.now(), messages: c.messages.filter(m => m.id !== assistantMessage.id) }));
      appendMessage(createErrorMessage('Resposta vazia do servidor'));
      renderConversation(getSession());
      return;
    }

    replyEl = [...F.querySelectorAll('.rp')].pop() || null;
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', txt = '', ev = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const ln of lines) {
        if (ln.startsWith('event: ')) { ev = ln.slice(7).trim(); continue; }
        if (!ln.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(ln.slice(6));
          if (ev === 'tool_use') {
            const toolMessage = createToolMessage(d.tool_name || 'Tool', d.tool_input);
            saveSessionPatch(currentSessionId, c => ({
              ...c, updatedAt: Date.now(),
              messages: [...c.messages.filter(m => m.id !== assistantMessage.id), toolMessage, assistantMessage],
            }));
            renderConversation(getSession());
            replyEl = [...F.querySelectorAll('.rp')].pop() || replyEl;
          } else if (ev === 'text_delta') {
            txt += d.text || '';
            assistantMessage = { ...assistantMessage, text: txt };
            updateAssistantMessage(assistantMessage.id, txt);
            if (replyEl) replyEl.innerHTML = '<p>' + md(txt) + '</p>';
            scr();
          } else if (ev === 'result' && d.content) {
            txt = d.content;
            assistantMessage = { ...assistantMessage, text: txt };
            updateAssistantMessage(assistantMessage.id, txt);
            if (replyEl) replyEl.innerHTML = '<p>' + md(txt) + '</p>';
            scr();
          } else if (ev === 'error') {
            saveSessionPatch(currentSessionId, c => ({ ...c, updatedAt: Date.now(), messages: c.messages.filter(m => m.id !== assistantMessage.id) }));
            appendMessage(createErrorMessage(d.message || d.content || 'Erro durante o processamento'));
            renderConversation(getSession());
            isProcessing = false; setBtn('send'); abortCtrl = null; focusComposer();
            return;
          }
        } catch {}
        ev = '';
      }
    }
    renderRecent();
  } catch (e) {
    document.getElementById('proc')?.remove();
    saveSessionPatch(currentSessionId, c => ({ ...c, updatedAt: Date.now(), messages: c.messages.filter(m => m.id !== assistantMessage.id) }));
    appendMessage(createErrorMessage(
      e?.name === 'AbortError' ? 'Tempo limite excedido ao aguardar resposta do servidor' : (e?.message || 'Erro de conexao')
    ));
    renderConversation(getSession());
  }
  isProcessing = false; setBtn('send'); abortCtrl = null; focusComposer();
}

// ════════════════════════════════════════════════════════════════════════════
// UI Module
// ════════════════════════════════════════════════════════════════════════════

function tl(n) { return n.startsWith('mcp__') ? 'Usou integracao' : TL[n] || n; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function scr() { document.getElementById('chat').scrollTop = 1e6; }
function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function messageCountLabel(c) { return c === 1 ? '1 mensagem' : `${c} mensagens`; }
function deriveTitle(text) { const clean = String(text || '').trim().replace(/\s+/g, ' '); return (clean || 'Nova conversa').slice(0, 72); }
function relativeTime(ts) { const d = Date.now() - ts; const m = Math.floor(d / 60000); if (m < 1) return 'Agora mesmo'; if (m < 60) return `Ha ${m} min`; const h = Math.floor(m / 60); if (h < 24) return `Ha ${h} h`; return `Ha ${Math.floor(h / 24)} d`; }

function autoResize(el) { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }
function focusComposer() { if (!I) return; try { I.focus({ preventScroll: true }); } catch { I.focus(); } }
function isMobileLayout() { return window.matchMedia('(max-width: 900px)').matches; }

function syncSidebarState() { if (isMobileLayout()) document.body.classList.add('sidebar-collapsed'); else if (!document.body.dataset.sidebarDesktopLocked) document.body.classList.remove('sidebar-collapsed'); }
function openSidebar() { if (isMobileLayout()) { sidebar.classList.add('open'); overlay.classList.add('show'); } else document.body.classList.remove('sidebar-collapsed'); }
function closeSidebar() { if (isMobileLayout()) { sidebar.classList.remove('open'); overlay.classList.remove('show'); } else document.body.classList.add('sidebar-collapsed'); }
function toggleSidebar() { if (isMobileLayout()) { if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar(); } else document.body.classList.toggle('sidebar-collapsed'); }

function clearLegacyClientCache() { ['clow_web_sessions_v1', 'clow_web_active_session_v1', 'clow_recent_prompts'].forEach(k => localStorage.removeItem(k)); }
function clearBrowserCaches() { if (!('caches' in window)) return; caches.keys().then(keys => Promise.all(keys.filter(k => k.toLowerCase().includes('clow') || k.toLowerCase().includes('workbox')).map(k => caches.delete(k)))).catch(() => {}); }

function md(t) {
  const clean = String(t || '').replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)').replace(/https?:\/\/[^\s<"]+/g, u => u.replace(/["'>]+$/, ''));
  return clean
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^- (.+)$/gm, '- $1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(https?:\/\/[^\s<"')]+)/g, (m, u) => m.includes('href=') ? m : `<a href="${u.replace(/["'>]+$/, '')}" target="_blank" rel="noopener noreferrer">${u.replace(/["'>]+$/, '')}</a>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

// ════════════════════════════════════════════════════════════════════════════
// Render Module
// ════════════════════════════════════════════════════════════════════════════

function clearFeed() { F.innerHTML = ''; W.classList.remove('hide'); F.appendChild(W); }

function renderUserMessage(text) {
  const row = document.createElement('div'); row.className = 'u-row';
  const d = document.createElement('div'); d.className = 'u-block';
  d.innerHTML = `<div class="ut">${esc(text)}</div>`;
  row.appendChild(d); F.appendChild(row);
}

function renderAssistantMessage(text) {
  const row = document.createElement('div'); row.className = 'rp-row';
  const d = document.createElement('div'); d.className = 'rp';
  d.innerHTML = `<p>${md(text)}</p>`;
  row.appendChild(d); F.appendChild(row); return d;
}

function renderErrorMessage(text) {
  const row = document.createElement('div'); row.className = 'rp-row';
  const d = document.createElement('div'); d.className = 'rp';
  d.innerHTML = `<p style="color:#f2b5a4">${esc(text || 'Erro desconhecido')}</p>`;
  row.appendChild(d); F.appendChild(row);
}

function renderToolMessage(name, input) {
  const s = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input || '');
  let fl = '';
  if (input && typeof input === 'object') {
    fl = input.file_path?.split(/[/\\]/).pop() || input.path?.split(/[/\\]/).pop() || input.command?.slice(0, 55) || input.pattern || input.query?.slice(0, 35) || '';
  }
  const d = document.createElement('div'); d.className = 'tl-block';
  d.innerHTML = `<div class="tl-h" onclick="this.querySelector('.tl-chv').classList.toggle('op');this.nextElementSibling.classList.toggle('op')"><span class="tl-chv">></span><span class="tl-lbl">${tl(name)}</span>${fl ? `<span class="tl-fl">${esc(fl)}</span>` : ''}</div><div class="tl-bd"><div class="tl-bdi">${esc(s)}</div></div>`;
  F.appendChild(d); return d;
}

function renderConversation(session) {
  clearFeed();
  if (!session || !session.messages.length) { scr(); return; }
  W.classList.add('hide');
  for (const m of session.messages) {
    if (m.role === 'user') renderUserMessage(m.text);
    else if (m.role === 'assistant') renderAssistantMessage(m.text || '');
    else if (m.role === 'tool') renderToolMessage(m.toolName || 'Tool', m.toolInput);
    else if (m.role === 'error') renderErrorMessage(m.text);
  }
  scr();
}

function renderRecent() {
  const sessions = getSessions();
  recentList.innerHTML = '';
  if (!sessions.length) {
    recentList.innerHTML = '<div class="recent-item empty"><div class="recent-main"><div class="recent-name">Nenhuma conversa ainda</div><div class="recent-meta"><span>As conversas da web expiram automaticamente apos 3 dias.</span></div></div></div>';
    return;
  }
  sessions.forEach(session => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `recent-item${session.id === currentSessionId ? ' active' : ''}`;
    btn.innerHTML = `<div class="recent-shell"><div class="recent-main"><div class="recent-name">${esc(session.title || 'Nova conversa')}</div><div class="recent-meta"><span>${relativeTime(session.updatedAt || session.createdAt)}</span><span class="recent-count">${messageCountLabel(session.messages.length)}</span></div></div><span class="recent-delete" role="button" aria-label="Apagar conversa" title="Apagar conversa"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 10v6"/><path d="M14 10v6"/></svg></span></div>`;
    btn.onclick = () => openSession(session.id);
    const del = btn.querySelector('.recent-delete');
    del.onclick = (e) => { e.preventDefault(); e.stopPropagation(); deleteSession(session.id); };
    recentList.appendChild(btn);
  });
}

function addProcessing() {
  const d = document.createElement('div'); d.className = 'proc'; d.id = 'proc';
  d.innerHTML = '<div class="proc-dot"></div><span class="proc-label">Trabalhando...</span>';
  F.appendChild(d); scr();
}

function setBtn(mode) {
  const send = document.getElementById('ico-send'), stop = document.getElementById('ico-stop');
  if (mode === 'stop') { send.style.display = 'none'; stop.style.display = 'block'; B.classList.add('stop'); B.disabled = false; }
  else { send.style.display = 'block'; stop.style.display = 'none'; B.classList.remove('stop'); B.disabled = false; }
}

function handleBtn() { if (isProcessing) { abortCtrl?.abort(); return; } go(); }

// ════════════════════════════════════════════════════════════════════════════
// App Lifecycle
// ════════════════════════════════════════════════════════════════════════════

async function showApp() {
  localStorage.removeItem('clow_sessions');
  localStorage.removeItem('clow_active_session');
  LS.classList.add('hide');
  setTimeout(() => { LS.style.display = 'none'; }, 250);
  AP.style.display = 'block';
  syncSidebarState(); clearLegacyClientCache(); clearBrowserCaches(); cleanupSessions();
  currentSessionId = null; localStorage.removeItem(ACTIVE_SESSION_KEY);
  const emptySession = getLatestEmptySession();
  if (emptySession) { currentSessionId = emptySession.id; localStorage.setItem(ACTIVE_SESSION_KEY, currentSessionId); }
  else { await ensureCurrentSession(true); }
  renderRecent(); renderConversation(getSession());
  setTimeout(() => focusComposer(), 80);
}

function openSession(id) {
  const session = getSession(id);
  if (!session) return;
  currentSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, currentSessionId);
  renderRecent(); renderConversation(session); closeSidebar(); focusComposer();
}

async function reset() {
  clearFeed(); await ensureCurrentSession(true);
  renderRecent(); renderConversation(getSession()); closeSidebar(); focusComposer();
}

// ════════════════════════════════════════════════════════════════════════════
// Event Listeners
// ════════════════════════════════════════════════════════════════════════════

window.addEventListener('error', e => console.error(e.message));
if (authToken) verifySavedLogin();
LP.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
LU.addEventListener('keydown', e => { if (e.key === 'Enter') LP.focus(); });
I?.addEventListener('input', () => autoResize(I));
I?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleBtn(); } });

if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }
window.addEventListener('resize', () => {
  if (isMobileLayout()) document.body.classList.add('sidebar-collapsed');
  else { sidebar.classList.remove('open'); overlay.classList.remove('show'); }
});
