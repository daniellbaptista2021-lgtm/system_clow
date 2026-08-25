/* ═══════════════════════════════════════════════════════════════════════
 * CRM CLOW — painel MCP
 *
 * Tela de "conectar ferramentas externas": mostra o endpoint MCP, administra
 * as chaves de acesso e lista as ferramentas que um agente de fora enxerga.
 *
 * Carregado DEPOIS de crm.js, no mesmo molde de crm-extras.js: injeta o item
 * de menu e a view por conta própria, com handler de clique próprio. Assim
 * este arquivo não encosta em crm.js (344 KB) — a view nova é aditiva e some
 * inteira se o script não carregar, em vez de quebrar a navegação.
 * ═══════════════════════════════════════════════════════════════════════ */

(function () {
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

  const apiKey = () => localStorage.getItem('clow_crm_key') || '';
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

  const aviso = (msg, tipo) => (window.toast ? window.toast(msg, tipo) : console.log(msg));
  const confirmar = (msg, opts) =>
    window.clowConfirm ? window.clowConfirm(msg, opts) : Promise.resolve(confirm(msg));

  /** Copia texto e dá retorno visual no próprio botão. */
  async function copiar(texto, botao) {
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      // clipboard exige contexto seguro; em http:// o fallback é seleção
      // manual. Melhor um textarea temporário do que um erro silencioso.
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = texto;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* desistimos calados */ }
      ta.remove();
    }
    if (botao) {
      const antes = botao.textContent;
      botao.textContent = 'Copiado';
      setTimeout(() => { botao.textContent = antes; }, 1400);
    }
  }

  function bloco(titulo, ...filhos) {
    return el('section', {
      style: 'background:var(--bg-2);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px',
    },
      el('h3', { style: 'margin:0 0 4px;font-size:15px' }, titulo),
      ...filhos,
    );
  }

  function textoAuxiliar(txt) {
    return el('p', { style: 'margin:0 0 14px;color:var(--text-dim);font-size:13px;line-height:1.5' }, txt);
  }

  function caixaCodigo(texto, { rotulo } = {}) {
    const pre = el('pre', {
      style: 'margin:0;padding:12px 14px;background:var(--bg-3);border:1px solid var(--border);'
        + 'border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.6;white-space:pre;color:var(--text)',
    }, texto);
    const btn = el('button', {
      class: 'secondary',
      style: 'position:absolute;top:8px;right:8px;font-size:11px;padding:4px 10px',
      on: { click: (e) => copiar(texto, e.target) },
    }, 'Copiar');
    return el('div', { style: 'position:relative;margin-bottom:6px' },
      rotulo ? el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em' }, rotulo) : null,
      pre, btn,
    );
  }

  // ─── Injeção do menu + view ────────────────────────────────────────────
  function injetar() {
    const nav = $('.sidebar nav');
    if (!nav || nav.querySelector('[data-view="mcp"]')) return;

    const icone = el('span', {
      class: 'nav-icon',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
        + '<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
    });
    nav.append(
      el('button', { class: 'nav-item', data: { view: 'mcp' } },
        icone, el('span', { class: 'nav-label' }, 'MCP')),
    );

    $('.main').append(
      el('div', { class: 'view', data: { view: 'mcp' }, id: 'mcpView' },
        el('header', { class: 'top-bar' },
          el('div', { class: 'top-bar-left' }, el('h2', {}, 'MCP')),
        ),
        el('div', { id: 'mcpBody', style: 'padding:20px;max-width:900px' }),
      ),
    );

    $$('.nav-item').forEach((n) => {
      if (n.dataset._mcpWired) return;
      n.dataset._mcpWired = '1';
      n.addEventListener('click', () => {
        if (n.dataset.view === 'mcp') mostrar();
      });
    });
  }

  function mostrar() {
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === 'mcp'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'mcp'));
    renderizar();
  }

  // ─── Render ────────────────────────────────────────────────────────────
  async function renderizar() {
    const body = $('#mcpBody');
    if (!body) return;
    body.innerHTML = '';
    body.append(el('div', { class: 'empty' }, 'Carregando…'));

    let info;
    try {
      info = await api('/mcp/info');
    } catch (e) {
      body.innerHTML = '';
      body.append(el('div', { class: 'empty' }, 'Não deu pra carregar: ' + e.message));
      return;
    }

    body.innerHTML = '';
    body.append(
      textoAuxiliar(
        'O MCP deixa uma ferramenta de fora — Claude, um agente próprio, qualquer cliente que fale '
        + 'Model Context Protocol — operar este CRM: consultar o pipeline, criar cards, mandar WhatsApp. '
        + 'São ' + info.tools.length + ' ferramentas, as mesmas que o agente interno usa.',
      ),
      blocoEndpoint(info),
      blocoChaves(info),
      blocoComoConectar(info),
      blocoFerramentas(info),
    );
  }

  function blocoEndpoint(info) {
    return bloco('Endpoint',
      textoAuxiliar('É este o endereço que o cliente MCP precisa. O transporte é HTTP.'),
      caixaCodigo(info.endpoint),
    );
  }

  function blocoChaves(info) {
    const lista = el('div', { class: 'list', style: 'margin-bottom:12px' });

    if (!info.keys.length) {
      lista.append(el('div', { class: 'empty' }, 'Nenhuma chave ativa. Crie uma para conectar.'));
    } else {
      for (const k of info.keys) {
        // A chave que abriu esta tela não ganha botão de revogar: é a mesma
        // lista onde mora a chave da sessão do navegador, e revogá-la tranca
        // o dono para fora. O servidor recusa igual, isto aqui é só para o
        // clique não existir.
        const acao = k.emUso
          ? el('span', {
            style: 'font-size:11px;color:var(--text-dim);padding:5px 12px;border:1px dashed var(--border);border-radius:6px',
            title: 'É com esta chave que este navegador está conectado. Revogá-la tiraria seu acesso ao CRM.',
          }, 'em uso agora')
          : el('button', {
            class: 'secondary',
            style: 'font-size:11px;padding:5px 12px;color:#f87171',
            on: {
              click: async () => {
                const ok = await confirmar(
                  `Revogar "${k.name}"? Quem estiver usando essa chave perde o acesso na hora.`,
                  { title: 'Revogar chave', danger: true, confirmLabel: 'Revogar' },
                );
                if (!ok) return;
                try {
                  await api('/mcp/keys/' + k.id, { method: 'DELETE' });
                  aviso('Chave revogada', 'success');
                  renderizar();
                } catch (e) { aviso('Erro: ' + e.message, 'error'); }
              },
            },
          }, 'Revogar');

        lista.append(
          el('div', { class: 'list-item', style: 'cursor:default;justify-content:space-between;align-items:center' },
            el('div', {},
              el('div', { style: 'font-weight:600;font-size:13px' }, k.name),
              el('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:2px' },
                'criada ' + new Date(k.createdAt).toLocaleDateString('pt-BR')
                + (k.lastUsedAt
                  ? ' · último uso ' + new Date(k.lastUsedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
                  : ' · nunca usada')),
            ),
            acao,
          ),
        );
      }
    }

    const campoNome = el('input', {
      type: 'text',
      placeholder: 'Para que é essa chave? (ex: Claude do notebook)',
      style: 'flex:1;min-width:200px',
      maxlength: '60',
    });
    const btnCriar = el('button', {
      on: {
        click: async () => {
          btnCriar.disabled = true;
          try {
            const r = await api('/mcp/keys', { method: 'POST', body: { name: campoNome.value } });
            mostrarChaveNova(r);
            campoNome.value = '';
            renderizar();
          } catch (e) {
            aviso('Erro: ' + e.message, 'error');
          } finally {
            btnCriar.disabled = false;
          }
        },
      },
    }, '+ Criar chave');

    return bloco('Chaves de acesso',
      textoAuxiliar(
        'Cada ferramenta conectada usa uma chave. A chave aparece uma única vez, na hora em que é '
        + 'criada — depois disso fica só o resumo abaixo. Revogar corta o acesso imediatamente.',
      ),
      lista,
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, campoNome, btnCriar),
    );
  }

  /**
   * A chave em claro só existe neste instante — o servidor guarda o hash.
   * Por isso ela vai num modal que só sai por ação explícita, e NÃO fecha ao
   * clicar fora: um clique distraído no backdrop levaria o segredo embora sem
   * volta. O `openModal` de crm.js fecha no backdrop e nem é global (mora no
   * escopo do módulo), então o modal daqui é próprio de propósito.
   */
  function mostrarChaveNova(r) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const fechar = () => { backdrop.remove(); document.removeEventListener('keydown', aoTeclar); };
    function aoTeclar(e) { if (e.key === 'Escape') fechar(); }

    const modal = el('div', { class: 'modal', style: 'max-width:560px' },
      el('h3', { style: 'margin:0 0 10px' }, 'Chave criada'),
      el('p', { style: 'margin:0 0 12px;color:var(--text-dim);font-size:13px;line-height:1.5' },
        'Copie agora. Esta chave não vai ser mostrada de novo — se perder, crie outra e revogue esta.'),
      caixaCodigo(r.key),
      el('p', { style: 'margin:14px 0 16px;color:var(--text-dim);font-size:12px' },
        'Trate como senha: quem tiver essa chave opera o CRM inteiro.'),
      el('div', { style: 'display:flex;justify-content:flex-end;gap:8px' },
        el('button', { on: { click: fechar } }, 'Guardei'),
      ),
    );

    backdrop.append(modal);
    document.addEventListener('keydown', aoTeclar);
    document.body.append(backdrop);
  }

  function blocoComoConectar(info) {
    const url = info.endpoint;
    const cli = `claude mcp add --transport http system-clow ${url} \\\n  --header "Authorization: Bearer SUA_CHAVE"`;
    const json = JSON.stringify({
      mcpServers: {
        'system-clow': {
          type: 'http',
          url,
          headers: { Authorization: 'Bearer SUA_CHAVE' },
        },
      },
    }, null, 2);

    return bloco('Como conectar',
      textoAuxiliar('Troque SUA_CHAVE pela chave gerada acima.'),
      caixaCodigo(cli, { rotulo: 'Claude Code (terminal)' }),
      el('div', { style: 'height:12px' }),
      caixaCodigo(json, { rotulo: 'Outros clientes (arquivo de configuração)' }),
    );
  }

  function blocoFerramentas(info) {
    const grade = el('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px',
    });
    for (const t of info.tools) {
      grade.append(
        el('div', {
          style: 'padding:10px 12px;background:var(--bg-3);border:1px solid var(--border);border-radius:8px',
        },
          el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px' },
            el('code', { style: 'font-size:12px;font-weight:600;color:var(--text)' }, t.name),
            t.readOnly
              ? el('span', {
                style: 'font-size:9px;padding:1px 6px;border-radius:4px;background:var(--bg-2);'
                  + 'color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em',
              }, 'leitura')
              : null,
          ),
          el('div', { style: 'font-size:11px;color:var(--text-dim);line-height:1.4' }, t.description),
        ),
      );
    }
    return bloco(`Ferramentas expostas (${info.tools.length})`,
      textoAuxiliar('Isto é o que o agente externo enxerga e pode chamar.'),
      grade,
    );
  }

  // ─── Boot ──────────────────────────────────────────────────────────────
  function tentarBoot() {
    if (!apiKey() || $('#app')?.classList.contains('hide')) {
      setTimeout(tentarBoot, 500);
      return;
    }
    injetar();
  }
  document.addEventListener('DOMContentLoaded', tentarBoot);
  setTimeout(tentarBoot, 1500);
})();
