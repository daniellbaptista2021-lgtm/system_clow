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
