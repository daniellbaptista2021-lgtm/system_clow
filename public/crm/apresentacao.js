/* ═══════════════════════════════════════════════════════════════════════
 * CRM Pulse — Apresentação MetLife
 *
 * O corretor preenche o perfil uma vez (nome, SUSEP, foto, logo da
 * corretora) e, para cada cliente, poucos números + a cotação. O servidor
 * faz as contas (src/crm/apresentacao/calculos.ts) e monta o PDF no modelo
 * da equipe — esta tela não calcula nada, só pede a prévia ao servidor,
 * para a conta nunca existir em dois lugares.
 *
 * Mesmo molde do mcp-panel.js: injeta o item de menu e a view sozinho.
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
    if (opts.body && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(`/v1/crm${path}`, { ...opts, headers });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  }
  const aviso = (msg, tipo) => (window.toast ? window.toast(msg, tipo) : alert(msg));
  const confirmar = (msg, opts) => (window.clowConfirm ? window.clowConfirm(msg, opts) : Promise.resolve(confirm(msg)));

  // ─── Dinheiro em pt-BR ───────────────────────────────────────────────
  const brl = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** Aceita "35.000,00", "35000", "R$ 35.000" e "35000.5". */
  function lerValor(s) {
    if (typeof s === 'number') return s;
    let t = String(s || '').replace(/[R$\s]/g, '');
    if (!t) return 0;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else if ((t.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  const mostrarValor = (v) => (v ? (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

  // ─── Imagens: reduz no navegador antes de enviar ─────────────────────
  function lerArquivo(file) {
    return new Promise((ok, erro) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result);
      fr.onerror = () => erro(new Error('Não consegui ler o arquivo.'));
      fr.readAsDataURL(file);
    });
  }
  async function reduzirImagem(file, max, tipo) {
    const url = await lerArquivo(file);
    const img = await new Promise((ok, erro) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => erro(new Error('Esse arquivo não é uma imagem que o navegador consegue abrir.'));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * k);
    cv.height = Math.round(img.height * k);
    const ctx = cv.getContext('2d');
    if (tipo === 'image/jpeg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height); }
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL(tipo, 0.9);
  }

  // ─── Estado ──────────────────────────────────────────────────────────
  let coberturas = [];
  let editando = null; // { id, dados, cotacao }
  let previaTimer = null;
  let ultimoCalculo = null;   // último retorno de /apresentacao/calcular
  let camposAuto = [];        // campos que mostram o valor calculado

  const dadosVazios = () => ({
    cliente: { nome: '', idade: '', rendaFamiliar: 0, despesaMensal: 0, idadeAposentadoria: 65 },
    filhos: [],
    educacaoPercentual: 23, educacaoAteIdade: 22,
    patrimonio: { imoveis: 0, veiculos: 0, financeiro: 0 },
    inventarioPercentual: 11,
    garantias: { aplicacaoPercentual: 1, mesesAfastamento: 24 },
    proposta: { linhas: [], investimentoMensal: 0, investimentoAnual: 0, capitalDisponibilizado: 0 },
    paginas: {},
  });

  // ─── Menu e view ─────────────────────────────────────────────────────
  function montar() {
    const nav = $('.sidebar nav');
    if (!nav || $('#apresentacaoView')) return;
    const icone = el('span', { class: 'nav-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 12l3-3 2 2 4-4"/></svg>' });
    const item = el('button', { class: 'nav-item', data: { view: 'apresentacao' } }, icone, el('span', { class: 'nav-label' }, 'Apresentação'));
    const pipeline = $('.nav-item[data-view="kanban"]', nav);
    if (pipeline && pipeline.nextSibling) nav.insertBefore(item, pipeline.nextSibling); else nav.append(item);

    $('.main').append(
      el('div', { class: 'view', data: { view: 'apresentacao' }, id: 'apresentacaoView' },
        el('header', { class: 'top-bar' },
          el('div', { class: 'top-bar-left' }, el('h2', {}, 'Apresentação')),
          el('div', { class: 'apr-abas' },
            el('button', { class: 'secondary', id: 'aprAbaLista', on: { click: () => mostrarLista() } }, 'Minhas apresentações'),
            el('button', { class: 'secondary', id: 'aprAbaPerfil', on: { click: () => mostrarPerfil() } }, 'Meu perfil'),
            el('button', { id: 'aprNova', on: { click: () => abrirEditor(null) } }, '+ Nova apresentação'),
          ),
        ),
        el('div', { id: 'aprCorpo', class: 'apr-corpo' }),
      ),
    );

    $$('.nav-item').forEach((n) => {
      if (n.dataset._aprWired) return;
      n.dataset._aprWired = '1';
      n.addEventListener('click', () => { if (n.dataset.view === 'apresentacao') mostrar(); });
    });
  }

  function mostrar() {
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === 'apresentacao'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'apresentacao'));
    if (!editando) mostrarLista();
  }

  const corpo = () => $('#aprCorpo');
  const marcarAba = (id) => ['aprAbaLista', 'aprAbaPerfil'].forEach((a) => $('#' + a)?.classList.toggle('apr-aba-ativa', a === id));

  // ─── Lista ───────────────────────────────────────────────────────────
  async function mostrarLista() {
    editando = null;
    marcarAba('aprAbaLista');
    const c = corpo();
    c.innerHTML = '';
    c.append(el('div', { class: 'apr-vazio' }, 'Carregando…'));
    let r, perfil;
    try { [r, perfil] = await Promise.all([api('/apresentacoes'), api('/apresentacao/perfil')]); }
    catch (e) { c.innerHTML = ''; c.append(el('div', { class: 'apr-vazio' }, 'Erro: ' + e.message)); return; }
    c.innerHTML = '';
    const p = perfil.perfil;
    if (!p.foto || !p.susep) {
      c.append(el('div', { class: 'apr-alerta' },
        el('strong', {}, 'Complete seu perfil primeiro. '),
        'A capa e a última página da apresentação usam sua foto, seu nome, telefone e SUSEP. ',
        el('button', { class: 'apr-link', on: { click: mostrarPerfil } }, 'Abrir meu perfil →')));
    }
    if (!r.apresentacoes.length) {
      c.append(el('div', { class: 'apr-vazio' },
        el('p', {}, 'Nenhuma apresentação ainda.'),
        el('button', { class: 'apr-btn', on: { click: () => abrirEditor(null) } }, '+ Criar a primeira')));
      return;
    }
    const lista = el('div', { class: 'apr-lista' });
    for (const a of r.apresentacoes) {
      lista.append(el('div', { class: 'apr-item' },
        el('div', { class: 'apr-item-info' },
          el('div', { class: 'apr-item-nome' }, a.clienteNome),
          el('div', { class: 'apr-item-sub' }, 'Atualizada em ' + new Date(a.atualizadaEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + (a.cotacao ? ' · com cotação' : ' · sem cotação')),
        ),
        el('div', { class: 'apr-item-acoes' },
          el('button', { class: 'apr-btn', on: { click: () => baixar(a.id, a.clienteNome) } }, 'Baixar PDF'),
          el('button', { class: 'apr-btn-sec', on: { click: () => abrirEditor(a.id) } }, 'Editar'),
          el('button', { class: 'apr-btn-perigo', title: 'Apagar', on: { click: async () => {
            if (!(await confirmar(`Apagar a apresentação de ${a.clienteNome}?`, { danger: true, confirmLabel: 'Apagar' }))) return;
            try { await api(`/apresentacoes/${a.id}`, { method: 'DELETE' }); mostrarLista(); } catch (e) { aviso(e.message, 'error'); }
          } } }, 'Apagar'),
        ),
      ));
    }
    c.append(lista);
  }

  async function baixar(id, nome, botao) {
    const original = botao?.textContent;
    if (botao) { botao.disabled = true; botao.textContent = 'Montando o PDF…'; }
    try {
      const r = await fetch(`/v1/crm/apresentacoes/${id}/pdf`, { headers: { Authorization: `Bearer ${apiKey()}` } });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.message || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `Apresentacao - ${nome}.pdf` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      aviso('PDF baixado', 'success');
    } catch (e) {
      aviso('Erro ao gerar o PDF: ' + e.message, 'error');
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = original; }
    }
  }

  // ─── Perfil ──────────────────────────────────────────────────────────
  async function mostrarPerfil() {
    editando = null;
    marcarAba('aprAbaPerfil');
    const c = corpo();
    c.innerHTML = '';
    let p;
    try { p = (await api('/apresentacao/perfil')).perfil; } catch (e) { c.append(el('div', { class: 'apr-vazio' }, 'Erro: ' + e.message)); return; }
    const mudancas = {};
    const campo = (rot, nome, ph) => el('label', { class: 'apr-campo' }, el('span', {}, rot),
      el('input', { type: 'text', name: nome, value: p[nome] || '', placeholder: ph || '' }));
    const imagem = (rot, nome, dica, tipo, max) => {
      const prev = el('div', { class: 'apr-img ' + (nome === 'foto' ? 'apr-img-foto' : '') });
      const pintar = (url) => { prev.innerHTML = ''; prev.append(url ? el('img', { src: url, alt: rot }) : el('span', {}, 'Sem ' + rot.toLowerCase())); };
      pintar(p[nome]);
      const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none', on: { change: async () => {
        const f = input.files[0]; if (!f) return;
        try { const url = await reduzirImagem(f, max, tipo); mudancas[nome] = url; pintar(url); }
        catch (e) { aviso(e.message, 'error'); }
      } } });
      return el('div', { class: 'apr-campo-img' },
        el('span', { class: 'apr-rotulo' }, rot), prev, input,
        el('div', { class: 'apr-img-acoes' },
          el('button', { class: 'apr-btn-sec', on: { click: () => input.click() } }, 'Escolher'),
          el('button', { class: 'apr-btn-perigo', on: { click: () => { mudancas[nome] = null; pintar(null); } } }, 'Tirar')),
        el('small', {}, dica));
    };
    const form = el('div', { class: 'apr-cartao' },
      el('h3', {}, 'Meu perfil de corretor'),
      el('p', { class: 'apr-ajuda' }, 'Aparece na capa e na página "Muito obrigado" de todas as suas apresentações.'),
      el('div', { class: 'apr-grade' },
        campo('Nome completo', 'nome', 'Ex.: Bruno Herradon'),
        campo('Cargo', 'cargo', 'Consultor em proteção financeira'),
        campo('Telefone', 'telefone', '(11) 98860-4372'),
        campo('E-mail', 'email', 'voce@email.com'),
        campo('SUSEP', 'susep', 'Número da sua SUSEP'),
      ),
      el('div', { class: 'apr-grade apr-grade-img' },
        imagem('Foto', 'foto', 'Foto de rosto, de frente. Ela vai num círculo.', 'image/jpeg', 900),
        imagem('Logo da corretora', 'logo', 'PNG com fundo transparente fica melhor.', 'image/png', 700),
      ),
      el('div', { class: 'apr-rodape' },
        el('button', { class: 'apr-btn', on: { click: async (ev) => {
          const b = ev.currentTarget; b.disabled = true;
          const body = { ...mudancas };
          for (const i of $$('input[type=text]', form)) body[i.name] = i.value;
          try { await api('/apresentacao/perfil', { method: 'PUT', body }); aviso('Perfil salvo', 'success'); }
          catch (e) { aviso(e.message, 'error'); }
          b.disabled = false;
        } } }, 'Salvar perfil')),
    );
    c.append(form);
  }

  // ─── Editor ──────────────────────────────────────────────────────────
  async function abrirEditor(id) {
    marcarAba(null);
    const c = corpo();
    c.innerHTML = '';
    c.append(el('div', { class: 'apr-vazio' }, 'Carregando…'));
    try {
      if (!coberturas.length) coberturas = (await api('/apresentacao/coberturas')).coberturas;
      if (id) {
        const r = await api(`/apresentacoes/${id}`);
        editando = { id, dados: { ...dadosVazios(), ...r.dados }, cotacao: r.cotacao };
      } else {
        editando = { id: null, dados: dadosVazios(), cotacao: null };
      }
    } catch (e) { c.innerHTML = ''; c.append(el('div', { class: 'apr-vazio' }, 'Erro: ' + e.message)); return; }
    desenharEditor();
  }

  function desenharEditor() {
    camposAuto = [];
    ultimoCalculo = null;
    const d = editando.dados;
    const c = corpo();
    c.innerHTML = '';

    const num = (rot, obj, chave, opts = {}) => {
      const dinheiro = opts.dinheiro !== false;
      // Campo automático: vazio no dado, mostra o valor calculado (classe
      // apr-auto) até o corretor digitar o dele.
      const autoVal = () => (opts.auto && !Number(obj[chave]) && ultimoCalculo ? mostrarValor(ultimoCalculo[chave]) : '');
      const i = el('input', {
        type: 'text', inputmode: 'decimal', placeholder: opts.ph || (dinheiro ? '0,00' : ''),
        value: dinheiro ? (mostrarValor(obj[chave]) || autoVal()) : (obj[chave] ?? ''),
        on: {
          focus: () => { if (opts.auto && i.classList.contains('apr-auto')) { i.value = ''; i.classList.remove('apr-auto'); } },
          input: () => { obj[chave] = dinheiro ? lerValor(i.value) : (i.value === '' ? '' : Number(i.value)); agendarPrevia(); },
          blur: () => { if (dinheiro) i.value = mostrarValor(obj[chave]); if (opts.auto) pintarAuto(); },
        },
      });
      const pintarAuto = () => {
        if (document.activeElement === i || Number(obj[chave])) { i.classList.remove('apr-auto'); return; }
        i.value = autoVal(); i.classList.toggle('apr-auto', !!i.value);
      };
      if (opts.auto) { camposAuto.push(pintarAuto); pintarAuto(); }
      return el('label', { class: 'apr-campo' + (opts.curto ? ' apr-curto' : '') }, el('span', {}, rot), dinheiro ? el('div', { class: 'apr-moeda' }, el('em', {}, 'R$'), i) : i);
    };
    const texto = (rot, obj, chave, ph) => {
      const i = el('input', { type: 'text', value: obj[chave] || '', placeholder: ph || '', on: { input: () => { obj[chave] = i.value; agendarPrevia(); } } });
      return el('label', { class: 'apr-campo' }, el('span', {}, rot), i);
    };
    const secao = (n, titulo, ajuda, ...kids) => el('section', { class: 'apr-cartao' },
      el('h3', {}, el('b', { class: 'apr-num' }, String(n)), titulo), ajuda ? el('p', { class: 'apr-ajuda' }, ajuda) : null, ...kids);

    // 1. Cliente
    const nomeCliente = texto('Nome do cliente', d.cliente, 'nome', 'Ex.: Milena Yoko Nakamura');
    const lista = el('datalist', { id: 'aprContatos' });
    nomeCliente.querySelector('input').setAttribute('list', 'aprContatos');
    api('/contacts?limit=500').then((r) => { for (const ct of (r.contacts || [])) if (ct.name) lista.append(el('option', { value: ct.name })); }).catch(() => {});
    const s1 = secao(1, 'Cliente', 'Comece a digitar e escolha um contato do CRM, ou escreva o nome.',
      el('div', { class: 'apr-grade' }, nomeCliente, lista,
        num('Idade', d.cliente, 'idade', { dinheiro: false, curto: true, ph: '37' }),
        num('Renda familiar (mês)', d.cliente, 'rendaFamiliar'),
        num('Despesa mensal da família', d.cliente, 'despesaMensal'),
        num('Aposentadoria aos', d.cliente, 'idadeAposentadoria', { dinheiro: false, curto: true, ph: '65' })));

    // 2. Filhos
    const filhosBox = el('div', { class: 'apr-linhas' });
    const desenharFilhos = () => {
      filhosBox.innerHTML = '';
      d.filhos.forEach((f, i) => filhosBox.append(el('div', { class: 'apr-linha apr-linha-filho' },
        texto('Nome', f, 'nome', 'Nome do filho(a)'),
        num('Idade', f, 'idade', { dinheiro: false, curto: true }),
        el('button', { class: 'apr-x', title: 'Tirar', on: { click: () => { d.filhos.splice(i, 1); desenharFilhos(); agendarPrevia(); } } }, '×'))));
      if (!d.filhos.length) filhosBox.append(el('p', { class: 'apr-ajuda' }, 'Sem filhos: a página de educação não entra.'));
    };
    desenharFilhos();
    const s2 = secao(2, 'Filhos', 'Custo de criação e educação até os 22 anos, como fatia da despesa da família.',
      filhosBox,
      el('button', { class: 'apr-btn-sec', on: { click: () => { d.filhos.push({ nome: '', idade: '' }); desenharFilhos(); } } }, '+ Adicionar filho(a)'),
      el('div', { class: 'apr-grade apr-mt' },
        num('% da despesa por filho', d, 'educacaoPercentual', { dinheiro: false, curto: true }),
        num('Até a idade de', d, 'educacaoAteIdade', { dinheiro: false, curto: true })));

    // 3. Patrimônio
    const s3 = secao(3, 'Patrimônio', 'Para o custo de inventário (planejamento sucessório). Tudo zerado: a página não entra.',
      el('div', { class: 'apr-grade' },
        num('Imóveis', d.patrimonio, 'imoveis'), num('Veículos', d.patrimonio, 'veiculos'), num('Financeiro', d.patrimonio, 'financeiro'),
        num('Custo do inventário (%)', d, 'inventarioPercentual', { dinheiro: false, curto: true })));

    // 4. Cotação
    const cotBox = el('div', { class: 'apr-cotacao' });
    const desenharCotacao = () => {
      cotBox.innerHTML = '';
      const input = el('input', { type: 'file', accept: 'application/pdf,image/*', style: 'display:none', on: { change: () => subirCotacao(input.files[0]) } });
      if (editando.cotacao) {
        cotBox.append(el('div', { class: 'apr-arquivo' }, '📎 ', el('b', {}, editando.cotacao.nome),
          el('button', { class: 'apr-btn-sec', on: { click: () => input.click() } }, 'Trocar'),
          el('button', { class: 'apr-btn-perigo', on: { click: async () => {
            try { await api(`/apresentacoes/${editando.id}/cotacao`, { method: 'DELETE' }); editando.cotacao = null; desenharCotacao(); } catch (e) { aviso(e.message, 'error'); }
          } } }, 'Tirar')), input);
      } else {
        cotBox.append(el('button', { class: 'apr-solta', on: { click: () => input.click() } },
          el('b', {}, 'Subir a cotação'), el('span', {}, 'PDF ou imagem (print). Entra logo depois da capa.')), input);
      }
    };
    async function subirCotacao(file) {
      if (!file) return;
      try {
        let arquivo;
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          arquivo = await lerArquivo(file);
          arquivo = arquivo.replace(/^data:[^;]*;/, 'data:application/pdf;');
        } else if (file.type === 'image/png' || file.type === 'image/jpeg') {
          arquivo = file.size > 6e6 ? await reduzirImagem(file, 2600, 'image/jpeg') : await lerArquivo(file);
        } else {
          arquivo = await reduzirImagem(file, 2600, 'image/jpeg'); // webp, heic etc.
        }
        if (!editando.id) await salvar(true);
        await api(`/apresentacoes/${editando.id}/cotacao`, { method: 'PUT', body: { nome: file.name, arquivo } });
        editando.cotacao = { nome: file.name };
        desenharCotacao();
        aviso('Cotação anexada', 'success');
      } catch (e) { aviso('Erro ao subir a cotação: ' + e.message, 'error'); }
    }
    desenharCotacao();
    const s4 = secao(4, 'Cotação', 'A cotação que você fez para o cliente.', cotBox);

    // 5. Proposta
    const linhasBox = el('div', { class: 'apr-linhas' });
    const desenharLinhas = () => {
      linhasBox.innerHTML = '';
      d.proposta.linhas.forEach((l, i) => {
        const sel = el('select', { on: { change: () => {
          const cat = coberturas.find((x) => x.chave === sel.value);
          l.cobertura = sel.value;
          if (cat && (!l.situacao || coberturas.some((x) => x.situacao === l.situacao))) l.situacao = cat.situacao;
          desenharLinhas(); agendarPrevia();
        } } }, coberturas.map((cb) => el('option', { value: cb.chave, selected: cb.chave === l.cobertura }, cb.nome)));
        const cat = coberturas.find((x) => x.chave === l.cobertura);
        linhasBox.append(el('div', { class: 'apr-linha apr-linha-prop' + (l.cobertura === 'outra' ? ' apr-outra' : ''), style: `border-left-color:${cat?.cor || '#999'}` },
          el('label', { class: 'apr-campo' }, el('span', {}, 'Cobertura'), sel),
          l.cobertura === 'outra' ? texto('Nome da cobertura', l, 'nome', 'Ex.: Seguro viagem') : null,
          texto('Situação', l, 'situacao'),
          num('Capital', l, 'capital'),
          texto('Período', l, 'periodo', 'até 72 anos'),
          num('Valor (mês)', l, 'valor'),
          el('button', { class: 'apr-x', title: 'Tirar', on: { click: () => { d.proposta.linhas.splice(i, 1); desenharLinhas(); agendarPrevia(); } } }, '×')));
      });
      if (!d.proposta.linhas.length) linhasBox.append(el('p', { class: 'apr-ajuda' }, 'Adicione as coberturas da proposta. As páginas de explicação da MetLife entram só para as coberturas que estiverem aqui.'));
    };
    desenharLinhas();
    const s5 = secao(5, 'Proposta (tabela "Proteção Financeira")', null,
      linhasBox,
      el('button', { class: 'apr-btn-sec', on: { click: () => {
        const usadas = new Set(d.proposta.linhas.map((l) => l.cobertura));
        const prox = coberturas.find((cb) => !usadas.has(cb.chave) && cb.chave !== 'outra') || coberturas[0];
        d.proposta.linhas.push({ cobertura: prox.chave, situacao: prox.situacao, capital: 0, periodo: '', valor: 0 });
        desenharLinhas();
      } } }, '+ Adicionar cobertura'),
      el('div', { class: 'apr-grade apr-mt' },
        num('Investimento mensal', d.proposta, 'investimentoMensal', { ph: 'soma automática dos valores', auto: true }),
        num('Investimento anual', d.proposta, 'investimentoAnual', { ph: 'automático: 12× o mensal', auto: true }),
        num('Capital disponibilizado', d.proposta, 'capitalDisponibilizado', { ph: 'soma automática dos capitais', auto: true })),
      el('p', { class: 'apr-ajuda' }, 'Esses três se calculam sozinhos a partir das coberturas. Digite um valor só se quiser outro (ex.: o anual com desconto da cotação); apague para voltar ao automático.'));

    // 6. Páginas
    const paginas = [
      ['planejamento', 'Planejamento financeiro'], ['padraoVida', 'Padrão de vida'], ['filhos', 'Educação dos filhos'],
      ['aposentadoria', 'Aposentadoria precoce'], ['ausencia', 'Ausência prematura'], ['sucessorio', 'Planejamento sucessório'],
      ['garantias', 'Garantias em imprevistos'], ['protecao', 'Proteção financeira'], ['explicacoes', 'Explicação das coberturas (MetLife)'],
    ];
    d.paginas = d.paginas || {};
    const s6 = secao(6, 'Páginas', 'Desmarque o que não quiser mostrar para este cliente.',
      el('div', { class: 'apr-checks' }, paginas.map(([k, rot]) => {
        const cb = el('input', { type: 'checkbox', checked: d.paginas[k] !== false, on: { change: () => { d.paginas[k] = cb.checked; } } });
        return el('label', {}, cb, ' ', rot);
      })));

    const previa = el('aside', { class: 'apr-previa', id: 'aprPrevia' }, el('h3', {}, 'Resumo'), el('div', { id: 'aprPreviaCorpo' }, 'Preencha os dados do cliente.'));
    const btnGerar = el('button', { class: 'apr-btn apr-btn-grande', on: { click: async (ev) => {
      const b = ev.currentTarget;
      try { await salvar(true); await baixar(editando.id, d.cliente.nome || 'Cliente', b); } catch (e) { aviso(e.message, 'error'); }
    } } }, 'Gerar e baixar PDF');
    const btnSalvar = el('button', { class: 'apr-btn-sec', on: { click: () => salvar(false).catch((e) => aviso(e.message, 'error')) } }, 'Salvar');

    c.append(el('div', { class: 'apr-editor' },
      el('div', { class: 'apr-form' },
        el('button', { class: 'apr-link apr-voltar', on: { click: () => mostrarLista() } }, '← Minhas apresentações'),
        s1, s2, s3, s4, s5, s6),
      el('div', { class: 'apr-lateral' }, previa, el('div', { class: 'apr-acoes' }, btnGerar, btnSalvar))));
    atualizarPrevia();
  }

  async function salvar(silencioso) {
    const d = editando.dados;
    if (!String(d.cliente.nome || '').trim()) throw new Error('Digite o nome do cliente.');
    if (editando.id) await api(`/apresentacoes/${editando.id}`, { method: 'PUT', body: { dados: d } });
    else editando.id = (await api('/apresentacoes', { method: 'POST', body: { dados: d } })).id;
    if (!silencioso) aviso('Apresentação salva', 'success');
  }

  function agendarPrevia() {
    clearTimeout(previaTimer);
    previaTimer = setTimeout(atualizarPrevia, 350);
  }

  async function atualizarPrevia() {
    const alvo = $('#aprPreviaCorpo');
    if (!alvo || !editando) return;
    let r;
    try { r = (await api('/apresentacao/calcular', { method: 'POST', body: { dados: editando.dados } })).calculo; }
    catch { return; }
    ultimoCalculo = r;
    camposAuto.forEach((f) => f());
    const linha = (rot, v, destaque) => el('div', { class: 'apr-res' + (destaque ? ' apr-res-forte' : '') }, el('span', {}, rot), el('b', {}, v));
    alvo.innerHTML = '';
    alvo.append(
      linha('Padrão de vida', brl(r.responsabilidade)),
      el('small', {}, `${brl(r.despesa)} × 12 × ${r.anosProdutivos} anos`),
      linha('Educação dos filhos', brl(r.educacao.total)),
      linha('Inventário', brl(r.inventario)),
      el('small', {}, `${r.pctInventario}% de ${brl(r.totalPatrimonio)}`),
      linha('Gap financeiro', brl(r.garantias.gap)),
      linha('Capital necessário — invalidez', brl(r.garantias.necessarioInvalidez)),
      linha('Capital necessário — doença grave', brl(r.garantias.necessarioDoenca)),
      el('hr'),
      linha('Capital disponibilizado', brl(r.capitalDisponibilizado), true),
      linha('Investimento mensal', brl(r.investimentoMensal)),
      linha('Investimento anual', brl(r.investimentoAnual)),
      linha('Investimento diário', brl(r.investimentoDiario), true),
      el('small', {}, r.explicacoes.length ? `+ ${r.explicacoes.length} páginas de explicação da MetLife` : 'Sem páginas de explicação (nenhuma cobertura com explicação).'),
    );
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  function iniciar() {
    if (!$('.sidebar nav') || !$('.main')) return setTimeout(iniciar, 300);
    montar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
