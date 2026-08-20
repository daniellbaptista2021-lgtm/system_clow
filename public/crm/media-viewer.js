/**
 * media-viewer.js — visualizador de mídia da conversa, no espírito do WhatsApp.
 *
 * Antes, a foto da conversa era uma miniatura de 240px e ponto final: para ver
 * o que o cliente mandou, não havia o que fazer. Documento só baixava, mesmo
 * quando era um PDF que dava para ler ali mesmo.
 *
 * Uso:
 *   clowMediaViewer.abrir(itens, indice)
 *
 * `itens` é a lista de mídias da conversa aberta — assim as setas percorrem a
 * conversa inteira, como no WhatsApp, em vez de abrir uma foto isolada:
 *   { url, tipo: 'image'|'video'|'document', nome?, legenda?, quando? }
 *
 * O conteúdo é buscado com o token do CRM e vira blob local. Duas
 * consequências que valem saber: nada é servido publicamente (a mídia continua
 * atrás da autenticação) e o mesmo blob é reaproveitado quando a miniatura já
 * o carregou, então abrir uma foto já visível é instantâneo.
 */
(function () {
  if (window.clowMediaViewer) return; // idempotente

  var raiz = null;
  var itens = [];
  var atual = 0;
  var blobsProprios = [];

  /* Blob autenticado, com cache compartilhado com as miniaturas da conversa.
   * Sem isso, abrir a foto grande baixaria de novo o que já está na tela. */
  function urlDoBlob(url) {
    var cache = window._clowMediaBlobCache;
    if (cache && cache.has(url)) return Promise.resolve(cache.get(url));

    var base = window.API_BASE || '';
    var path = url.indexOf(base) === 0 ? url.slice(base.length) : url.replace(/^\/v1\/crm/, '');
    var token = (window.state && window.state.apiKey) || '';
    return fetch(base + path, { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var u = URL.createObjectURL(blob);
        if (cache) cache.set(url, u);
        else blobsProprios.push(u);
        return u;
      });
  }

  function montar() {
    if (raiz) return;
    raiz = document.createElement('div');
    raiz.className = 'mv-backdrop';
    raiz.setAttribute('role', 'dialog');
    raiz.setAttribute('aria-modal', 'true');
    raiz.setAttribute('aria-label', 'Visualizador de mídia');
    raiz.innerHTML =
      '<div class="mv-bar">' +
        '<div class="mv-info"><span class="mv-nome"></span><span class="mv-contador"></span></div>' +
        '<div class="mv-acoes">' +
          '<button type="button" class="mv-btn mv-baixar" title="Baixar" aria-label="Baixar">' +
            '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '</button>' +
          '<button type="button" class="mv-btn mv-fechar" title="Fechar (Esc)" aria-label="Fechar">' +
            '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="mv-nav mv-ant" aria-label="Anterior">' +
        '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
      '<button type="button" class="mv-nav mv-prox" aria-label="Próxima">' +
        '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
      '<div class="mv-palco"></div>' +
      '<div class="mv-legenda"></div>';
    document.body.appendChild(raiz);

    raiz.querySelector('.mv-fechar').addEventListener('click', fechar);
    raiz.querySelector('.mv-baixar').addEventListener('click', baixarAtual);
    raiz.querySelector('.mv-ant').addEventListener('click', function (e) { e.stopPropagation(); ir(-1); });
    raiz.querySelector('.mv-prox').addEventListener('click', function (e) { e.stopPropagation(); ir(1); });
    // Clicar no fundo fecha; clicar na mídia, não — senão sai sozinho ao
    // tentar dar play num vídeo.
    raiz.addEventListener('click', function (e) {
      if (e.target === raiz || e.target.classList.contains('mv-palco')) fechar();
    });

    // Arrastar para o lado troca de mídia, como no celular.
    var x0 = null;
    raiz.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    raiz.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var d = e.changedTouches[0].clientX - x0;
      if (Math.abs(d) > 60) ir(d < 0 ? 1 : -1);
      x0 = null;
    }, { passive: true });
  }

  function aoTeclar(e) {
    if (!raiz || !raiz.classList.contains('show')) return;
    if (e.key === 'Escape') { e.preventDefault(); fechar(); }
    else if (e.key === 'ArrowLeft') ir(-1);
    else if (e.key === 'ArrowRight') ir(1);
  }

  function ir(passo) {
    if (itens.length < 2) return;
    atual = (atual + passo + itens.length) % itens.length;
    render();
  }

  function baixarAtual() {
    var it = itens[atual];
    if (!it) return;
    urlDoBlob(it.url).then(function (u) {
      var a = document.createElement('a');
      a.href = u;
      a.download = it.nome || ('midia.' + (it.tipo === 'image' ? 'jpg' : it.tipo === 'video' ? 'mp4' : 'bin'));
      document.body.appendChild(a);
      a.click();
      a.remove();
    }).catch(function (err) {
      if (window.toast) window.toast('Erro ao baixar: ' + err.message, 'error');
    });
  }

  function render() {
    var it = itens[atual];
    if (!it) return;
    var palco = raiz.querySelector('.mv-palco');
    palco.innerHTML = '<div class="mv-carregando">Carregando…</div>';

    raiz.querySelector('.mv-nome').textContent = it.nome || '';
    raiz.querySelector('.mv-contador').textContent =
      itens.length > 1 ? (atual + 1) + ' de ' + itens.length : '';
    var leg = raiz.querySelector('.mv-legenda');
    leg.textContent = it.legenda || '';
    leg.style.display = it.legenda ? 'block' : 'none';

    var temVarias = itens.length > 1;
    raiz.querySelector('.mv-ant').style.display = temVarias ? 'flex' : 'none';
    raiz.querySelector('.mv-prox').style.display = temVarias ? 'flex' : 'none';

    var meu = atual; // se trocar de mídia antes de carregar, descarta o antigo
    urlDoBlob(it.url).then(function (u) {
      if (meu !== atual) return;
      palco.innerHTML = '';
      if (it.tipo === 'image') {
        var img = document.createElement('img');
        img.className = 'mv-img';
        img.alt = it.legenda || it.nome || 'Imagem da conversa';
        img.src = u;
        palco.appendChild(img);
      } else if (it.tipo === 'video') {
        var v = document.createElement('video');
        v.className = 'mv-video';
        v.controls = true;
        v.autoplay = true;
        v.src = u;
        palco.appendChild(v);
      } else {
        // PDF abre para leitura aqui mesmo; o resto o navegador não renderiza,
        // então o caminho honesto é oferecer o download.
        var ehPdf = /\.pdf$/i.test(it.nome || '') || it.mime === 'application/pdf';
        if (ehPdf) {
          var f = document.createElement('iframe');
          f.className = 'mv-pdf';
          f.src = u;
          f.title = it.nome || 'Documento';
          palco.appendChild(f);
        } else {
          var box = document.createElement('div');
          box.className = 'mv-arquivo';
          box.innerHTML =
            '<div class="mv-arquivo-icone">📄</div>' +
            '<div class="mv-arquivo-nome"></div>' +
            '<div class="mv-arquivo-dica">Este tipo de arquivo não abre no navegador.</div>';
          box.querySelector('.mv-arquivo-nome').textContent = it.nome || 'Documento';
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'mv-arquivo-baixar';
          b.textContent = 'Baixar arquivo';
          b.addEventListener('click', baixarAtual);
          box.appendChild(b);
          palco.appendChild(box);
        }
      }
    }).catch(function (err) {
      if (meu !== atual) return;
      palco.innerHTML = '<div class="mv-erro">Não foi possível carregar esta mídia.<br><small></small></div>';
      palco.querySelector('small').textContent = err.message;
    });
  }

  function fechar() {
    if (!raiz) return;
    raiz.classList.remove('show');
    document.removeEventListener('keydown', aoTeclar);
    document.body.style.overflow = '';
    // Parar o vídeo: sem isto o áudio continua tocando com o visualizador fechado.
    var v = raiz.querySelector('video');
    if (v) { try { v.pause(); } catch (e) {} }
    raiz.querySelector('.mv-palco').innerHTML = '';
    blobsProprios.forEach(function (u) { URL.revokeObjectURL(u); });
    blobsProprios = [];
  }

  window.clowMediaViewer = {
    abrir: function (lista, indice) {
      if (!lista || !lista.length) return;
      montar();
      itens = lista;
      atual = Math.max(0, Math.min(indice || 0, lista.length - 1));
      raiz.classList.add('show');
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', aoTeclar);
      render();
    },
    fechar: fechar,
  };
})();
