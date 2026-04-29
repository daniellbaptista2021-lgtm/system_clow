/**
 * Agent Config Modal — PR 7.1
 *
 * UI minimal pra configurar agente de coluna direto no Kanban.
 * Anexa botoes nos column headers e abre modal com 10 campos.
 *
 * Uso: incluir <script src="agent-config-modal.js"></script> em crm.html
 * apos crm.js. Auto-injeta nos column headers.
 *
 * Roteamento backend (PR 7.1):
 *   GET  /v1/crm/columns/:id/agent-config
 *   PUT  /v1/crm/columns/:id/agent-config
 *   GET  /v1/crm/agents/default-prompts
 *   GET  /v1/crm/boards/:id/columns
 */
(function () {
  'use strict';

  const ROLES = ['qualificador', 'cotador', 'vendedor', 'coletor', 'followupper', 'custom'];
  let DEFAULT_PROMPTS = null; // cache
  let CURRENT_BOARD_ID = null;

  // ─── HTTP helpers ──────────────────────────────────────────────────────

  async function api(path, init = {}) {
    // Mesma autenticação do resto do app (crm.js usa Authorization: Bearer).
    // Backend (tenantAuth.ts) só aceita esse header — X-API-Key é ignorado.
    const apiKey = (window.state && window.state.apiKey)
      || localStorage.getItem('clow_crm_key')
      || localStorage.getItem('clow_token');

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    Object.assign(headers, init.headers || {});

    const res = await fetch('/v1/crm' + path, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadDefaultPrompts() {
    if (DEFAULT_PROMPTS) return DEFAULT_PROMPTS;
    const r = await api('/agents/default-prompts');
    DEFAULT_PROMPTS = r.roles;
    return DEFAULT_PROMPTS;
  }

  // ─── Modal HTML/CSS ────────────────────────────────────────────────────

  function ensureStyles() {
    if (document.getElementById('agent-config-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'agent-config-modal-styles';
    style.textContent = `
      .agent-config-modal-bg { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; }
      .agent-config-modal { background:#1f2937; color:#e5e7eb; padding:24px; border-radius:12px; max-width:680px; width:92vw; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.5); font-family: ui-sans-serif, system-ui, sans-serif; }
      .agent-config-modal h2 { margin:0 0 16px 0; font-size:18px; }
      .agent-config-modal label { display:block; margin-top:12px; font-size:13px; font-weight:600; color:#cbd5e1; }
      .agent-config-modal input[type="text"], .agent-config-modal input[type="number"], .agent-config-modal select, .agent-config-modal textarea {
        width:100%; box-sizing:border-box; padding:8px; border:1px solid #374151; border-radius:6px;
        background:#111827; color:#f1f5f9; margin-top:4px; font-family: ui-monospace, monospace; font-size:13px;
      }
      .agent-config-modal textarea { min-height:120px; resize:vertical; font-family: ui-monospace, monospace; font-size:12px; }
      .agent-config-modal .row { display:flex; gap:12px; }
      .agent-config-modal .row > * { flex:1; }
      .agent-config-modal .footer { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
      .agent-config-modal button { padding:8px 16px; border-radius:6px; border:none; cursor:pointer; font-size:14px; }
      .agent-config-modal .btn-save { background:#22c55e; color:white; }
      .agent-config-modal .btn-cancel { background:#374151; color:#e5e7eb; }
      .agent-config-modal .btn-default { background:#3b82f6; color:white; margin-right:auto; }
      .agent-config-modal .err { color:#ef4444; font-size:12px; margin-top:6px; }
      .agent-config-modal .hint { color:#94a3b8; font-size:11px; font-weight:400; margin-left:6px; }

      /* Toggle switch (visual, sem mudar o checkbox) */
      .agent-config-modal .switch-row { display:flex; align-items:center; gap:10px; margin-top:8px; }
      .agent-config-modal .switch-row label { margin-top:0; }
      .agent-config-modal .toggle { position:relative; display:inline-block; width:44px; height:24px; vertical-align:middle; flex-shrink:0; }
      .agent-config-modal .toggle input { opacity:0; width:0; height:0; }
      .agent-config-modal .toggle .slider { position:absolute; cursor:pointer; inset:0; background:#374151; border-radius:24px; transition:.2s; }
      .agent-config-modal .toggle .slider::before { content:""; position:absolute; height:18px; width:18px; left:3px; top:3px; background:white; border-radius:50%; transition:.2s; }
      .agent-config-modal .toggle input:checked + .slider { background:#22c55e; }
      .agent-config-modal .toggle input:checked + .slider::before { transform:translateX(20px); }

      /* Botão integrado ao tema do System Clow — vai dentro de .col-head */
      .col-agent-btn {
        display: inline-flex; align-items: center; gap: 4px;
        background: var(--bg-3); border: 1px solid var(--border);
        color: var(--text-dim); cursor: pointer;
        padding: 4px 10px; border-radius: 6px;
        font-size: 11px; font-weight: 500; line-height: 1;
        transition: all 0.15s ease;
      }
      .col-agent-btn:hover {
        background: var(--bg-4); color: var(--text-2); border-color: var(--border-2);
      }
      .col-agent-btn.active {
        color: var(--purple); border-color: var(--border-2);
        background: rgba(155, 89, 252, 0.08);
      }
      .col-agent-btn.active:hover { background: rgba(155, 89, 252, 0.15); }
      .col-agent-btn.paused { color: #f59e0b; }

      /* Layout consistente da .col-head com 4 elementos: title | count | agent-btn | menu-btn */
      .col-head { gap: 8px; }
      .col-head .col-title { margin-right: auto; }
      .col-head .col-count,
      .col-head .col-agent-btn,
      .col-head .col-menu-btn { flex-shrink: 0; }
    `;
    document.head.appendChild(style);
  }

  function buildModalHTML(cfg, defaults) {
    const role = cfg.agent_role_type || '';
    return `
      <div class="agent-config-modal">
        <h2>Configurar agente: <em>${escapeHtml(cfg.column_name || '')}</em></h2>

        <div class="switch-row">
          <label class="toggle"><input type="checkbox" id="agcfg-enabled" ${cfg.agent_enabled ? 'checked' : ''}/><span class="slider"></span></label>
          <label for="agcfg-enabled">Agente ativo</label>
        </div>

        <label>Role do agente <span class="hint">— qual papel no funil</span></label>
        <select id="agcfg-role">
          <option value="">— nenhum —</option>
          ${ROLES.map((r) => `<option value="${r}" ${role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>

        <button class="btn-default" id="agcfg-restore">↻ Restaurar prompt padrão do role</button>

        <label>System prompt <span class="hint">— instrucoes pro LLM</span></label>
        <textarea id="agcfg-prompt" rows="14">${escapeHtml(cfg.agent_system_prompt || '')}</textarea>

        <label>Critério de promoção <span class="hint">— checklist exibido pro agente</span></label>
        <textarea id="agcfg-criteria" rows="4">${escapeHtml(cfg.agent_promotion_criteria || '')}</textarea>

        <label>Promove pra coluna <span class="hint">— destino quando criterio bate</span></label>
        <select id="agcfg-promote-to">
          <option value="">— nenhuma —</option>
        </select>

        <div class="row">
          <div>
            <label>Entry delay (min)</label>
            <input type="number" id="agcfg-entry-delay" value="${cfg.agent_entry_delay_minutes ?? 0}" min="0"/>
          </div>
          <div>
            <label>Max turns</label>
            <input type="number" id="agcfg-max-turns" value="${cfg.agent_max_turns ?? 30}" min="1"/>
          </div>
          <div>
            <label>Inactivity (min)</label>
            <input type="number" id="agcfg-inactivity" value="${cfg.agent_inactivity_timeout_minutes ?? 20}" min="1"/>
          </div>
        </div>

        <div class="row">
          <div>
            <label>Chase steps <span class="hint">[30,120,360]</span></label>
            <input type="text" id="agcfg-chase" value="${escapeHtml(cfg.agent_no_response_chase_steps_json || '')}" placeholder="[30, 120, 360]"/>
          </div>
          <div>
            <label>Followup steps (h) <span class="hint">[24,48,72]</span></label>
            <input type="text" id="agcfg-fu" value="${escapeHtml(cfg.agent_followup_steps_hours_json || '')}" placeholder="[24, 48, 72]"/>
          </div>
        </div>

        <div class="row">
          <div>
            <label>Hora ativa início</label>
            <input type="text" id="agcfg-h-start" value="${escapeHtml(cfg.agent_active_hours_start || '00:00')}" placeholder="HH:MM"/>
          </div>
          <div>
            <label>Hora ativa fim</label>
            <input type="text" id="agcfg-h-end" value="${escapeHtml(cfg.agent_active_hours_end || '23:59')}" placeholder="HH:MM"/>
          </div>
        </div>

        <div class="err" id="agcfg-err"></div>

        <div class="footer">
          <button class="btn-cancel" id="agcfg-cancel">Cancelar</button>
          <button class="btn-save" id="agcfg-save">Salvar</button>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ─── Validacao client-side ─────────────────────────────────────────────

  function validateForm(form) {
    const errs = [];
    const enabled = form.querySelector('#agcfg-enabled').checked;
    const prompt = form.querySelector('#agcfg-prompt').value.trim();
    if (enabled && !prompt) {
      errs.push('Prompt obrigatório quando agente está ligado');
    }
    const validateJsonSteps = (val, label) => {
      if (!val.trim()) return;
      try {
        const arr = JSON.parse(val);
        if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n > 0)) {
          errs.push(`${label}: deve ser array de inteiros positivos`);
        }
      } catch {
        errs.push(`${label}: JSON inválido (use [30, 120, 360])`);
      }
    };
    validateJsonSteps(form.querySelector('#agcfg-chase').value, 'Chase steps');
    validateJsonSteps(form.querySelector('#agcfg-fu').value, 'Followup steps');
    const hStart = form.querySelector('#agcfg-h-start').value;
    const hEnd = form.querySelector('#agcfg-h-end').value;
    if (!/^\d{2}:\d{2}$/.test(hStart)) errs.push('Hora ativa início: formato HH:MM');
    if (!/^\d{2}:\d{2}$/.test(hEnd)) errs.push('Hora ativa fim: formato HH:MM');
    return errs;
  }

  // ─── Open modal ────────────────────────────────────────────────────────

  async function openConfigModal(columnId, boardId) {
    ensureStyles();
    const [cfg, defaults, columnsResp] = await Promise.all([
      api(`/columns/${columnId}/agent-config`),
      loadDefaultPrompts(),
      boardId ? api(`/boards/${boardId}/columns`).catch(() => ({ columns: [] })) : Promise.resolve({ columns: [] }),
    ]);
    CURRENT_BOARD_ID = boardId || cfg.board_id;

    const bg = document.createElement('div');
    bg.className = 'agent-config-modal-bg';
    bg.innerHTML = buildModalHTML(cfg, defaults);
    document.body.appendChild(bg);

    // Popula select de promote-to
    const promoteSel = bg.querySelector('#agcfg-promote-to');
    const cols = (columnsResp.columns || []).filter((c) => c.id !== columnId);
    for (const col of cols) {
      const opt = document.createElement('option');
      opt.value = col.id;
      opt.textContent = col.name;
      if (col.id === cfg.agent_promote_to_column_id) opt.selected = true;
      promoteSel.appendChild(opt);
    }

    // Restore-default handler
    bg.querySelector('#agcfg-restore').addEventListener('click', (e) => {
      e.preventDefault();
      const role = bg.querySelector('#agcfg-role').value;
      if (!role || !defaults[role]) return;
      bg.querySelector('#agcfg-prompt').value = defaults[role].prompt;
      bg.querySelector('#agcfg-criteria').value = defaults[role].criteria;
      bg.querySelector('#agcfg-entry-delay').value = defaults[role].entry_delay_minutes;
      bg.querySelector('#agcfg-chase').value = defaults[role].chase_steps_json || '';
      bg.querySelector('#agcfg-fu').value = defaults[role].followup_steps_hours_json || '';
    });

    // Trocar role pre-preenche os textareas
    bg.querySelector('#agcfg-role').addEventListener('change', (e) => {
      const role = e.target.value;
      if (role && defaults[role]) {
        const promptArea = bg.querySelector('#agcfg-prompt');
        const criteriaArea = bg.querySelector('#agcfg-criteria');
        if (!promptArea.value.trim() || confirm('Substituir prompt atual pelo padrão do role ' + role + '?')) {
          promptArea.value = defaults[role].prompt;
          criteriaArea.value = defaults[role].criteria;
          bg.querySelector('#agcfg-entry-delay').value = defaults[role].entry_delay_minutes;
          bg.querySelector('#agcfg-chase').value = defaults[role].chase_steps_json || '';
          bg.querySelector('#agcfg-fu').value = defaults[role].followup_steps_hours_json || '';
        }
      }
    });

    bg.querySelector('#agcfg-cancel').addEventListener('click', () => bg.remove());
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });

    bg.querySelector('#agcfg-save').addEventListener('click', async () => {
      const errEl = bg.querySelector('#agcfg-err');
      const errs = validateForm(bg);
      if (errs.length) {
        errEl.innerHTML = errs.map(escapeHtml).join('<br>');
        return;
      }
      errEl.textContent = '';

      const payload = {
        agent_enabled: bg.querySelector('#agcfg-enabled').checked,
        agent_role_type: bg.querySelector('#agcfg-role').value || null,
        agent_system_prompt: bg.querySelector('#agcfg-prompt').value,
        agent_promotion_criteria: bg.querySelector('#agcfg-criteria').value,
        agent_promote_to_column_id: bg.querySelector('#agcfg-promote-to').value || null,
        agent_entry_delay_minutes: parseInt(bg.querySelector('#agcfg-entry-delay').value, 10) || 0,
        agent_no_response_chase_steps_json: bg.querySelector('#agcfg-chase').value.trim() || null,
        agent_followup_steps_hours_json: bg.querySelector('#agcfg-fu').value.trim() || null,
        agent_active_hours_start: bg.querySelector('#agcfg-h-start').value,
        agent_active_hours_end: bg.querySelector('#agcfg-h-end').value,
        agent_max_turns: parseInt(bg.querySelector('#agcfg-max-turns').value, 10) || 30,
        agent_inactivity_timeout_minutes: parseInt(bg.querySelector('#agcfg-inactivity').value, 10) || 20,
      };

      try {
        await api(`/columns/${columnId}/agent-config`, {
          method: 'PUT', body: JSON.stringify(payload),
        });
        bg.remove();
        if (window.toast) window.toast('Agente configurado ✓', 'success');
        else alert('Agente configurado!');
        // Atualiza badge na coluna
        refreshColumnBadge(columnId, payload.agent_enabled);
      } catch (err) {
        errEl.textContent = 'Erro ao salvar: ' + err.message;
      }
    });
  }

  function refreshColumnBadge(columnId, enabled) {
    if (_agentBadgeCache.map) _agentBadgeCache.map[columnId] = !!enabled;
    document.querySelectorAll(`.col-agent-btn[data-col-id="${columnId}"]`).forEach((btn) => {
      btn.classList.toggle('active', !!enabled);
      btn.title = enabled ? 'Agente ativo — clique pra configurar' : 'Configurar agente';
      btn.textContent = enabled ? '🟢 Agente' : '⚙️ Agente';
    });
  }

  // ─── Auto-inject nos column headers ────────────────────────────────────
  //
  // Estrutura real do Kanban (crm.js linhas 260-275):
  //   .kanban-col[data-column-id="X"]
  //     .col-head            ← AQUI vai o botão (header da coluna)
  //       .col-title
  //       .col-count
  //       .col-menu-btn (⋯)
  //     .col-body[data-column-id="X"]    ← cards aqui (NÃO injetar)
  //       .card[data-column-id="X"] ...  ← cards têm data-column-id também!
  //     .col-foot                        ← rodapé "+ Adicionar card" (NÃO injetar)
  //
  // Bug anterior: usava `[data-column-id]` que pegava .kanban-col, .col-body
  // e CADA card. Resultado: botão duplicado em N lugares.

  function getCurrentBoardId() {
    return document.getElementById('boardSelector')?.value || null;
  }

  const _agentBadgeCache = { boardId: null, map: {}, ts: 0 };

  function applyBadgeMap(map) {
    document.querySelectorAll('.col-agent-btn').forEach((btn) => {
      const enabled = !!map[btn.dataset.colId];
      btn.classList.toggle('active', enabled);
      btn.title = enabled ? 'Agente ativo — clique pra configurar' : 'Configurar agente';
      btn.textContent = enabled ? '🟢 Agente' : '⚙️ Agente';
    });
  }

  async function refreshBadges(force) {
    const boardId = getCurrentBoardId();
    if (!boardId) return;
    const now = Date.now();
    if (!force && _agentBadgeCache.boardId === boardId && (now - _agentBadgeCache.ts) < 5000) {
      applyBadgeMap(_agentBadgeCache.map);
      return;
    }
    try {
      const r = await api(`/boards/${boardId}/columns`);
      const map = {};
      for (const col of (r.columns || [])) map[col.id] = !!col.agentEnabled;
      _agentBadgeCache.boardId = boardId;
      _agentBadgeCache.map = map;
      _agentBadgeCache.ts = now;
      applyBadgeMap(map);
    } catch { /* silencioso */ }
  }

  function injectButtons() {
    // Seletor PRECISO: somente .col-head (header) DIRETO descendente de .kanban-col.
    // Garante que NUNCA injeta em .col-foot, .col-body ou em cards.
    const boardId = getCurrentBoardId();
    document.querySelectorAll('.kanban-col > .col-head').forEach((head) => {
      const col = head.parentElement;
      const colId = col?.getAttribute('data-column-id') || col?.dataset?.columnId;
      if (!colId) return;
      if (head.querySelector('.col-agent-btn')) return; // idempotente
      const enabled = !!_agentBadgeCache.map[colId];
      const btn = document.createElement('button');
      btn.className = 'col-agent-btn' + (enabled ? ' active' : '');
      btn.dataset.colId = colId;
      if (boardId) btn.dataset.boardId = boardId;
      btn.title = enabled ? 'Agente ativo — clique pra configurar' : 'Configurar agente';
      btn.textContent = enabled ? '🟢 Agente' : '⚙️ Agente';
      // Inserir ANTES do menu (⋯) — fica [...title...] [count] [⚙️ Agente] [⋯]
      const menu = head.querySelector('.col-menu-btn');
      if (menu) head.insertBefore(btn, menu);
      else head.appendChild(btn);
    });
  }

  // Click delegation no document — sobrevive a re-renders do Kanban
  // e funciona pra botões injetados após o load.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.col-agent-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const colId = btn.dataset.colId;
      const boardId = btn.dataset.boardId
        || document.querySelector('[data-current-board-id]')?.dataset.currentBoardId
        || getCurrentBoardId();
      await openConfigModal(colId, boardId);
    } catch (err) {
      console.error('[agent-config] erro abrindo modal:', err);
      if (window.toast) window.toast('Erro ao abrir configuração: ' + err.message, 'error');
      else alert('Erro: ' + err.message);
    }
  });

  // MutationObserver com debounce (evita loop infinito + thrashing)
  let _debounceTick = null;
  const observer = new MutationObserver(() => {
    if (_debounceTick) return;
    _debounceTick = requestAnimationFrame(() => {
      _debounceTick = null;
      injectButtons();
      refreshBadges();
    });
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    injectButtons();
    refreshBadges();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  // Expose pra debug / testes
  window.openAgentConfigModal = openConfigModal;
  window.__agentConfigDebug = { injectButtons, refreshBadges, _agentBadgeCache };
})();
