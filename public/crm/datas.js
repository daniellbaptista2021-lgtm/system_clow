/* ═══════════════════════════════════════════════════════════════════════
 * EVOX — Datas de relacionamento
 *
 * Aniversário do cliente, aniversário de apólice, datas comemorativas e
 * dias das profissões, em cartões. Cada cartão abre mensagens prontas com
 * o nome do cliente e do corretor, para copiar ou abrir direto no WhatsApp.
 *
 * O calendário e os textos moram no servidor (src/crm/datas/calendario.ts,
 * com teste); esta tela só mostra e preenche {nome}/{corretor}.
 * Mesmo molde do mcp-panel.js e do apresentacao.js.
 * ═══════════════════════════════════════════════════════════════════════ */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
      else if (k === 'html') e.innerHTML = v;
      else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(c));
    }
    return e;
  };
  const apiKey = () => window.clowStorage.getItem('clow_crm_key') || '';
  async function api(path, opts = {}) {
    const headers = { Authorization: `Bearer ${apiKey()}`, ...(opts.headers || {}) };
    if (opts.body && typeof opts.body !== 'string') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
    const r = await fetch(`/v1/crm${path}`, { ...opts, headers });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  }
  const aviso = (msg, tipo) => (window.toast ? window.toast(msg, tipo) : alert(msg));

  const TIPOS = {
    aniversario: { icone: '🎂', rotulo: 'Aniversário', cor: '#C18638' },
    apolice: { icone: '🛡️', rotulo: 'Apólice', cor: '#1A2A43' },
    profissao: { icone: '💼', rotulo: 'Dia da profissão', cor: '#395988' },
    comemorativa: { icone: '🎉', rotulo: 'Data comemorativa', cor: '#8E6224' },
  };
  const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  const paraData = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
  const diffDias = (de, ate) => Math.round((paraData(ate) - paraData(de)) / 86400000);
  function rotuloData(iso, hoje) {
    if (!iso) return '';
    const n = diffDias(hoje, iso);
    const d = paraData(iso);
    const base = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (n === 0) return 'Hoje';
    if (n === 1) return 'Amanhã';
    return `${DIAS_SEMANA[d.getUTCDay()]}, ${base}`;
  }

  const primeiroNome = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ''; };
  /** Preenche {nome} e {corretor}. Sem nome (mensagem para qualquer cliente), tira o vocativo. */
  function preencher(texto, nome, corretor) {
    let s = texto;
    if (nome) s = s.replace(/\{nome\}/g, primeiroNome(nome));
    else s = s.replace(/,\s*\{nome\}(?=[!.,])/g, '').replace(/\{nome\},\s*/g, '').replace(/\{nome\}/g, '');
    s = s.replace(/\{anos\}/g, 'mais um ano'); // modelo da biblioteca, sem apólice escolhida
    if (corretor) s = s.replace(/\{corretor\}/g, corretor);
    else s = s.replace(/,?\s*—?\s*\{corretor\}\.?/g, '');
    s = s.replace(/\s+([.,!?])/g, '$1').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function linkWhats(telefone, texto) {
    let d = String(telefone || '').replace(/\D/g, '');
    if (d && d.length <= 11) d = '55' + d;
    return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
  }
  async function copiar(texto, botao) {
    try { await navigator.clipboard.writeText(texto); }
    catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = texto;
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    if (botao) { const o = botao.textContent; botao.textContent = 'Copiado ✓'; setTimeout(() => { botao.textContent = o; }, 1500); }
  }

  let corretor = '';

  // ─── Menu e view ─────────────────────────────────────────────────────
  function montar() {
    const nav = $('.sidebar nav');
    if (!nav || $('#datasView')) return;
    const item = el('button', { class: 'nav-item', data: { view: 'datas' } },
      el('span', { class: 'nav-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M12 14.5c-.9-1.4-3-1-3 .6 0 1.4 3 3.2 3 3.2s3-1.8 3-3.2c0-1.6-2.1-2-3-.6z"/></svg>' }),
      el('span', { class: 'nav-label' }, 'Datas'),
      el('span', { class: 'dt-badge', id: 'datasBadge', style: 'display:none' }));
    const ref = $('.nav-item[data-view="apresentacao"]', nav) || $('.nav-item[data-view="kanban"]', nav);
    if (ref && ref.nextSibling) nav.insertBefore(item, ref.nextSibling); else nav.append(item);

    $('.main').append(el('div', { class: 'view', data: { view: 'datas' }, id: 'datasView' },
      el('header', { class: 'top-bar' },
        el('div', { class: 'top-bar-left' }, el('h2', {}, 'Datas')),
        el('div', { class: 'apr-abas' },
          el('button', { class: 'secondary', id: 'dtAbaAgenda', on: { click: () => mostrarAgenda() } }, 'Agenda'),
          el('button', { class: 'secondary', id: 'dtAbaClientes', on: { click: () => mostrarClientes() } }, 'Clientes'),
          el('button', { class: 'secondary', id: 'dtAbaMensagens', on: { click: () => mostrarBiblioteca() } }, 'Mensagens'))),
      el('div', { id: 'dtCorpo', class: 'apr-corpo' })));

    $$('.nav-item').forEach((n) => {
      if (n.dataset._dtWired) return;
      n.dataset._dtWired = '1';
      n.addEventListener('click', () => { if (n.dataset.view === 'datas') mostrar(); });
    });
    atualizarBadge();
    setInterval(atualizarBadge, 30 * 60 * 1000);
  }

  async function atualizarBadge() {
    try {
      const r = await api('/datas/resumo');
      const b = $('#datasBadge');
      if (!b) return;
      b.textContent = String(r.alertas);
      b.style.display = r.alertas ? '' : 'none';
      b.title = `${r.alertas} para hoje`;
    } catch { /* sem login ainda */ }
  }

  function mostrar() {
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === 'datas'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'datas'));
    mostrarAgenda();
  }
  const corpo = () => $('#dtCorpo');
  const marcarAba = (id) => ['dtAbaAgenda', 'dtAbaClientes', 'dtAbaMensagens'].forEach((a) => $('#' + a)?.classList.toggle('apr-aba-ativa', a === id));
  const carregando = () => { corpo().innerHTML = ''; corpo().append(el('div', { class: 'apr-vazio' }, 'Carregando…')); };

  // ─── Agenda ──────────────────────────────────────────────────────────
  async function mostrarAgenda() {
    marcarAba('dtAbaAgenda');
    carregando();
    let r;
    try { r = await api('/datas/agenda?dias=30'); } catch (e) { corpo().innerHTML = ''; corpo().append(el('div', { class: 'apr-vazio' }, 'Erro: ' + e.message)); return; }
    corretor = r.corretor || '';
    const c = corpo();
    c.innerHTML = '';
    if (r.totalContatos && r.semData) {
      c.append(el('div', { class: 'apr-alerta' },
        el('strong', {}, `${r.semData} de ${r.totalContatos} clientes sem data de nascimento. `),
        'Sem a data, o aniversário não aparece aqui. ',
        el('button', { class: 'apr-link', on: { click: mostrarClientes } }, 'Preencher na aba Clientes →')));
    } else if (!r.totalContatos) {
      c.append(el('div', { class: 'apr-alerta' }, el('strong', {}, 'Nenhum cliente ainda. '), 'Os aniversários aparecem aqui assim que você cadastrar contatos com data de nascimento.'));
    }
    const grupos = [
      ['Hoje', (e) => e.data === r.hoje],
      ['Próximos 7 dias', (e) => { const n = diffDias(r.hoje, e.data); return n >= 1 && n <= 7; }],
      ['Até 30 dias', (e) => diffDias(r.hoje, e.data) > 7],
    ];
    for (const [titulo, filtro] of grupos) {
      // Dia de profissão sem cliente daquela profissão fica só na aba Mensagens.
      const evs = r.eventos.filter((e) => !(e.tipo === 'profissao' && !e.contatos.length)).filter(filtro);
      c.append(el('h3', { class: 'dt-grupo' }, titulo, el('small', {}, evs.length ? ` · ${evs.length}` : '')));
      if (!evs.length) { c.append(el('p', { class: 'apr-ajuda' }, titulo === 'Hoje' ? 'Nada para hoje.' : 'Nada neste período.')); continue; }
      c.append(el('div', { class: 'dt-cartoes' }, evs.map((e) => cartao(e, r.hoje))));
    }
  }

  function cartao(e, hoje) {
    const t = TIPOS[e.tipo];
    const pessoas = e.tipo === 'comemorativa' ? 'Para todos os clientes'
      : e.tipo === 'profissao' ? (e.contatos.length ? e.contatos.map((x) => primeiroNome(x.nome)).slice(0, 3).join(', ') + (e.contatos.length > 3 ? ` +${e.contatos.length - 3}` : '') : 'Nenhum cliente com essa profissão')
      : e.contatos[0]?.telefone ? 'WhatsApp pronto' : 'Sem telefone cadastrado';
    return el('button', { class: 'dt-cartao' + (e.data === hoje ? ' dt-hoje' : ''), style: `--dt-cor:${t.cor}`, on: { click: () => abrirEvento(e) } },
      el('div', { class: 'dt-cartao-topo' }, el('span', { class: 'dt-icone' }, t.icone), el('span', { class: 'dt-tipo' }, t.rotulo), el('span', { class: 'dt-quando' }, rotuloData(e.data, hoje))),
      el('div', { class: 'dt-titulo' }, e.titulo),
      el('div', { class: 'dt-desc' }, e.descricao),
      el('div', { class: 'dt-pessoas' }, pessoas));
  }

  // ─── Janela do evento: mensagens + destinatários ─────────────────────
  function abrirEvento(e) {
    const t = TIPOS[e.tipo];
    let escolhida = 0;
    let destino = e.contatos.length === 1 ? e.contatos[0] : null;
    const fundo = el('div', { class: 'dt-fundo', on: { click: (ev) => { if (ev.target === fundo) fechar(); } } });
    const fechar = () => { fundo.remove(); document.removeEventListener('keydown', esc); };
    const esc = (ev) => { if (ev.key === 'Escape') fechar(); };
    document.addEventListener('keydown', esc);

    const area = el('textarea', { class: 'dt-texto', rows: 6 });
    const pintarTexto = () => { area.value = preencher(e.mensagens[escolhida], destino?.nome, corretor); };
    const opcoes = el('div', { class: 'dt-opcoes' }, e.mensagens.map((_, i) => el('button', {
      class: 'dt-opcao' + (i === 0 ? ' ativa' : ''),
      on: { click: (ev) => { escolhida = i; $$('.dt-opcao', opcoes).forEach((b) => b.classList.remove('ativa')); ev.currentTarget.classList.add('ativa'); pintarTexto(); } },
    }, `Opção ${i + 1}`)));
    pintarTexto();

    const btnCopiar = el('button', { class: 'apr-btn-sec', on: { click: (ev) => copiar(area.value, ev.currentTarget) } }, 'Copiar mensagem');
    const btnWhats = el('a', { class: 'apr-btn dt-whats', target: '_blank', rel: 'noopener', on: { click: () => { btnWhats.href = linkWhats(destino?.telefone, area.value); } } }, 'Abrir no WhatsApp');
    const rotuloDestino = el('div', { class: 'dt-destino' });
    const pintarDestino = () => {
      rotuloDestino.textContent = destino ? `Para: ${destino.nome}${destino.telefone ? ' · ' + destino.telefone : ' · sem telefone (o WhatsApp vai pedir o contato)'}` : 'Para: escolha um cliente abaixo, ou copie a mensagem sem nome.';
      btnWhats.href = linkWhats(destino?.telefone, area.value);
    };
    pintarDestino();

    let listaDest = null;
    if (e.contatos.length > 1 || e.geral) {
      const busca = el('input', { type: 'search', placeholder: 'Buscar cliente…', class: 'dt-busca' });
      const ul = el('div', { class: 'dt-lista' });
      const pintarLista = () => {
        const q = busca.value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        ul.innerHTML = '';
        const itens = e.contatos.filter((x) => !q || x.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(q)).slice(0, 200);
        if (!itens.length) ul.append(el('p', { class: 'apr-ajuda' }, 'Nenhum cliente.'));
        for (const x of itens) {
          ul.append(el('div', { class: 'dt-pessoa' + (destino?.id === x.id ? ' ativa' : '') },
            el('button', { class: 'dt-pessoa-nome', on: { click: () => { destino = x; pintarTexto(); pintarDestino(); pintarLista(); } } }, x.nome, el('small', {}, x.telefone || 'sem telefone')),
            el('a', { class: 'dt-mini-whats', target: '_blank', rel: 'noopener', title: 'Abrir no WhatsApp com a mensagem para este cliente',
              href: linkWhats(x.telefone, preencher(e.mensagens[escolhida], x.nome, corretor)),
              on: { click: (ev) => { ev.currentTarget.href = linkWhats(x.telefone, preencher(e.mensagens[escolhida], x.nome, corretor)); destino = x; pintarTexto(); pintarDestino(); } } }, 'WhatsApp')));
        }
      };
      busca.addEventListener('input', pintarLista);
      pintarLista();
      listaDest = el('div', { class: 'dt-dest' }, el('h4', {}, e.tipo === 'profissao' ? 'Clientes com essa profissão' : 'Enviar para'), busca, ul);
    }

    area.addEventListener('input', () => { btnWhats.href = linkWhats(destino?.telefone, area.value); });

    fundo.append(el('div', { class: 'dt-janela', role: 'dialog' },
      el('div', { class: 'dt-janela-topo', style: `--dt-cor:${t.cor}` },
        el('div', {}, el('div', { class: 'dt-tipo' }, `${t.icone} ${t.rotulo}`), el('h3', {}, e.titulo), el('p', {}, e.descricao)),
        el('button', { class: 'dt-fechar', title: 'Fechar', on: { click: fechar } }, '×')),
      el('div', { class: 'dt-janela-corpo' },
        el('div', { class: 'dt-msg' },
          opcoes, area,
          el('p', { class: 'apr-ajuda' }, 'Pode editar o texto antes de enviar.'),
          rotuloDestino,
          el('div', { class: 'dt-botoes' }, btnCopiar, btnWhats)),
        listaDest)));
    document.body.append(fundo);
  }

  // ─── Biblioteca ──────────────────────────────────────────────────────
  async function mostrarBiblioteca() {
    marcarAba('dtAbaMensagens');
    carregando();
    let r, contatos = [];
    try {
      [r, contatos] = await Promise.all([api('/datas/biblioteca'), api('/datas/clientes').then((x) => x.clientes)]);
    } catch (e) { corpo().innerHTML = ''; corpo().append(el('div', { class: 'apr-vazio' }, 'Erro: ' + e.message)); return; }
    corretor = r.corretor || corretor;
    const c = corpo();
    c.innerHTML = '';
    c.append(el('p', { class: 'apr-ajuda' }, `Todas as datas de ${r.ano} com mensagens prontas. Clique para abrir, escolher o cliente e enviar.`));
    const hoje = new Date().toISOString().slice(0, 10);
    const porMes = new Map();
    for (const d of r.datas) {
      const chave = d.data ? MESES[Number(d.data.slice(5, 7)) - 1] : 'Modelos';
      porMes.set(chave, [...(porMes.get(chave) || []), d]);
    }
    for (const [mes, itens] of porMes) {
      c.append(el('h3', { class: 'dt-grupo' }, mes));
      c.append(el('div', { class: 'dt-cartoes' }, itens.map((d) => {
        const ev = { ...d, id: d.chave, contatos: contatos.map((x) => ({ id: x.id, nome: x.nome, telefone: x.telefone })), geral: true };
        const cart = cartao(ev, hoje);
        $('.dt-quando', cart).textContent = d.data ? `${d.data.slice(8, 10)}/${d.data.slice(5, 7)}` : '';
        $('.dt-pessoas', cart).textContent = `${d.mensagens.length} ${d.mensagens.length === 1 ? 'mensagem' : 'mensagens'}`;
        return cart;
      })));
    }
  }

  // ─── Clientes: nascimento, profissão, apólices ───────────────────────
  async function mostrarClientes(busca = '') {
    marcarAba('dtAbaClientes');
    carregando();
    let r;
    try { r = await api('/datas/clientes' + (busca ? `?busca=${encodeURIComponent(busca)}` : '')); }
    catch (e) { corpo().innerHTML = ''; corpo().append(el('div', { class: 'apr-vazio' }, 'Erro: ' + e.message)); return; }
    const c = corpo();
    c.innerHTML = '';
    const lista = el('datalist', { id: 'dtProfissoes' }, r.profissoes.map((p) => el('option', { value: p })));
    let timer;
    const campoBusca = el('input', { type: 'search', class: 'dt-busca', placeholder: 'Buscar cliente por nome ou telefone…', value: busca,
      on: { input: () => { clearTimeout(timer); timer = setTimeout(() => mostrarClientes(campoBusca.value.trim()), 400); } } });
    c.append(lista,
      el('p', { class: 'apr-ajuda' }, 'Preencha a data de nascimento, a profissão e as apólices. Salva sozinho quando você sai do campo. Os clientes vêm dos Contatos do CRM.'),
      campoBusca);
    if (!r.clientes.length) { c.append(el('div', { class: 'apr-vazio' }, busca ? 'Nenhum cliente encontrado.' : 'Nenhum contato no CRM ainda.')); return; }

    const tabela = el('div', { class: 'dt-tabela' });
    for (const cl of r.clientes) tabela.append(linhaCliente(cl));
    c.append(tabela);
    setTimeout(() => campoBusca.focus(), 0);
  }

  function linhaCliente(cl) {
    const reconhecida = el('small', { class: 'dt-reconhecida' });
    const pintarRec = (nome) => { reconhecida.textContent = nome ? `✓ ${nome}` : (cl.profissao ? 'sem dia da profissão' : ''); };
    pintarRec(cl.profissaoReconhecida);
    const salvar = async (patch) => {
      try { const r = await api(`/datas/clientes/${cl.id}`, { method: 'PUT', body: patch }); pintarRec(r.profissaoReconhecida); atualizarBadge(); }
      catch (e) { aviso(e.message, 'error'); }
    };
    const nasc = el('input', { type: 'date', value: cl.nascimento || '', on: { change: () => salvar({ nascimento: nasc.value }) } });
    const prof = el('input', { type: 'text', list: 'dtProfissoes', placeholder: 'Profissão', value: cl.profissao || '', on: { change: () => salvar({ profissao: prof.value }) } });

    const apol = el('div', { class: 'dt-apolices' });
    const pintarApolices = () => {
      apol.innerHTML = '';
      for (const a of cl.apolices) {
        apol.append(el('span', { class: 'dt-chip' }, `🛡️ ${a.nome} · ${a.inicio.split('-').reverse().join('/')}`,
          el('button', { title: 'Tirar', on: { click: async () => {
            try { await api(`/datas/apolices/${a.id}`, { method: 'DELETE' }); cl.apolices = cl.apolices.filter((x) => x.id !== a.id); pintarApolices(); }
            catch (e) { aviso(e.message, 'error'); }
          } } }, '×')));
      }
      const nome = el('input', { type: 'text', placeholder: 'Apólice (ex.: Vida MetLife)' });
      const inicio = el('input', { type: 'date', title: 'Início da apólice' });
      apol.append(el('div', { class: 'dt-nova-apolice' }, nome, inicio,
        el('button', { class: 'apr-btn-sec', on: { click: async () => {
          if (!inicio.value) return aviso('Informe a data de início da apólice.', 'error');
          try {
            const r = await api(`/datas/clientes/${cl.id}/apolices`, { method: 'POST', body: { nome: nome.value, inicio: inicio.value } });
            cl.apolices.push({ id: r.id, nome: nome.value || 'Apólice', inicio: inicio.value });
            pintarApolices(); atualizarBadge();
          } catch (e) { aviso(e.message, 'error'); }
        } } }, '+ Apólice')));
    };
    pintarApolices();

    return el('div', { class: 'dt-cliente' },
      el('div', { class: 'dt-cliente-nome' }, cl.nome, el('small', {}, cl.telefone || 'sem telefone')),
      el('label', { class: 'apr-campo' }, el('span', {}, 'Nascimento'), nasc),
      el('label', { class: 'apr-campo' }, el('span', {}, 'Profissão'), prof, reconhecida),
      el('div', { class: 'dt-cliente-apol' }, el('span', { class: 'apr-rotulo' }, 'Apólices'), apol));
  }

  function iniciar() {
    if (!$('.sidebar nav') || !$('.main')) return setTimeout(iniciar, 300);
    // Espera o item da Apresentação para ficar logo abaixo dele.
    if (!$('.nav-item[data-view="apresentacao"]') && (iniciar.t = (iniciar.t || 0) + 1) < 10) return setTimeout(iniciar, 200);
    montar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
