/**
 * Public booking page for /p/book/:slug — renders a day picker + slot grid.
 */

import type { SchedulingLink } from './calendar.js';

export function buildBookingHTML(link: SchedulingLink, baseUrl: string): string {
  const cfg = {
    slug: link.slug,
    title: link.title,
    description: link.description || '',
    durationMinutes: link.durationMinutes,
    timezone: link.timezone,
    requireEmail: link.requireEmail,
    requirePhone: link.requirePhone,
    requireName: link.requireName,
    slotsUrl: `${baseUrl}/p/book/${encodeURIComponent(link.slug)}/slots`,
    bookUrl: `${baseUrl}/p/book/${encodeURIComponent(link.slug)}/book`,
  };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeHtml(link.title)} — Agendar</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f8fafc; color: #1e293b; }
  .wrap { max-width: 720px; margin: 0 auto; background: #fff; padding: 28px; border-radius: 12px; box-shadow: 0 2px 20px rgba(0,0,0,.06); }
  h1 { color: #9B59FC; margin: 0 0 6px; }
  .meta { color: #64748b; font-size: 14px; margin-bottom: 20px; }
  .cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin: 16px 0; }
  .day { aspect-ratio: 1; background: #f1f5f9; border: 0; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .day:hover { background: #e2e8f0; }
  .day.active { background: #9B59FC; color: #fff; }
  .day.muted { color: #cbd5e1; cursor: not-allowed; pointer-events: none; }
  .slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; min-height: 60px; }
  .slot { background: #fff; border: 2px solid #e2e8f0; padding: 10px 6px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; text-align: center; }
  .slot:hover { border-color: #9B59FC; color: #9B59FC; }
  .slot.selected { background: #9B59FC; color: #fff; border-color: #9B59FC; }
  .form { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; display: none; }
  .form.show { display: block; }
  label { display: block; font-size: 13px; font-weight: 500; color: #475569; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  input:focus { outline: 2px solid #9B59FC; border-color: #9B59FC; }
  button.submit { width: 100%; padding: 14px; background: #9B59FC; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; }
  button.submit:hover { background: #8b49ec; }
  button.submit:disabled { opacity: .6; cursor: wait; }
  .msg { padding: 14px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
  .msg.ok { background: #f0fdf4; color: #166534; }
  .msg.err { background: #fef2f2; color: #991b1b; }
  .day-header { text-align: center; font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
</style>
</head><body>
<div class="wrap">
  <h1>${escapeHtml(link.title)}</h1>
  <div class="meta">Duração: ${link.durationMinutes} min · Fuso: ${escapeHtml(link.timezone)}${link.description ? '<br>' + escapeHtml(link.description) : ''}</div>
  <div id="daysHdr" class="cal">
    <div class="day-header">Dom</div><div class="day-header">Seg</div><div class="day-header">Ter</div>
    <div class="day-header">Qua</div><div class="day-header">Qui</div><div class="day-header">Sex</div><div class="day-header">Sab</div>
  </div>
  <div id="days" class="cal"></div>
  <div id="slots" class="slots"></div>
  <form id="bookForm" class="form">
    ${link.requireName ? '<label>Nome *</label><input name="name" required>' : ''}
    ${link.requireEmail ? '<label>Email *</label><input name="email" type="email" required>' : ''}
    ${link.requirePhone ? '<label>Telefone *</label><input name="phone" type="tel" required>' : ''}
    <label>Mensagem (opcional)</label>
    <input name="notes">
    <button class="submit" type="submit">Confirmar agendamento</button>
    <div id="bookMsg"></div>
  </form>
</div>
<script>
(function(){
  var cfg = ${json};
  var state = { day: null, slot: null, slotsByDay: {} };

  function fmtDay(d) { return d.getDate(); }
  function ymd(d) { return d.toISOString().slice(0,10); }

  function renderDays() {
    var container = document.getElementById('days');
    container.innerHTML = '';
    var today = new Date(); today.setHours(0,0,0,0);
    var first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
    for (var i = 0; i < 28; i++) {
      var d = new Date(first); d.setDate(first.getDate() + i);
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'day';
      btn.textContent = fmtDay(d);
      if (d < today) btn.classList.add('muted');
      (function(dayDate){
        btn.addEventListener('click', function(){ selectDay(dayDate, btn); });
      })(d);
      container.appendChild(btn);
    }
  }

  function selectDay(d, btn) {
    document.querySelectorAll('.day.active').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    state.day = d;
    fetchSlots(d);
  }

  function fetchSlots(d) {
    var from = new Date(d); from.setHours(0,0,0,0);
    var to = new Date(d); to.setHours(23,59,59,999);
    var url = cfg.slotsUrl + '?from=' + from.getTime() + '&to=' + to.getTime();
    fetch(url).then(function(r){ return r.json(); }).then(function(data){
      renderSlots(data.slots || []);
    }).catch(function(){ renderSlots([]); });
  }

  function renderSlots(slots) {
    var container = document.getElementById('slots');
    container.innerHTML = '';
    if (slots.length === 0) {
      container.innerHTML = '<div style="grid-column:span 4;color:#94a3b8;text-align:center;padding:16px">Nenhum horário disponível neste dia</div>';
      document.getElementById('bookForm').classList.remove('show');
      return;
    }
    slots.forEach(function(sl){
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'slot';
      var d = new Date(sl.start);
      btn.textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      btn.addEventListener('click', function(){
        document.querySelectorAll('.slot.selected').forEach(function(b){ b.classList.remove('selected'); });
        btn.classList.add('selected');
        state.slot = sl;
        document.getElementById('bookForm').classList.add('show');
      });
      container.appendChild(btn);
    });
  }

  document.getElementById('bookForm').addEventListener('submit', function(e){
    e.preventDefault();
    if (!state.slot) return;
    var fd = new FormData(e.target);
    var body = { startsAt: state.slot.start };
    ['name','email','phone','notes'].forEach(function(k){ var v = fd.get(k); if (v) body[k] = v; });
    var btn = e.target.querySelector('button.submit');
    btn.disabled = true;
    fetch(cfg.bookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); }).then(function(j){
        btn.disabled = false;
        var msg = document.getElementById('bookMsg');
        if (j.ok) {
          msg.className = 'msg ok';
          msg.textContent = 'Agendado! Você receberá uma confirmação.';
          e.target.querySelectorAll('input').forEach(function(el){ el.value = ''; });
          fetchSlots(state.day); // refresh
        } else {
          msg.className = 'msg err';
          msg.textContent = j.error || 'Erro ao agendar.';
        }
      }).catch(function(){
        btn.disabled = false;
        document.getElementById('bookMsg').className = 'msg err';
        document.getElementById('bookMsg').textContent = 'Erro de rede.';
      });
  });

  renderDays();
})();
</script>
</body></html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
