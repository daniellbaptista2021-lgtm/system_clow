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
  window.evoxAplicarNome = function (n) {
    if (fonte) fonte.textContent = n;
    copiarNome();
  };
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
  function iniciar() {
    const barra = document.getElementById('evoxAbasBaixo'); if (!barra || barra.dataset.ligada) return;
    barra.dataset.ligada = '1';
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
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar, { once: true });
  else iniciar();
})();

/* Celular: o campo de mensagem é estreito; o texto de dica fica curto. */
(function () {
  const t = document.getElementById('composerText'); if (!t) return;
  const longo = t.placeholder;
  const ajustar = () => { t.placeholder = matchMedia('(max-width: 768px)').matches ? 'Mensagem' : longo; };
  matchMedia('(max-width: 768px)').addEventListener?.('change', ajustar); ajustar();
})();

/* Foto de perfil no canto superior direito. Clique no avatar → trocar ou
 * remover. A imagem é cortada em quadrado e reduzida a 320px no navegador
 * (fica leve e sempre cabe no círculo) antes de subir para o servidor. */
(function () {
  const avatar = document.getElementById('evoxAvatar');
  const menu = document.getElementById('evoxFotoMenu');
  const arquivo = document.getElementById('evoxFotoArquivo');
  if (!avatar || !menu || !arquivo) return;
  const token = () => { try { return localStorage.getItem('clow_token') || localStorage.getItem('clow_crm_key') || ''; } catch (e) { return ''; } };
  const api = (caminho, opts = {}) => fetch('/v1/crm' + caminho, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' } });
  let temFoto = false;

  async function alterarNome() {
    const atual = (document.getElementById('tenantName')?.textContent || '').trim();
    const novo = window.prompt('Como seu nome deve aparecer no EVOX?', atual === '—' ? '' : atual);
    if (novo === null) return;
    try {
      const r = await api('/perfil/nome', { method: 'PUT', body: JSON.stringify({ nome: novo }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.message || 'Não consegui salvar o nome.');
      window.evoxAplicarNome?.(j.nome);
    } catch (err) { alert(err.message || 'Não consegui salvar o nome.'); }
  }

  async function mostrar(url) {
    temFoto = !!url;
    menu.querySelector('[data-acao="remover"]').hidden = !temFoto;
    if (!url) { avatar.style.backgroundImage = ''; avatar.classList.remove('com-foto'); return; }
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token() } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = URL.createObjectURL(await r.blob());
      avatar.style.backgroundImage = `url("${blob}")`;
      avatar.classList.add('com-foto');
    } catch (e) { avatar.classList.remove('com-foto'); }
  }
  async function carregar() {
    if (!token()) return setTimeout(carregar, 1500);
    try { const r = await api('/me'); const j = await r.json(); mostrar(j?.tenant?.foto || null); } catch (e) {}
  }
  carregar();

  avatar.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.getElementById('evoxEditarNome')?.addEventListener('click', alterarNome);
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-acao]'); if (!b) return;
    menu.hidden = true;
    if (b.dataset.acao === 'nome') await alterarNome();
    if (b.dataset.acao === 'trocar') arquivo.click();
    if (b.dataset.acao === 'remover') { await api('/perfil/foto', { method: 'DELETE' }); mostrar(null); }
  });

  function reduzir(file) {
    return new Promise((ok, erro) => {
      const img = new Image();
      img.onload = () => {
        const lado = 320, c = document.createElement('canvas'); c.width = c.height = lado;
        const m = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, lado, lado);
        URL.revokeObjectURL(img.src); ok(c.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = () => erro(new Error('Não consegui abrir essa imagem.'));
      img.src = URL.createObjectURL(file);
    });
  }
  arquivo.addEventListener('change', async () => {
    const f = arquivo.files && arquivo.files[0]; arquivo.value = '';
    if (!f) return;
    avatar.classList.add('enviando');
    try {
      const imagem = await reduzir(f);
      const r = await api('/perfil/foto', { method: 'POST', body: JSON.stringify({ imagem }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || 'Não consegui salvar a foto.');
      await mostrar(j.foto);
    } catch (err) { alert(err.message || 'Não consegui salvar a foto.'); }
    finally { avatar.classList.remove('enviando'); }
  });
})();
