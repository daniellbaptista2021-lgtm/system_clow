/* ═══════════════════════════════════════════════════════════════════════
 * CRM CLOW — settings + n8n + branding views
 * Runs after crm.js + crm-extras.js
 * ═══════════════════════════════════════════════════════════════════════ */

(function() {
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
  const toast = (msg, type = '') => {
    const t = el('div', { class: `toast ${type}` }, msg);
    $('#toastRoot')?.append(t);
    setTimeout(() => t.remove(), 3000);
  };

  const crmKey = () => localStorage.getItem('clow_crm_key') || '';
  const userToken = () => localStorage.getItem('clow_token') || '';

  async function crmApi(path, opts = {}) {
    const h = { 'Authorization': 'Bearer ' + crmKey(), ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
      if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch('/v1/crm' + path, { ...opts, headers: h });
    if (r.status === 204) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || 'http_' + r.status);
    return d;
  }

  async function userApi(path, opts = {}) {
    const h = { 'Authorization': 'Bearer ' + userToken(), ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
      if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(path, { ...opts, headers: h });
    if (r.status === 204) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || 'http_' + r.status);
    return d;
  }

  // ─── Inject nav items + views ────────────────────────────────────────
  function injectExtras() {
    const nav = $('.sidebar nav');
    if (!nav || nav.querySelector('[data-view="settings"]')) return;

    const svgFlow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="6" y1="9" x2="12" y2="15"/><line x1="18" y1="9" x2="12" y2="15"/></svg>';
    const svgBrand = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
    const svgGear = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

    nav.append(
      el('button', { class: 'nav-item', data: { view: 'settings' } },
        el('span', { class: 'nav-icon', html: svgGear }),
        el('span', { class: 'nav-label' }, 'Configurações')),
    );

    const main = $('.main');
    main.append(
      el('div', { class: 'view', data: { view: 'settings' }, id: 'settingsView' },
        el('header', { class: 'top-bar' },
          el('div', { class: 'top-bar-left' }, el('h2', {}, 'Configurações da conta')),
        ),
        el('div', { id: 'settingsBody', style: 'padding:20px;overflow-y:auto' }),
      ),
    );

    $$('.nav-item').forEach(n => {
      if (!n.dataset._wired2) {
        n.dataset._wired2 = '1';
        n.addEventListener('click', () => showExtraView2(n.dataset.view));
      }
    });
    // flows browser removido (admin gerencia n8n na VPS dele)
  }

  async function showExtraView2(view) {
    if (view !== 'settings') return;
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
    if (view === 'flows') await renderFlows();
    else if (view === 'branding') await renderBranding();
    else if (view === 'settings') await renderSettings();
  }

  // ─── FLOWS (n8n) ─────────────────────────────────────────────────────
  async function renderFlows() {
    const l = $('#flowsList');
    const q = $('#flowsQuota');
    l.innerHTML = '';
    try {
      const r = await fetch('/v1/n8n/flows', { headers: { 'Authorization': 'Bearer ' + userToken() } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error);
      q.textContent = `${d.used}/${d.limit} fluxo(s) ativo(s)`;
      if (!d.flows.length) {
        l.append(el('div', { class: 'empty' }, 'Nenhum fluxo ainda. Clique "+ Instalar template" pra começar.'));
        return;
      }
      for (const f of d.flows) {
        l.append(el('div', { class: 'list-item', style: 'flex-direction:column;align-items:stretch' },
          el('div', { style: 'display:flex;align-items:center;justify-content:space-between' },
            el('div', { class: 'list-item-left' },
              el('div', {},
                el('div', { class: 'list-item-title' }, f.name),
                el('div', { class: 'list-item-sub' }, `${f.templateKey || 'custom'} · ${f.runsCount || 0} execuções`),
              ),
            ),
            el('span', { class: `pill ${f.status === 'active' ? 'green' : 'gray'}` }, f.status),
          ),
          el('div', { style: 'margin-top:10px;font-size:11px;color:var(--text-dim);word-break:break-all' },
            el('strong', {}, 'Webhook: '),
            el('code', { style: 'background:var(--bg-3);padding:3px 6px;border-radius:4px;user-select:all' }, f.webhookUrl || '—'),
          ),
          el('div', { style: 'margin-top:10px;display:flex;gap:6px' },
            el('button', { class: 'save-btn', style: 'background:transparent;border:1px solid var(--border);color:var(--text);font-size:12px;padding:7px 14px',
              on: { click: async () => {
                const newStatus = f.status === 'active' ? 'disabled' : 'active';
                await fetch('/v1/n8n/flows/' + f.id, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + userToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
                await renderFlows();
                toast(newStatus === 'active' ? 'Ativado' : 'Pausado', 'success');
              } },
            }, f.status === 'active' ? 'Pausar' : 'Ativar'),
            el('button', { class: 'save-btn', style: 'background:transparent;border:1px solid var(--red);color:var(--red);font-size:12px;padding:7px 14px',
              on: { click: async () => {
                if (!(await clowConfirm('Apagar "' + f.name + '"?', { title: 'Apagar fluxo', danger: true, confirmLabel: 'Apagar' }))) return;
                await fetch('/v1/n8n/flows/' + f.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + userToken() } });
                await renderFlows();
                toast('Removido', 'success');
              } },
            }, 'Apagar'),
          ),
        ));
      }
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  }

  async function openFlowsBrowser() {
    const r = await fetch('/v1/n8n/templates', { headers: { 'Authorization': 'Bearer ' + userToken() } });
    const d = await r.json();
    const backdrop = el('div', { class: 'modal-backdrop' });
    const list = el('div', { style: 'max-height:55vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px' });
    for (const t of d.templates) {
      list.append(el('div', { style: 'background:var(--bg-3);border:1px solid var(--border);border-radius:10px;padding:14px' },
        el('div', { style: 'font-weight:600;font-size:13px;margin-bottom:4px' }, t.name),
        el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.5' }, t.description),
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px' },
          el('span', { style: 'font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:1px' }, t.category + ' · ' + t.triggers.join(', ')),
          el('button', { class: 'save-btn', style: 'padding:6px 14px;font-size:12px;background:var(--grad);color:#fff;border:none',
            on: { click: async () => {
              try {
                const res = await fetch('/v1/n8n/flows/install-template', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + userToken(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ key: t.key }),
                });
                const resd = await res.json();
                if (!res.ok) throw new Error(resd.message || resd.error);
                backdrop.remove();
                await renderFlows();
                toast('Fluxo instalado', 'success');
              } catch (err) { toast('Erro: ' + err.message, 'error'); }
            } },
          }, 'Instalar'),
        ),
      ));
    }
    backdrop.append(el('div', { class: 'modal', style: 'max-width:620px' },
      el('h3', {}, 'Templates de fluxo n8n'),
      list,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'cancel', on: { click: () => backdrop.remove() } }, 'Fechar'),
      ),
    ));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.append(backdrop);
  }

  // ─── BRANDING ────────────────────────────────────────────────────────
  async function renderBranding() {
    const body = $('#brandingBody');
    body.innerHTML = '';

    try {
      const me = await userApi('/auth/me');
      if (me.user.tier !== 'empresarial') {
        body.append(el('div', { style: 'max-width:560px;margin:40px auto;text-align:center;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:40px' },
          el('div', { style: 'font-size:54px;margin-bottom:14px' }, '🔒'),
          el('h3', { style: 'margin:0 0 10px' }, 'Exclusivo do plano Empresarial'),
          el('p', { style: 'color:var(--text-dim);margin:0 0 20px;font-size:14px;line-height:1.6' },
            'White-label (logo próprio, cores, nome, domínio customizado) está disponível só no plano Empresarial. Faça upgrade pra liberar.'),
          el('a', { href: '/pricing', style: 'display:inline-block;background:var(--grad);color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:700' }, 'Ver planos →'),
        ));
        return;
      }

      const r = await fetch('/v1/branding/branding?tenant_id=' + me.user.id);
      const d = await r.json();

      const form = el('form', { style: 'max-width:600px;margin:0 auto;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:30px',
        on: { submit: async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          try {
            await userApi('/v1/branding/branding', { method: 'PUT', body: {
              brand_name: fd.get('brand_name'),
              logo_url: fd.get('logo_url'),
              primary_color: fd.get('primary_color'),
              secondary_color: fd.get('secondary_color'),
              custom_domain: fd.get('custom_domain'),
            } });
            toast('Marca atualizada', 'success');
            await renderBranding();
          } catch (err) { toast('Erro: ' + err.message, 'error'); }
        } },
      },
        el('div', { class: 'field' }, el('label', {}, 'Nome da marca'),
          el('input', { name: 'brand_name', type: 'text', value: d.brand_name || '', placeholder: 'Ex: Corretora XYZ CRM' })),
        el('div', { class: 'field' }, el('label', {}, 'URL do logo (PNG/SVG, fundo transparente, ~200px)'),
          el('input', { name: 'logo_url', type: 'url', value: d.logo_url || '', placeholder: 'https://seudominio.com/logo.png' })),
        el('div', { style: 'display:flex;gap:12px' },
          el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Cor primária'),
            el('input', { name: 'primary_color', type: 'text', value: d.primary_color || '#9B59FC', placeholder: '#9B59FC' })),
          el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Cor secundária'),
            el('input', { name: 'secondary_color', type: 'text', value: d.secondary_color || '#4A9EFF', placeholder: '#4A9EFF' })),
        ),
        el('div', { class: 'field' }, el('label', {}, 'Domínio customizado (CNAME apontado pra gente)'),
          el('input', { name: 'custom_domain', type: 'text', value: d.custom_domain || '', placeholder: 'crm.suaempresa.com.br' }),
          el('div', { style: 'font-size:11px;color:var(--text-faint);margin-top:4px' },
            'Aponte um CNAME do seu domínio pra system-clow.pvcorretor01.com.br. Depois nos avise pra configurarmos SSL.'),
        ),
        el('div', { style: 'display:flex;justify-content:flex-end;margin-top:20px' },
          el('button', { type: 'submit', class: 'save-btn' }, 'Salvar'),
        ),
      );
      body.append(form);
    } catch (err) {
      body.append(el('div', { class: 'empty' }, 'Erro: ' + err.message));
    }
  }

  // ─── SETTINGS ────────────────────────────────────────────────────────
  async function renderSettings() {
    const body = $('#settingsBody');
    body.innerHTML = '';

    // Onda 56: tenta /auth/me (user session) e se falhar, fallback /v1/crm/me (api_key CRM)
    let me;
    try {
      me = await userApi('/auth/me');
    } catch {
      try {
        const crmMe = await crmApi('/me');
        // Adapta formato do /v1/crm/me pra ficar compativel com o /auth/me
        me = {
          ok: true,
          user: {
            id: crmMe?.tenant?.id || null,
            email: crmMe?.tenant?.email || '—',
            name: crmMe?.tenant?.name || '—',
            tier: crmMe?.tenant?.tier || 'unknown',
            status: crmMe?.tenant?.status || 'unknown',
            phone: null,
            authorized_phones: [],
            role: 'owner',
          },
          _fromCrm: true,
        };
      } catch (e2) {
        body.append(el('div', { class: 'empty', style: 'text-align:center;padding:40px' },
          el('div', { style: 'font-size:14px;color:var(--text-dim);margin-bottom:14px' }, 'Não foi possível carregar suas configurações.'),
          el('button', {
            style: 'background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:600',
            on: { click: () => location.reload() }
          }, 'Recarregar página'),
        ));
        return;
      }
    }

    let usage;
    try { usage = await userApi('/auth/usage'); } catch { usage = null; }

    // === Profile card ===
    body.append(el('div', { style: 'max-width:720px;margin:0 auto 20px;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:26px' },
      el('h3', { style: 'margin:0 0 18px;font-size:15px' }, 'Minha conta'),
      el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:12px' },
        infoRow('Nome', me.user.name),
        infoRow('Email (login)', me.user.email),
        infoRow('Plano', el('span', { class: 'pill purple' }, me.user.tier.toUpperCase())),
        infoRow('Status', el('span', { class: `pill ${me.user.status === 'active' ? 'green' : 'amber'}` }, me.user.status)),
      ),
    ));

    // === Usage card ===
    if (usage) {
      const m = usage.messages;
      const pct = Math.min(100, (m.current / m.limit) * 100);
      const over = m.current > m.limit;
      body.append(el('div', { style: 'max-width:720px;margin:0 auto 20px;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:26px' },
        el('h3', { style: 'margin:0 0 14px;font-size:15px' }, 'Uso do mês'),
        el('div', { style: 'font-size:13px;color:var(--text-dim);margin-bottom:8px;display:flex;justify-content:space-between' },
          el('span', {}, 'Mensagens IA'),
          el('span', { style: over ? 'color:var(--red)' : 'color:var(--text)' }, m.current + ' / ' + m.limit + (over ? ` · overage R$ ${(m.overage_cost_cents/100).toFixed(2)}` : '')),
        ),
        el('div', { style: 'height:10px;background:var(--bg-3);border-radius:99px;overflow:hidden' },
          el('div', { style: `height:100%;width:${pct}%;background:${over ? 'var(--red)' : 'var(--grad)'};transition:width .3s` }),
        ),
        el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:18px' },
          infoRow('Contatos (lim)', usage.contacts.limit),
          infoRow('Boards (lim)', usage.boards.limit),
          infoRow('Fluxos n8n (lim)', usage.flows.limit),
        ),
      ));
    }

    // === Authorized phones ===
    const phonesList = el('div', { id: 'phonesListEl', style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px' });
    function renderPhonesInner() {
      phonesList.innerHTML = '';
      (me.user.authorized_phones || []).forEach((p, idx) => {
        phonesList.append(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;background:var(--bg-3);border-radius:8px;padding:10px 14px' },
          el('span', { style: 'font-family:monospace;font-size:13px' }, '+' + p),
          (me.user.authorized_phones.length > 1) ? el('button', {
            style: 'background:transparent;border:1px solid var(--red);color:var(--red);padding:5px 12px;border-radius:6px;font-size:11px;cursor:pointer',
            on: { click: async () => {
              const next = me.user.authorized_phones.filter((_, i) => i !== idx);
              await userApi('/auth/authorized-phones', { method: 'POST', body: { phones: next } });
              me.user.authorized_phones = next;
              renderPhonesInner();
              toast('Removido', 'success');
            } },
          }, 'Remover') : null,
        ));
      });
    }
    renderPhonesInner();

    body.append(el('div', { style: 'max-width:720px;margin:0 auto 20px;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:26px' },
      el('h3', { style: 'margin:0 0 10px;font-size:15px' }, 'Telefones autorizados'),
      el('p', { style: 'font-size:12px;color:var(--text-dim);margin:0 0 14px' },
        'Apenas esses números podem comandar sua IA via WhatsApp pessoal.'),
      phonesList,
      el('form', { style: 'display:flex;gap:8px',
        on: { submit: async (e) => {
          e.preventDefault();
          const inp = e.target.querySelector('input');
          const digits = inp.value.replace(/\D/g, '');
          if (digits.length < 10) return toast('Telefone inválido', 'error');
          const full = digits.startsWith('55') ? digits : '55' + digits;
          const next = [...(me.user.authorized_phones || []), full];
          await userApi('/auth/authorized-phones', { method: 'POST', body: { phones: next } });
          me.user.authorized_phones = next;
          inp.value = '';
          renderPhonesInner();
          toast('Adicionado', 'success');
        } },
      },
        el('input', { type: 'tel', placeholder: '(21) 99999-8888', style: 'flex:1;padding:10px;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit' }),
        el('button', { type: 'submit', style: 'padding:10px 20px;background:var(--grad);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit' }, '+ Adicionar'),
      ),
    ));

    // === Change password ===
    body.append(el('div', { style: 'max-width:720px;margin:0 auto 20px;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:26px' },
      el('h3', { style: 'margin:0 0 14px;font-size:15px' }, 'Trocar senha'),
      el('form', {
        on: { submit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            await userApi('/auth/change-password', { method: 'POST', body: {
              old_password: fd.get('old_password'),
              new_password: fd.get('new_password'),
            } });
            toast('Senha alterada', 'success');
            e.target.reset();
          } catch (err) { toast('Erro: ' + err.message, 'error'); }
        } },
      },
        el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px' },
          el('div', { class: 'field' }, el('label', {}, 'Senha atual'),
            el('input', { name: 'old_password', type: 'password', required: '' })),
          el('div', { class: 'field' }, el('label', {}, 'Nova senha (mín. 8)'),
            el('input', { name: 'new_password', type: 'password', required: '', minlength: '8' })),
        ),
        el('button', { type: 'submit', class: 'save-btn' }, 'Atualizar senha'),
      ),
    ));

    // === Danger zone ===
    body.append(el('div', { style: 'max-width:720px;margin:0 auto;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);border-radius:14px;padding:26px' },
      el('h3', { style: 'margin:0 0 10px;font-size:15px;color:var(--red)' }, 'Zona de perigo'),
      el('p', { style: 'font-size:12px;color:var(--text-dim);margin:0 0 16px;line-height:1.6' },
        'Cancelar assinatura: seus dados ficam congelados 30 dias, depois são apagados. Você consegue exportar CSV de contatos antes de cancelar.'),
      el('div', { style: 'display:flex;gap:10px' },
        el('a', { href: '/pricing', style: 'flex:1;padding:10px;background:var(--bg-3);color:var(--text);border-radius:8px;font-size:12px;font-weight:600;text-align:center;text-decoration:none' }, 'Trocar plano'),
        el('button', {
          style: 'padding:10px 16px;background:transparent;border:1px solid var(--red);color:var(--red);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit',
          on: { click: async () => {
            if (!(await clowConfirm('Cancelar assinatura? Você continua com acesso até o fim do período já pago.', { title: 'Cancelar assinatura', danger: true, confirmLabel: 'Cancelar' }))) return;
            toast('Entre em contato pelo WhatsApp pra finalizar cancelamento.', 'error');
          } },
        }, 'Cancelar assinatura'),
      ),
    ));
  }

  function infoRow(label, value) {
    return el('div', {},
      el('div', { style: 'font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:600' }, label),
      el('div', { style: 'font-size:13px;color:var(--text)' }, value),
    );
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  function tryBoot() {
    if (!crmKey() || $('#app')?.classList.contains('hide')) {
      setTimeout(tryBoot, 500);
      return;
    }
    injectExtras();
  }
  document.addEventListener('DOMContentLoaded', tryBoot);
  setTimeout(tryBoot, 1800);
})();
