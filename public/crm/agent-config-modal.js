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
    const headers = init.headers || {};
    headers['Content-Type'] = 'application/json';
    // Reusa apiKey do crm.js global se disponivel
    if (window.CRM_API_KEY) headers['X-API-Key'] = window.CRM_API_KEY;
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
      .agent-config-modal input, .agent-config-modal select, .agent-config-modal textarea {
        width:100%; box-sizing:border-box; padding:8px; border:1px solid #374151; border-radius:6px;
        background:#111827; color:#f1f5f9; margin-top:4px; font-family: ui-monospace, monospace; font-size:13px;
      }
      .agent-config-modal textarea { min-height:120px; resize:vertical; font-family: ui-monospace, monospace; font-size:12px; }
      .agent-config-modal .switch-row { display:flex; align-items:center; gap:8px; margin-top:8px; }
      .agent-config-modal .row { display:flex; gap:12px; }
      .agent-config-modal .row > * { flex:1; }
      .agent-config-modal .footer { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
      .agent-config-modal button { padding:8px 16px; border-radius:6px; border:none; cursor:pointer; font-size:14px; }
      .agent-config-modal .btn-save { background:#22c55e; color:white; }
      .agent-config-modal .btn-cancel { background:#374151; color:#e5e7eb; }
      .agent-config-modal .btn-default { background:#3b82f6; color:white; margin-right:auto; }
      .agent-config-modal .err { color:#ef4444; font-size:12px; margin-top:6px; }
      .agent-config-modal .hint { color:#94a3b8; font-size:11px; font-weight:400; margin-left:6px; }
      .col-agent-btn { padding:4px 10px; border-radius:14px; border:1px solid #374151; background:#1f2937;
        color:#cbd5e1; cursor:pointer; font-size:11px; margin-left:6px; }
      .col-agent-btn.active { background:#16a34a; color:white; border-color:#16a34a; }
      .col-agent-btn.paused { background:#f59e0b; color:white; border-color:#f59e0b; }
    `;
    document.head.appendChild(style);
  }

  function buildModalHTML(cfg, defaults) {
    const role = cfg.agent_role_type || '';
    return `
      <div class="agent-config-modal">
        <h2>Configurar agente: <em>${escapeHtml(cfg.column_name || '')}</em></h2>

        <div class="switch-row">
          <input type="checkbox" id="agcfg-enabled" ${cfg.agent_enabled ? 'checked' : ''}/>
          <label for="agcfg-enabled" style="display:inline; margin-top:0;">🟢 Agente ativo</label>
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
    const btn = document.querySelector(`.col-agent-btn[data-col-id="${columnId}"]`);
    if (!btn) return;
    btn.classList.toggle('active', !!enabled);
    btn.textContent = enabled ? '🟢 Agente ativo' : '⚙️ Agente';
  }

  // ─── Auto-inject nos column headers ────────────────────────────────────

  function injectButtons() {
    // Tenta varios seletores comuns do Kanban
    const headers = document.querySelectorAll('[data-column-id], .kanban-column-header, .column-header');
    headers.forEach((h) => {
      const colId = h.getAttribute('data-column-id') || h.dataset.columnId
        || h.closest('[data-column-id]')?.getAttribute('data-column-id');
      if (!colId) return;
      if (h.querySelector('.col-agent-btn')) return; // ja injetado
      const btn = document.createElement('button');
      btn.className = 'col-agent-btn';
      btn.dataset.colId = colId;
      btn.textContent = '⚙️ Agente';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const boardId = h.closest('[data-board-id]')?.getAttribute('data-board-id') || null;
        openConfigModal(colId, boardId);
      });
      h.appendChild(btn);
    });
  }

  // Hook: re-injeta a cada repaint do kanban (best-effort)
  const observer = new MutationObserver(() => injectButtons());
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    injectButtons();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
      injectButtons();
    });
  }

  // Expose pra debug / testes
  window.openAgentConfigModal = openConfigModal;
})();
