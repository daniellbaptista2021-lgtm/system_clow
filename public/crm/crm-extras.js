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
        window.attachListItemContextMenu(autoItem, (x, y) => showAutomationContextMenu(a, x, y, renderAutomationsList));
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
        const dueMs = due.getTime() - Date.now();
        const dueDays = Math.ceil(dueMs / 86400000);
        const overdue = dueMs < 0 && s.status === 'active';
        const overdueDays = overdue ? Math.abs(dueDays) : 0;
        // Lógica baseada em lastPaidAt (vindo do backend, set por
        // markPaid). Calcula início do ciclo atual = nextChargeAt - 1
        // ciclo. Se lastPaidAt > inicio_ciclo, foi pago nesse ciclo.
        const cycleMs = ({ weekly: 7*86400000, monthly: 30*86400000, quarterly: 90*86400000, yearly: 365*86400000, one_time: Infinity })[s.cycle] || 30*86400000;
        const currentCycleStart = s.nextChargeAt - cycleMs;
        const paidThisCycle = s.lastPaidAt && s.lastPaidAt >= currentCycleStart;
        // Botao "Marcar como pago" so aparece se: ativo/vencida E ainda
        // nao foi pago nesse ciclo. Cancelada nao mostra.
        const needsAction = (s.status === 'active' || s.status === 'past_due') && !paidThisCycle;
        // Formata "vence" humano
        const dueText = overdue
          ? `atrasada ${overdueDays}d`
          : dueDays === 0 ? 'vence hoje'
          : dueDays === 1 ? 'vence amanhã'
          : dueDays <= 7 ? `vence em ${dueDays}d`
          : `próxima cobrança ${fmtDate(s.nextChargeAt)}`;
        // Cores do status:
        //  - Cancelada → cinza
        //  - paidThisCycle → verde "Paga"
        //  - overdue/past_due → vermelha "Atrasada"
        //  - resto (active aguardando 1º pagamento ou ciclo novo) → âmbar "Aguardando pagamento"
        const statusColors = s.status === 'cancelled'
          ? { bg: 'rgba(148,163,184,.12)', border: 'rgba(148,163,184,.30)', fg: '#94A3B8', label: 'Cancelada' }
          : paidThisCycle
          ? { bg: 'rgba(34,197,94,.12)', border: 'rgba(34,197,94,.35)', fg: '#22C55E', label: 'Paga' }
          : (s.status === 'past_due' || overdue)
          ? { bg: 'rgba(239,68,68,.12)', border: 'rgba(239,68,68,.35)', fg: '#F87171', label: overdue ? 'Atrasada' : 'Vencida' }
          : { bg: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.35)', fg: '#F59E0B', label: 'Aguardando pagamento' };
        const cycleLabel = ({ monthly: '/mês', weekly: '/semana', quarterly: '/trimestre', yearly: '/ano', one_time: ' (única)' })[s.cycle] || ` /${s.cycle}`;

        const subItem = el('div', {
          class: 'list-item',
          style: 'flex-direction:column;align-items:stretch;cursor:pointer;padding:18px 20px;gap:12px;transition:border-color .15s ease',
          on: { click: (e) => { if (e.target.closest('button')) return; openEditSubscriptionModal(s); } },
        },
          // Header: title + status pill
          el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px' },
            el('div', { style: 'min-width:0;flex:1' },
              el('div', { style: 'font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.planName),
              // Info row: valor + vence + lembretes
              el('div', { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-dim)' },
                el('span', { style: 'color:var(--text);font-weight:600;font-size:14px' }, fmtMoney(s.amountCents)),
                el('span', { style: 'color:var(--text-dim);font-size:12px;margin-left:-10px' }, cycleLabel),
                el('span', { style: 'opacity:.4' }, '·'),
                el('span', { style: `color:${overdue ? '#F87171' : 'var(--text-dim)'};${overdue ? 'font-weight:600' : ''}` }, dueText),
                s.remindersSent > 0
                  ? el('span', { style: 'opacity:.4' }, '·')
                  : null,
                s.remindersSent > 0
                  ? el('span', { style: 'color:var(--text-dim)' }, `${s.remindersSent} lembrete${s.remindersSent === 1 ? '' : 's'}`)
                  : null,
              ),
            ),
            // Status pill compacto
            el('span', {
              style: `display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;background:${statusColors.bg};border:1px solid ${statusColors.border};color:${statusColors.fg};white-space:nowrap;flex-shrink:0`,
            },
              el('span', { style: `width:6px;height:6px;border-radius:50%;background:${statusColors.fg};display:inline-block` }),
              statusColors.label,
            ),
          ),
          // Actions row (botoes ghost discretos, alinhados a direita)
          (needsAction || s.status !== 'cancelled')
            ? el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;align-items:center;border-top:1px solid rgba(255,255,255,.05);padding-top:12px;margin-top:2px' },
              needsAction
                ? el('button', {
                    style: 'display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.35);color:#22C55E;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;transition:all .15s ease',
                    on: {
                      mouseenter: (e) => { e.target.style.background = 'rgba(34,197,94,.18)'; e.target.style.borderColor = 'rgba(34,197,94,.55)'; },
                      mouseleave: (e) => { e.target.style.background = 'rgba(34,197,94,.10)'; e.target.style.borderColor = 'rgba(34,197,94,.35)'; },
                      click: async () => {
                        const updated = await api(`/subscriptions/${s.id}/mark-paid`, { method: 'POST' });
                        const nx = updated?.subscription?.nextChargeAt
                          ? fmtDate(updated.subscription.nextChargeAt)
                          : null;
                        toast(nx ? `✓ Paga · próxima ${nx}` : '✓ Marcada como paga', 'success');
                        await renderSubsList();
                      },
                    },
                  },
                    el('svg', { viewBox: '0 0 24 24', style: 'width:14px;height:14px;flex-shrink:0', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
                      el('polyline', { points: '20 6 9 17 4 12' }),
                    ),
                    'Marcar como pago',
                  )
                : null,
              s.status !== 'cancelled'
                ? el('button', {
                    style: 'display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:transparent;border:1px solid var(--border);color:var(--text-dim);border-radius:8px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:500;transition:all .15s ease',
                    on: {
                      mouseenter: (e) => { e.currentTarget.style.background = 'rgba(239,68,68,.10)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,.40)'; e.currentTarget.style.color = '#F87171'; },
                      mouseleave: (e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-dim)'; },
                      click: async () => {
                        if (!(await clowConfirm(`Cancelar assinatura "${s.planName}"?`, { title: 'Cancelar assinatura', danger: true, confirmLabel: 'Cancelar assinatura' }))) return;
                        await api(`/subscriptions/${s.id}`, { method: 'PATCH', body: { status: 'cancelled', cancelledAt: Date.now() } });
                        toast('Cancelada', 'success');
                        await renderSubsList();
                      },
                    },
                  },
                    el('svg', { viewBox: '0 0 24 24', style: 'width:14px;height:14px;flex-shrink:0', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
                      el('path', { d: 'M18 6L6 18' }),
                      el('path', { d: 'M6 6l12 12' }),
                    ),
                    'Cancelar',
                  )
                : null,
            )
            : null,
        );
        window.attachListItemContextMenu(subItem, (x, y) => showSubscriptionContextMenu(s, x, y, renderSubsList));
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
  window.closeCtxMenus();
  const items = [
    { icon: window.CTX_ICO.json, label: 'Ver/editar JSON', onClick: async () => {
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
    { icon: auto.enabled ? window.CTX_ICO.pause : window.CTX_ICO.play,
      label: auto.enabled ? 'Pausar' : 'Ativar',
      onClick: async () => {
        try {
          await api('/automations/' + auto.id, { method: 'PATCH', body: { enabled: !auto.enabled } });
          toast(auto.enabled ? 'Pausada' : 'Ativada', 'success');
          await refreshFn?.();
        } catch (e) { toast('Erro: ' + e.message, 'error'); }
      }},
    'sep',
    { icon: window.CTX_ICO.trash, label: 'Apagar automacao', danger: true, onClick: async () => {
      if (!(await clowConfirm('Apagar "' + auto.name + '"?', { title: 'Apagar automacao', danger: true, confirmLabel: 'Apagar' }))) return;
      try {
        await api('/automations/' + auto.id, { method: 'DELETE' });
        toast('Removida', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = window.buildMenu(items, window.truncate(auto.name || 'Automacao', 30));
  window.showMenu(menu, x, y);
}

// ═══ SUBSCRIPTION context menu ══════════════════════════════════════════
async function showSubscriptionContextMenu(sub, x, y, refreshFn) {
  window.closeCtxMenus();
  const items = [
    { icon: window.CTX_ICO.edit, label: 'Editar valor', onClick: async () => {
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
    { icon: window.CTX_ICO.money, label: 'Marcar como paga', onClick: async () => {
      if (!(await clowConfirm('Marcar parcela atual como paga?', { title: 'Confirmar pagamento', confirmLabel: 'Sim' }))) return;
      try {
        await api('/subscriptions/' + sub.id + '/mark-paid', { method: 'POST' });
        toast('Marcada como paga', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
    'sep',
    { icon: window.CTX_ICO.trash, label: 'Cancelar assinatura', danger: true, onClick: async () => {
      if (!(await clowConfirm('Cancelar "' + sub.planName + '"? Cliente tem acesso ate o fim do periodo pago.', { title: 'Cancelar', danger: true, confirmLabel: 'Cancelar' }))) return;
      try {
        await api('/subscriptions/' + sub.id, { method: 'PATCH', body: { status: 'cancelled' } });
        toast('Cancelada', 'success');
        await refreshFn?.();
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    }},
  ];
  const menu = window.buildMenu(items, window.truncate(sub.planName || 'Assinatura', 30));
  window.showMenu(menu, x, y);
}

