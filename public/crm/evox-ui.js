/* EVOX — barra do topo: nome da conta e busca no funil.
 * O nome vem do mesmo lugar que o rodapé do menu (#tenantName), que o crm.js
 * preenche depois do login. A busca filtra os cards já desenhados (título,
 * contato e etiquetas); em Contatos, repassa o texto para a busca de lá. */
(function () {
  const nome = document.getElementById('evoxUsuarioNome');
  const avatar = document.getElementById('evoxAvatar');
  const fonte = document.getElementById('tenantName');
  function copiarNome() {
    const n = (fonte && fonte.textContent || '').trim();
    if (!n || n === '—') return;
    nome.textContent = n;
    avatar.textContent = n.split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
  }
  if (fonte) new MutationObserver(copiarNome).observe(fonte, { childList: true, characterData: true, subtree: true });
  copiarNome();

  const busca = document.getElementById('evoxBusca');
  function filtrar() {
    const q = busca.value.trim().toLowerCase();
    const contatos = document.getElementById('contactsView');
    if (contatos && contatos.classList.contains('active')) {
      const alvo = document.getElementById('contactSearchInput');
      if (alvo) { alvo.value = busca.value; alvo.dispatchEvent(new Event('input', { bubbles: true })); }
      return;
    }
    document.querySelectorAll('#kanban .card').forEach((c) => {
      c.style.display = !q || c.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }
  busca.addEventListener('input', filtrar);
  // O funil é redesenhado a cada atualização: reaplica o filtro.
  const k = document.getElementById('kanban');
  if (k) new MutationObserver(() => { if (busca.value) filtrar(); }).observe(k, { childList: true });
})();

/* Barra de baixo do celular: atalhos para as telas principais. "Mais" abre o
 * menu completo (o mesmo botão ☰ do crm.js, que fica escondido no celular). */
(function () {
  const barra = document.getElementById('evoxAbasBaixo'); if (!barra) return;
  barra.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ir]'); if (!b) return;
    const ir = b.dataset.ir;
    if (ir === 'menu') { document.getElementById('sidebarToggle')?.click(); return; }
    document.querySelector(`.sidebar .nav-item[data-view="${ir}"]`)?.click();
  });
  function marcar() {
    const ativa = [...document.querySelectorAll('.view.active')].find((v) => getComputedStyle(v).display !== 'none')?.dataset.view;
    barra.querySelectorAll('button[data-ir]').forEach((b) => b.classList.toggle('ativa', b.dataset.ir === ativa));
  }
  document.querySelectorAll('.view').forEach((v) => new MutationObserver(marcar).observe(v, { attributes: true, attributeFilter: ['class'] }));
  marcar();
})();

/* Celular: o campo de mensagem é estreito; o texto de dica fica curto. */
(function () {
  const t = document.getElementById('composerText'); if (!t) return;
  const longo = t.placeholder;
  const ajustar = () => { t.placeholder = matchMedia('(max-width: 768px)').matches ? 'Mensagem' : longo; };
  matchMedia('(max-width: 768px)').addEventListener?.('change', ajustar); ajustar();
})();
