/**
 * clow-dialog.js — substitui prompt/confirm/alert nativos do browser por
 * modais com a paleta e estilo oficiais do System Clow.
 *
 * Uso (sempre async):
 *   const nome = await clowPrompt('Nome do plano:', 'Padrão');
 *   const ok = await clowConfirm('Apagar card?', { danger: true });
 *   await clowAlert('Salvo com sucesso');
 *   const plano = await clowSelect('Escolha:', [{value:'a',label:'A'}, {value:'b',label:'B'}]);
 *   const data = await clowPrompt('Vencimento:', '2026-04-23', { type: 'date' });
 *
 * Retornos:
 *   prompt  → string | null (null se cancelou)
 *   confirm → boolean
 *   alert   → undefined
 *   select  → value | null
 *
 * Suporta Enter = OK, Esc = Cancel, click backdrop = Cancel.
 */
(function() {
  if (window.clowPrompt) return; // idempotente
  ensureStyles();

  function ensureStyles() {
    if (document.getElementById('clow-dialog-style')) return;
    const st = document.createElement('style');
    st.id = 'clow-dialog-style';
    st.textContent = `
.cdlg-back{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(8,8,26,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);animation:cdlgIn .18s ease}
@keyframes cdlgIn{from{opacity:0}to{opacity:1}}
.cdlg{background:linear-gradient(180deg,var(--bg-2,#0F0F24),var(--bg,#08081a));border:1px solid rgba(155,89,252,.3);border-radius:18px;padding:28px 26px;max-width:440px;width:100%;box-shadow:0 30px 80px rgba(0,0,0,.55),0 1px 0 rgba(255,255,255,.04) inset;animation:cdlgPop .22s cubic-bezier(.2,.7,.2,1);font-family:inherit;color:var(--text,#E8E8F0)}
@keyframes cdlgPop{from{transform:translateY(12px) scale(.97);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}
.cdlg h3{margin:0 0 6px;font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--text,#E8E8F0);background:linear-gradient(135deg,#9B59FC,#4A9EFF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;display:inline-block}
.cdlg .cdlg-msg{color:var(--text-dim,#9898B8);font-size:13.5px;line-height:1.55;margin:0 0 18px;white-space:pre-wrap}
.cdlg input,.cdlg select,.cdlg textarea{width:100%;padding:12px 14px;background:var(--bg,#08081a);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:10px;color:var(--text,#E8E8F0);font-family:inherit;font-size:14px;outline:none;transition:border-color .15s,background .15s,box-shadow .15s;box-sizing:border-box}
.cdlg input:focus,.cdlg select:focus,.cdlg textarea:focus{border-color:#9B59FC;background:var(--bg-2,#0F0F24);box-shadow:0 0 0 3px rgba(155,89,252,.18)}
.cdlg textarea{min-height:90px;resize:vertical;font-family:inherit}
.cdlg .cdlg-actions{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}
.cdlg-btn{padding:11px 20px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;font-size:13.5px;font-weight:700;letter-spacing:-.005em;transition:transform .14s ease,box-shadow .14s ease,background .14s ease;min-width:96px}
.cdlg-btn:hover:not(:disabled){transform:translateY(-1px)}
.cdlg-btn-primary{background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;box-shadow:0 8px 22px rgba(155,89,252,.32)}
.cdlg-btn-primary:hover:not(:disabled){box-shadow:0 10px 28px rgba(155,89,252,.42)}
.cdlg-btn-ghost{background:transparent;color:var(--text-dim,#9898B8);border:1px solid var(--border,rgba(255,255,255,.1))}
.cdlg-btn-ghost:hover{color:var(--text,#E8E8F0);border-color:rgba(155,89,252,.4);background:rgba(155,89,252,.06)}
.cdlg-btn-danger{background:linear-gradient(135deg,#EF4444,#DC2626);color:#fff;box-shadow:0 8px 22px rgba(239,68,68,.32)}
.cdlg-btn-danger:hover:not(:disabled){box-shadow:0 10px 28px rgba(239,68,68,.42)}
.cdlg-hint{font-size:11.5px;color:var(--text-faint,#6E6E8C);margin-top:10px;line-height:1.5}
@media(max-width:480px){.cdlg{padding:24px 20px;border-radius:14px}.cdlg h3{font-size:16px}.cdlg-actions{flex-direction:column-reverse}.cdlg-btn{width:100%}}
`;
    document.head.appendChild(st);
  }

  function openShell({ title, message, content, actions, initialFocus }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'cdlg-back';
      const dlg = document.createElement('div');
      dlg.className = 'cdlg';

      if (title) {
        const h = document.createElement('h3');
        h.textContent = title;
        dlg.appendChild(h);
      }
      if (message) {
        const p = document.createElement('div');
        p.className = 'cdlg-msg';
        p.textContent = message;
        dlg.appendChild(p);
      }
      if (content) dlg.appendChild(content);

      const actionsEl = document.createElement('div');
      actionsEl.className = 'cdlg-actions';
      const btnRefs = {};
      (actions || []).forEach((a, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cdlg-btn cdlg-btn-' + (a.variant || 'ghost');
        b.textContent = a.label;
        b.addEventListener('click', () => { cleanup(); resolve(a.value); });
        actionsEl.appendChild(b);
        btnRefs[a.variant || ('btn' + idx)] = b;
      });
      dlg.appendChild(actionsEl);

      backdrop.appendChild(dlg);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { cleanup(); resolve(null); } });
      document.body.appendChild(backdrop);

      function onKey(e) {
        if (e.key === 'Escape') { cleanup(); resolve(null); }
        else if (e.key === 'Enter' && !(e.target?.tagName === 'TEXTAREA')) {
          const primary = btnRefs.primary || btnRefs.danger;
          if (primary) { e.preventDefault(); primary.click(); }
        }
      }
      document.addEventListener('keydown', onKey);
      function cleanup() {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
      }

      setTimeout(() => {
        if (initialFocus) initialFocus.focus();
        else (btnRefs.primary || btnRefs.danger || actionsEl.firstChild)?.focus();
        initialFocus?.select?.();
      }, 30);
    });
  }

  window.clowAlert = function(message, { title = 'Aviso' } = {}) {
    return openShell({
      title, message,
      actions: [{ label: 'OK', variant: 'primary', value: undefined }],
    });
  };

  window.clowConfirm = function(message, { title = 'Confirmar', danger = false, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
    return openShell({
      title, message,
      actions: [
        { label: cancelLabel, variant: 'ghost', value: false },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', value: true },
      ],
    }).then(v => v === true);
  };

  window.clowPrompt = function(message, defaultValue = '', { title = '', type = 'text', placeholder = '', hint = '', multiline = false } = {}) {
    const wrapper = document.createElement('div');
    const input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = type;
    if (placeholder) input.placeholder = placeholder;
    input.value = defaultValue ?? '';
    wrapper.appendChild(input);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'cdlg-hint';
      h.textContent = hint;
      wrapper.appendChild(h);
    }
    return openShell({
      title: title || message,
      message: title ? message : '',
      content: wrapper,
      initialFocus: input,
      actions: [
        { label: 'Cancelar', variant: 'ghost', value: '__cancel__' },
        { label: 'OK', variant: 'primary', value: '__ok__' },
      ],
    }).then(v => {
      if (v === '__ok__') return input.value;
      return null; // cancel / esc / backdrop
    });
  };

  window.clowSelect = function(message, options = [], { title = '', defaultValue = null, placeholder = 'Selecione…' } = {}) {
    const sel = document.createElement('select');
    if (placeholder) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = placeholder; o.disabled = true; o.selected = !defaultValue;
      sel.appendChild(o);
    }
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label;
      if (opt.value === defaultValue) o.selected = true;
      sel.appendChild(o);
    });
    return openShell({
      title: title || message,
      message: title ? message : '',
      content: sel,
      initialFocus: sel,
      actions: [
        { label: 'Cancelar', variant: 'ghost', value: '__cancel__' },
        { label: 'OK', variant: 'primary', value: '__ok__' },
      ],
    }).then(v => {
      if (v === '__ok__') return sel.value || null;
      return null;
    });
  };
})();
