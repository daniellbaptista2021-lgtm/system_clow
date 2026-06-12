/**
 * Generate standalone JavaScript snippet that renders a form on a 3rd-party site.
 * Called from GET /p/forms/:slug/embed.js — returns text/javascript.
 */

import type { FormDef } from './forms.js';

export function buildEmbedJS(form: FormDef, baseUrl: string): string {
  // Generate a self-contained IIFE that:
  //  1. Creates a container div if not present
  //  2. Renders the form HTML
  //  3. Handles submit with fetch() → show thank-you or redirect
  const config = {
    formId: form.id,
    slug: form.slug,
    fields: form.fields,
    submitUrl: `${baseUrl}/p/forms/${form.slug}`,
    redirectUrl: form.redirectUrl || '',
    title: form.name,
  };
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');

  return `(function() {
  var cfg = ${configJson};
  var target = document.currentScript && document.currentScript.getAttribute('data-target');
  var mount;
  if (target) {
    mount = document.querySelector(target);
    if (!mount) { mount = document.createElement('div'); mount.id = target.replace(/^#/, ''); document.currentScript.parentNode.insertBefore(mount, document.currentScript); }
  } else {
    mount = document.createElement('div');
    document.currentScript.parentNode.insertBefore(mount, document.currentScript);
  }

  var style = document.createElement('style');
  style.textContent = '' +
    '.clow-form{font-family:system-ui,sans-serif;max-width:480px;background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}' +
    '.clow-form h3{margin:0 0 16px;color:#1e293b;font-size:20px}' +
    '.clow-form label{display:block;margin-bottom:4px;font-size:13px;color:#475569;font-weight:500}' +
    '.clow-form input,.clow-form textarea,.clow-form select{width:100%;padding:10px;margin-bottom:12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;box-sizing:border-box}' +
    '.clow-form input:focus,.clow-form textarea:focus,.clow-form select:focus{outline:2px solid #9B59FC;border-color:#9B59FC}' +
    '.clow-form button{width:100%;padding:12px;background:#9B59FC;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}' +
    '.clow-form button:hover{background:#8b49ec}' +
    '.clow-form button:disabled{opacity:.6;cursor:wait}' +
    '.clow-form .msg{padding:14px;border-radius:6px;margin-top:8px;font-size:14px}' +
    '.clow-form .msg.ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}' +
    '.clow-form .msg.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}';
  document.head.appendChild(style);

  var form = document.createElement('form');
  form.className = 'clow-form';
  var h = document.createElement('h3'); h.textContent = cfg.title; form.appendChild(h);

  for (var i = 0; i < cfg.fields.length; i++) {
    var f = cfg.fields[i];
    if (f.type !== 'hidden') {
      var lbl = document.createElement('label'); lbl.textContent = f.label + (f.required ? ' *' : ''); form.appendChild(lbl);
    }
    var input;
    if (f.type === 'textarea') { input = document.createElement('textarea'); input.rows = 4; }
    else if (f.type === 'select') {
      input = document.createElement('select');
      (f.options || []).forEach(function(opt){ var o = document.createElement('option'); o.value = opt; o.textContent = opt; input.appendChild(o); });
    } else {
      input = document.createElement('input');
      input.type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'number' ? 'number' : f.type === 'hidden' ? 'hidden' : 'text';
    }
    input.name = f.name;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.required) input.required = true;
    form.appendChild(input);
  }

  var btn = document.createElement('button'); btn.type = 'submit'; btn.textContent = 'Enviar'; form.appendChild(btn);
  var msg = document.createElement('div'); msg.className = 'msg'; msg.style.display = 'none'; form.appendChild(msg);

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    btn.disabled = true;
    var data = {};
    for (var i = 0; i < cfg.fields.length; i++) {
      var f = cfg.fields[i];
      var el = form.querySelector('[name="' + f.name + '"]');
      if (el) data[f.name] = el.value;
    }
    fetch(cfg.submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function(r){ return r.json(); }).then(function(j){
      btn.disabled = false;
      if (j.ok) {
        if (j.redirectUrl) { window.location.href = j.redirectUrl; return; }
        msg.className = 'msg ok'; msg.style.display = 'block'; msg.textContent = 'Recebido! Obrigado.';
        form.querySelectorAll('input,textarea,select').forEach(function(el){ if (el.type !== 'hidden') el.value = ''; });
      } else {
        msg.className = 'msg err'; msg.style.display = 'block'; msg.textContent = j.error || 'Erro ao enviar.';
      }
    }).catch(function(err){
      btn.disabled = false;
      msg.className = 'msg err'; msg.style.display = 'block'; msg.textContent = 'Erro de rede.';
    });
  });

  mount.appendChild(form);
})();`;
}

export function buildHostedFormHTML(form: FormDef, baseUrl: string): string {
  // Simple standalone HTML page for the hosted form
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeHtml(form.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}</style>
</head><body>
<div id="clow-form-mount"></div>
<script src="${baseUrl}/p/forms/${encodeURIComponent(form.slug)}/embed.js" data-target="#clow-form-mount"></script>
</body></html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
