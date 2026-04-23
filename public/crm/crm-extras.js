/* ═══════════════════════════════════════════════════════════════════════
 * CRM CLOW — UI extras (waves 6-11)
 *
 * Appends views: Automations, Subscriptions, Agent metrics, Card line items,
 * SSE real-time refresh.
 *
 * This file is loaded AFTER crm.js. Functions/state from crm.js are
 * available via window.* (we re-expose what we need).
 * ═══════════════════════════════════════════════════════════════════════ */

(function() {
  // Wait until main app is bootstrapped
  function ready(fn) {
    if (window.__crmAppReady) return fn();
    window.__crmAppReadyCb = window.__crmAppReadyCb || [];
    window.__crmAppReadyCb.push(fn);
  }

  // Re-expose helpers (lifted from crm.js scope by re-defining locally)
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
  const apiKey = () => localStorage.getItem('clow_crm_key') || '';
  async function api(path, opts = {}) {
    const headers = { 'Authorization': `Bearer ${apiKey()}`, ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(`/v1/crm${path}`, { ...opts, headers });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  }
  function toast(msg, type = '') {
    const t = el('div', { class: `toast ${type}` }, msg);
    $('#toastRoot')?.append(t);
    setTimeout(() => t.remove(), 3000);
  }
  function fmtMoney(c) {
    return `R$ ${((c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  // ─── Inject extra nav items + views into the shell ───────────────────
  function injectExtras() {
    const nav = $('.sidebar nav');
    if (!nav || nav.querySelector('[data-view="automations"]')) return;
    const autoIcon = el('span', { class: 'nav-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' });
    const subsIcon = el('span', { class: 'nav-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="9" y2="15"/></svg>' });
    nav.append(
      el('button', { class: 'nav-item', data: { view: 'automations' } },
        autoIcon, el('span', { class: 'nav-label' }, 'Automações')),
      el('button', { class: 'nav-item', data: { view: 'subscriptions' } },
        subsIcon, el('span', { class: 'nav-label' }, 'Mensalidades')),
    );

    const main = $('.main');
    main.append(
      el('div', { class: 'view', data: { view: 'automations' }, id: 'automationsView' },
        el('header', { class: 'top-bar' },
          el('div', { class: 'top-bar-left' }, el('h2', {}, 'Automações')),
          el('div', {},
            el('button', { class: 'secondary', id: 'browseTemplatesBtn' }, '+ Templates prontos'),
            el('button', { id: 'newAutomationBtn', style: 'margin-left:8px' }, '+ Nova Automação'),
          ),
        ),
        el('div', { class: 'list', id: 'automationsList' }),
      ),
      el('div', { class: 'view', data: { view: 'subscriptions' }, id: 'subsView' },
        el('header', { class: 'top-bar' },
          el('div', { class: 'top-bar-left' },
            el('h2', {}, 'Mensalidades'),
            el('select', { id: 'subStatusFilter' },
              el('option', { value: '' }, 'Todas'),
              el('option', { value: 'active' }, 'Ativas'),
              el('option', { value: 'past_due' }, 'Atrasadas'),
              el('option', { value: 'cancelled' }, 'Canceladas'),
            ),
          ),
          el('div', {}, el('button', { id: 'newSubBtn' }, '+ Nova Assinatura')),
        ),
        el('div', { class: 'list', id: 'subsList' }),
      ),
    );

    // Wire new nav items
    $$('.nav-item').forEach(n => {
      if (!n.dataset._wired) {
        n.dataset._wired = '1';
        n.addEventListener('click', () => showExtraView(n.dataset.view));
      }
    });
    $('#browseTemplatesBtn')?.addEventListener('click', openTemplatesModal);
    $('#newAutomationBtn')?.addEventListener('click', openAutomationModal);
    $('#newSubBtn')?.addEventListener('click', openSubscriptionModal);
    $('#subStatusFilter')?.addEventListener('change', renderSubsList);
  }

  async function showExtraView(view) {
    if (!['automations', 'subscriptions'].includes(view)) return;
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
    if (view === 'automations') await renderAutomationsList();
    else if (view === 'subscriptions') await renderSubsList();
  }

  // ─── Automations list ────────────────────────────────────────────────
  async function renderAutomationsList() {
    const l = $('#automationsList');
    l.innerHTML = '';
    try {
      const r = await api('/automations');
      if (!r.automations.length) {
        l.append(el('div', { class: 'empty' }, 'Nenhuma automação. Clique "+ Templates prontos" pra começar com 1 clique.'));
        return;
      }
      for (const a of r.automations) {
        const autoItem = el('div', { class: 'list-item', style: 'cursor:default;flex-direction:column;align-items:stretch' },
          el('div', { style: 'display:flex;align-items:center;justify-content:space-between' },
            el('div', { class: 'list-item-left' },
              el('div', {},
                el('div', { class: 'list-item-title' }, a.name),
                el('div', { class: 'list-item-sub' },
                  `Trigger: ${a.trigger.type} · ${a.actions.length} ação(ões) · Disparou ${a.runsCount}x`,
                ),
              ),
            ),
            el('div', { style: 'display:flex;gap:6px;align-items:center' },
              el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);cursor:pointer' },
                el('input', { type: 'checkbox', checked: a.enabled ? '' : null, on: { change: async (e) => {
                  await api(`/automations/${a.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
                  toast(e.target.checked ? 'Ativada' : 'Pausada', 'success');
                } } }),
                a.enabled ? 'Ativa' : 'Pausada',
              ),
              el('button', {
                class: 'save-btn',
                style: 'background:transparent;border:1px solid var(--red);color:var(--red);padding:6px 12px;font-size:11px',
                on: { click: async () => {
                  if (!(await clowConfirm(`Apagar "${a.name}"?`, { title: 'Apagar automacao', danger: true, confirmLabel: 'Apagar' }))) return;
                  await api(`/automations/${a.id}`, { method: 'DELETE' });
                  await renderAutomationsList();
                  toast('Removida', 'success');
                } },
              }, 'Apagar'),
            ),
          ),
          el('details', { style: 'margin-top:8px' },
            el('summary', { style: 'cursor:pointer;color:var(--text-dim);font-size:11px' }, 'Ver definição (JSON)'),
            el('pre', { style: 'background:var(--bg-3);padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;margin-top:6px' }, JSON.stringify({
              trigger: a.trigger, conditions: a.conditions, actions: a.actions,
            }, null, 2)),
          ),
        );
        attachListItemContextMenu(autoItem, (x, y) => showAutomationContextMenu(a, x, y, renderAutomationsList));
        l.append(autoItem);
      }
    } catch (e) { toast('Erro: ' + e.message, 'error'); }
  }

  async function openTemplatesModal() {
    try {
      const r = await api('/automations/templates');
      const backdrop = el('div', { class: 'modal-backdrop' });
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow-y:auto' });
      for (const t of r.templates) {
        list.append(el('div', { style: 'background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:12px' },
          el('div', { style: 'font-weight:600;margin-bottom:4px' }, t.name),
          el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:8px' }, t.description),
          el('button', {
            class: 'save-btn',
            style: 'padding:6px 14px;font-size:12px',
            on: { click: async () => {
              try {
                await api('/automations/install-template', { method: 'POST', body: { key: t.key } });
                toast('Template instalado', 'success');
                backdrop.remove();
                await renderAutomationsList();
              } catch (e) { toast('Erro: ' + e.message, 'error'); }
            } },
          }, 'Instalar'),
        ));
      }
      backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Templates de automação'), list,
        el('div', { class: 'modal-actions' },
          el('button', { class: 'cancel', on: { click: () => backdrop.remove() } }, 'Fechar'),
        ),
      ));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
      document.body.append(backdrop);
    } catch (e) { toast('Erro: ' + e.message, 'error'); }
  }

  async function openAutomationModal() {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        const trigger = JSON.parse(fd.get('trigger'));
        const conditions = JSON.parse(fd.get('conditions') || '[]');
        const actions = JSON.parse(fd.get('actions'));
        await api('/automations', { method: 'POST', body: {
          name: fd.get('name'), trigger, conditions, actions, enabled: true,
        } });
        backdrop.remove();
        await renderAutomationsList();
        toast('Automação criada', 'success');
      } catch (err) { toast('JSON inválido ou erro: ' + err.message, 'error'); }
    } } },
      el('div', { class: 'field' }, el('label', {}, 'Nome'),
        el('input', { name: 'name', type: 'text', required: '', placeholder: 'Ex: Saudação do lead novo' })),
      el('div', { class: 'field' }, el('label', {}, 'Trigger (JSON)'),
        el('textarea', { name: 'trigger', rows: '3', required: '' }, '{"type":"inbound_message"}')),
      el('div', { class: 'field' }, el('label', {}, 'Conditions (JSON array)'),
        el('textarea', { name: 'conditions', rows: '4' }, '[]')),
      el('div', { class: 'field' }, el('label', {}, 'Actions (JSON array)'),
        el('textarea', { name: 'actions', rows: '6', required: '' },
          '[{"type":"add_note","params":{"content":"Olá {{firstName}}"}}]')),
      el('div', { style: 'font-size:11px;color:var(--text-dim);margin:8px 0' },
        'Tipos disponíveis: triggers (inbound_message, outbound_message, card_created, card_moved, card_stale, due_approaching) | conditions (text_contains, text_matches, column_is, column_is_not, value_above, value_below, tag_has, days_since_activity) | actions (move_card, add_label, add_note, send_whatsapp, create_reminder, set_probability, set_owner, webhook).',
      ),
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
        el('button', { type: 'submit', class: 'confirm' }, 'Criar'),
      ),
    );
    backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Nova automação'), form));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.append(backdrop);
  }

  // ─── Subscriptions list ──────────────────────────────────────────────
  async function renderSubsList() {
    const l = $('#subsList');
    l.innerHTML = '';
    const status = $('#subStatusFilter')?.value || '';
    try {
      const path = status ? `/subscriptions?status=${status}` : '/subscriptions';
      const r = await api(path);
      if (!r.subscriptions.length) {
        l.append(el('div', { class: 'empty' }, 'Nenhuma assinatura. Clique "+ Nova Assinatura" pra criar.'));
        return;
      }
      for (const s of r.subscriptions) {
        const due = new Date(s.nextChargeAt);
        const overdue = due.getTime() < Date.now() && s.status === 'active';
        const statusClass = s.status === 'active' ? 'green' : s.status === 'past_due' ? 'red' : 'gray';
        const subItem = el('div', { class: 'list-item', style: 'flex-direction:column;align-items:stretch;cursor:pointer', on: { click: (e) => { if (e.target.closest('button')) return; openEditSubscriptionModal(s); } } },
          el('div', { style: 'display:flex;align-items:center;justify-content:space-between' },
            el('div', { class: 'list-item-left' },
              el('div', {},
                el('div', { class: 'list-item-title' }, s.planName),
                el('div', { class: 'list-item-sub' },
                  `${fmtMoney(s.amountCents)} / ${s.cycle} · próxima cobrança ${fmtDate(s.nextChargeAt)}${overdue ? ' ⚠️' : ''} · ${s.remindersSent} lembrete(s) enviado(s)`,
                ),
              ),
            ),
            el('span', { class: `pill ${statusClass}` }, s.status),
          ),
          el('div', { style: 'margin-top:8px;display:flex;gap:6px' },
            s.status === 'active' || s.status === 'past_due' ?
              el('button', { class: 'save-btn', style: 'flex:1;background:var(--green);font-size:12px;padding:6px',
                on: { click: async () => {
                  await api(`/subscriptions/${s.id}/mark-paid`, { method: 'POST' });
                  toast('Marcada como paga', 'success');
                  await renderSubsList();
                } } }, '✓ Marcar como pago') : null,
            s.status !== 'cancelled' ?
              el('button', { class: 'save-btn', style: 'background:transparent;border:1px solid var(--red);color:var(--red);font-size:12px;padding:6px 12px',
                on: { click: async () => {
                  if (!(await clowConfirm(`Cancelar assinatura "${s.planName}"?`, { title: 'Cancelar assinatura', danger: true, confirmLabel: 'Cancelar assinatura' }))) return;
                  await api(`/subscriptions/${s.id}`, { method: 'PATCH', body: { status: 'cancelled', cancelledAt: Date.now() } });
                  toast('Cancelada', 'success');
                  await renderSubsList();
                } } }, 'Cancelar') : null,
          ),
        );
      attachListItemContextMenu(subItem, (x, y) => showSubscriptionContextMenu(s, x, y, renderSubsList));
      l.append(subItem);
      }
    } catch (e) { toast('Erro: ' + e.message, 'error'); }
  }

  async function openSubscriptionModal() {
    const contacts = (await api('/contacts?limit=200')).contacts || [];
    const backdrop = el('div', { class: 'modal-backdrop' });
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/subscriptions', { method: 'POST', body: {
          contactId: fd.get('contactId'),
          planName: fd.get('planName'),
          amountCents: Math.round(parseFloat(fd.get('amount')) * 100),
          cycle: fd.get('cycle'),
          nextChargeAt: new Date(fd.get('nextCharge')).getTime(),
        } });
        backdrop.remove();
        await renderSubsList();
        toast('Assinatura criada', 'success');
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    } } },
      el('div', { class: 'field' }, el('label', {}, 'Contato'),
        (() => {
          const sel = el('select', { name: 'contactId', required: '' });
          for (const c of contacts) sel.append(el('option', { value: c.id }, `${c.name} ${c.phone ? '(' + c.phone + ')' : ''}`));
          return sel;
        })()),
      el('div', { class: 'field' }, el('label', {}, 'Nome do plano'),
        el('input', { name: 'planName', type: 'text', required: '', placeholder: 'Ex: Premium Mensal' })),
      el('div', { style: 'display:flex;gap:10px' },
        el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Valor (R$)'),
          el('input', { name: 'amount', type: 'number', step: '0.01', required: '' })),
        el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Ciclo'),
          (() => {
            const sel = el('select', { name: 'cycle', required: '' });
            for (const c of ['monthly', 'weekly', 'quarterly', 'yearly', 'one_time']) {
              sel.append(el('option', { value: c }, c));
            }
            return sel;
          })()),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Próxima cobrança'),
        el('input', { name: 'nextCharge', type: 'datetime-local', required: '' })),
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
        el('button', { type: 'submit', class: 'confirm' }, 'Criar'),
      ),
    );
    backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Nova assinatura'), form));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.append(backdrop);
  }

  
  async function openEditSubscriptionModal(s) {
    const contacts = (await api('/contacts?limit=200')).contacts || [];
    const backdrop = el('div', { class: 'modal-backdrop' });
    const form = el('form', { on: { submit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/subscriptions/' + s.id, { method: 'PATCH', body: {
          planName: fd.get('planName'),
          amountCents: Math.round(parseFloat(fd.get('amount')) * 100),
          cycle: fd.get('cycle'),
          nextChargeAt: new Date(fd.get('nextCharge')).getTime(),
        } });
        backdrop.remove();
        await renderSubsList();
        toast('Assinatura atualizada', 'success');
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    } } });
    const contact = contacts.find(c => c.id === s.contactId);
    const cycleSel = el('select', { name: 'cycle', required: '' });
    for (const c of ['monthly','weekly','quarterly','yearly','one_time']) {
      const opt = el('option', { value: c }, c);
      if (c === s.cycle) opt.selected = true;
      cycleSel.append(opt);
    }
    const dt = new Date(s.nextChargeAt);
    const pad = (n) => String(n).padStart(2,'0');
    const dtIso = dt.getFullYear() + '-' + pad(dt.getMonth()+1) + '-' + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    const planInput = el('input', { name: 'planName', type: 'text', value: s.planName, required: '', style: 'padding:8px 10px;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:13px' });
    const amountInput = el('input', { name: 'amount', type: 'number', step: '0.01', value: (s.amountCents/100).toFixed(2), required: '', style: 'padding:8px 10px;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:13px' });
    const dateInput = el('input', { name: 'nextCharge', type: 'datetime-local', value: dtIso, required: '', style: 'padding:8px 10px;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:13px' });
    cycleSel.style.cssText = 'padding:8px 10px;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:13px';
    form.append(
      el('div', { style: 'background:var(--bg-3);padding:12px;border-radius:10px;margin-bottom:14px' },
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600' }, 'Cliente'),
        el('div', { style: 'color:var(--text);font-size:13px' }, contact ? contact.name + ' (' + (contact.phone || '—') + ')' : s.contactId),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Nome do plano'), planInput),
      el('div', { style: 'display:flex;gap:10px' },
        el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Valor (R$)'), amountInput),
        el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Ciclo'), cycleSel),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Próxima cobrança'), dateInput),
      el('div', { style: 'background:var(--bg-3);padding:10px;border-radius:8px;margin-bottom:14px;font-size:11px;color:var(--text-dim)' },
        'Status atual: ' + s.status + ' · Lembretes enviados: ' + s.remindersSent,
      ),
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'cancel', on: { click: () => backdrop.remove() } }, 'Cancelar'),
        el('button', { type: 'submit', class: 'confirm' }, 'Salvar'),
      ),
    );
    backdrop.append(el('div', { class: 'modal' }, el('h3', {}, 'Editar assinatura'), form));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.append(backdrop);
  }


  // ─── SSE real-time refresh ───────────────────────────────────────────
  let _es = null;
  function startSSE() {
    if (_es) try { _es.close(); } catch {}
    const url = `/v1/crm/events?token=${encodeURIComponent(apiKey())}`;
    _es = new EventSource(url);
    _es.addEventListener('open', () => console.log('[CRM SSE] connected'));
    _es.addEventListener('error', () => console.warn('[CRM SSE] error'));
    _es.addEventListener('activity', async () => {
      // Refresh kanban + open card if any
      if (window.__crmRefresh) await window.__crmRefresh();
    });
    _es.addEventListener('card', async (ev) => {
      if (window.__crmRefresh) await window.__crmRefresh();
    });
  }

  // ─── Boot hook: detect login + inject ───────────────────────────────
  function tryBoot() {
    if (!apiKey() || $('#app')?.classList.contains('hide')) {
      setTimeout(tryBoot, 500);
      return;
    }
    injectExtras();
    startSSE();
  }
  document.addEventListener('DOMContentLoaded', tryBoot);
  // also try after a short delay (in case login already happened)
  setTimeout(tryBoot, 1500);
})();


