/**
 * Public view + sign page for documents — HTML rendered at /p/docs/:token.
 * Signature pad drawn on <canvas>, submitted as base64 PNG.
 */

import type { DocumentRecord } from './documents.js';

export function buildDocumentHTML(doc: DocumentRecord, baseUrl: string): string {
  const signUrl = `${baseUrl}/p/docs/${encodeURIComponent(doc.publicToken)}/sign`;
  const alreadySigned = doc.status === 'signed';

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f8fafc; color: #1e293b; }
  .wrap { max-width: 820px; margin: 0 auto; background: #fff; padding: 32px 40px; border-radius: 12px; box-shadow: 0 2px 20px rgba(0,0,0,.06); }
  .hdr { border-bottom: 3px solid #9B59FC; padding-bottom: 14px; margin-bottom: 24px; }
  .hdr h1 { color: #9B59FC; margin: 0; }
  .meta { color: #64748b; font-size: 13px; margin-top: 4px; }
  .body { line-height: 1.7; font-size: 14px; }
  .sign-section { margin-top: 40px; padding-top: 24px; border-top: 2px solid #e2e8f0; }
  .sign-section h3 { color: #1e293b; margin-bottom: 12px; }
  label { display: block; font-size: 13px; font-weight: 500; color: #475569; margin: 12px 0 4px; }
  input[type=text], input[type=email] { width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  input:focus { outline: 2px solid #9B59FC; border-color: #9B59FC; }
  .sigpad { border: 2px dashed #cbd5e1; border-radius: 8px; margin: 8px 0; background: #fff; cursor: crosshair; touch-action: none; width: 100%; }
  .sigpad-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  .sigpad-actions button { background: #f1f5f9; border: 1px solid #e2e8f0; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .submit { width: 100%; padding: 14px; background: #9B59FC; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 20px; }
  .submit:hover { background: #8b49ec; }
  .submit:disabled { opacity: .6; cursor: wait; }
  .signed { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px; color: #166534; margin-top: 24px; }
  .msg { padding: 14px; border-radius: 8px; margin-top: 12px; font-size: 14px; display: none; }
  .msg.err { background: #fef2f2; color: #991b1b; display: block; }
</style>
</head><body>
<div class="wrap">
  <div class="hdr">
    <h1>${escapeHtml(doc.title)}</h1>
    <div class="meta">Versão ${doc.version} · Emitido ${new Date(doc.createdAt).toLocaleDateString('pt-BR')}</div>
  </div>
  <div class="body">${doc.bodyHtml}</div>

  ${alreadySigned ? `
    <div class="signed">
      <b>✓ Documento assinado</b><br>
      <span style="font-size:13px">Assinado por: ${escapeHtml(doc.signedBy || '—')}<br>
      Data: ${doc.signedAt ? new Date(doc.signedAt).toLocaleString('pt-BR') : '—'}<br>
      IP registrado: ${escapeHtml(doc.signedIp || '—')}</span>
    </div>
  ` : `
    <div class="sign-section">
      <h3>Assinar digitalmente</h3>
      <form id="signForm">
        <label>Nome completo *</label>
        <input type="text" name="signedBy" required>
        <label>Desenhe sua assinatura abaixo</label>
        <canvas id="sigpad" class="sigpad" width="760" height="180"></canvas>
        <div class="sigpad-actions">
          <button type="button" id="clearPad">Limpar</button>
        </div>
        <label style="margin-top:12px">
          <input type="checkbox" name="agreed" required style="width:auto;vertical-align:middle">
          Li e concordo com os termos deste documento
        </label>
        <button class="submit" type="submit">Assinar</button>
        <div id="msg" class="msg"></div>
      </form>
    </div>
  `}
</div>

${alreadySigned ? '' : `<script>
(function(){
  var canvas = document.getElementById('sigpad');
  var ctx = canvas.getContext('2d');
  ctx.lineWidth = 2; ctx.strokeStyle = '#1e293b'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  var drawing = false, hasDrawn = false;

  function pos(e) {
    var r = canvas.getBoundingClientRect();
    var x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    var y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: x * canvas.width / r.width, y: y * canvas.height / r.height };
  }
  function start(e) { e.preventDefault(); drawing = true; hasDrawn = true; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function draw(e) { if (!drawing) return; e.preventDefault(); var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function stop() { drawing = false; }

  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stop); canvas.addEventListener('mouseout', stop);
  canvas.addEventListener('touchstart', start); canvas.addEventListener('touchmove', draw);
  canvas.addEventListener('touchend', stop);

  document.getElementById('clearPad').addEventListener('click', function(){
    ctx.clearRect(0, 0, canvas.width, canvas.height); hasDrawn = false;
  });

  document.getElementById('signForm').addEventListener('submit', function(e){
    e.preventDefault();
    var msg = document.getElementById('msg');
    if (!hasDrawn) { msg.className = 'msg err'; msg.textContent = 'Por favor, desenhe sua assinatura.'; return; }
    var fd = new FormData(e.target);
    var body = { signedBy: fd.get('signedBy'), signatureImage: canvas.toDataURL('image/png') };
    var btn = e.target.querySelector('.submit'); btn.disabled = true;
    fetch('${signUrl}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); }).then(function(j){
        if (j.ok) { location.reload(); }
        else { btn.disabled = false; msg.className = 'msg err'; msg.textContent = j.error || 'Erro ao assinar.'; }
      }).catch(function(){ btn.disabled = false; msg.className = 'msg err'; msg.textContent = 'Erro de rede.'; });
  });
})();
</script>`}

</body></html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