// ═══ AUTOMATION context menu ═════════════════════════════════════════════
async function showAutomationContextMenu(auto, x, y, refreshFn) {
  closeCtxMenus();
  const items = [
    { icon: CTX_ICO.json, label: 'Ver/editar JSON', onClick: async () => {
      const json = JSON.stringify({ trigger: auto.trigger, conditions: auto.conditions, actions: auto.actions }, null, 2);
      const v = await clowPrompt('JSON da automacao:', json, { title: 'Editar automacao (JSON)', multiline: true, hint: 'Altere trigger, conditions ou actions. Invalid JSON cancela.' });
      if (v == null) return;
      try {
        const parsed = JSON.parse(v);
        await api('/automations/' + auto.id, { method: 'PATCH', body: parsed });
        toast('Salvo', 'success');
        await refreshFn?.();
      } catch (e) { toast('JSON invalido: ' + e.message, 'error'); }
    }},
    { icon: auto.enabled ? CTX_ICO.pause : CTX_ICO.play,
      label: auto.enabled ? 'Pausar' : 'Ativar',
      onClick: async () => {
        try {
          await api('/automations/' + auto.id, { method: 'PATCH', body: { enabled: !auto.enabled } });
          toast(auto.enabled ? 'Pausada' : 'Ativada', 'success');
          await refreshFn?.();
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
      }},
    'sep',
    { icon: CTX_ICO.trash, label: 'Apagar automacao', danger: true, onClick: async () => {
      if (!(await clowConfirm('Apagar "' + auto.name + '"?', { title: 'Apagar automacao', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/automations/' + auto.id, { method: 'DELETE' });
        toast('Removida', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = buildMenu(items, truncate(auto.name || 'Automacao', 30));
  positionMenu(menu, x, y);
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
}

// ═══ SUBSCRIPTION context menu ══════════════════════════════════════════
async function showSubscriptionContextMenu(sub, x, y, refreshFn) {
  closeCtxMenus();
  const items = [
    { icon: CTX_ICO.edit, label: 'Editar valor', onClick: async () => {
      const v = await clowPrompt('Valor em R$:', ((sub.amountCents || 0) / 100).toFixed(2), { title: 'Editar valor' });
      if (v == null) return;
      const amountCents = Math.round(parseFloat(String(v).replace(',', '.')) * 100);
      if (!Number.isFinite(amountCents) || amountCents < 0) return toast('Valor invalido', 'error');
      try {
        await api('/subscriptions/' + sub.id, { method: 'PATCH', body: { amountCents } });
        toast('Atualizado', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    { icon: CTX_ICO.money, label: 'Marcar como paga', onClick: async () => {
      if (!(await clowConfirm('Marcar parcela atual como paga?', { title: 'Confirmar pagamento', confirmLabel: 'Sim' }))) return;
      try {
        await api('/subscriptions/' + sub.id + '/mark-paid', { method: 'POST' });
        toast('Marcada como paga', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    'sep',
    { icon: CTX_ICO.trash, label: 'Cancelar assinatura', danger: true, onClick: async () => {
      if (!(await clowConfirm('Cancelar "' + sub.planName + '"? Cliente tem acesso ate o fim do periodo pago.', { title: 'Cancelar', danger: true, confirmLabel: 'Cancelar' }))) return;
      try {
        await api('/subscriptions/' + sub.id, { method: 'PATCH', body: { status: 'cancelled' } });
        toast('Cancelada', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = buildMenu(items, truncate(sub.planName || 'Assinatura', 30));
  positionMenu(menu, x, y);
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
}

