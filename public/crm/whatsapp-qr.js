/* ═══════════════════════════════════════════════════════════════════════
 * Conectar WhatsApp — leitura do QR Code
 *
 * O fluxo inteiro que o corretor percorre sozinho: abre, aponta o celular,
 * conecta. Sem painel de fornecedor, sem token para copiar.
 *
 * Duas coisas mandam no desenho desta tela:
 *
 *  1. **O QR expira em ~40 segundos.** Por isso ele é pedido de novo em ciclo,
 *     e não mostrado uma vez. Um QR vencido na tela é um QR que não lê — e o
 *     cliente conclui que o produto está quebrado, não que o código venceu.
 *  2. **Quem avisa que conectou é a consulta de estado**, não o clique do
 *     usuário. Ele aponta o celular e a tela muda sozinha; pedir "clique aqui
 *     depois de escanear" é transferir para ele um trabalho que é nosso.
 *
 * Exposto como window.PareamentoWhatsApp.abrir(canal, deps).
 * ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Ritmo do ciclo. O QR vence perto dos 40s, então renovamos antes disso; o
  // estado é consultado com frequência porque é ele que fecha a tela.
  const MS_RENOVAR_QR = 30000;
  const MS_CONSULTAR_ESTADO = 3000;
  // Teto da sessão. Sem isso, uma aba esquecida aberta ficaria batendo no
  // servidor a noite inteira.
  const MS_DESISTIR = 5 * 60 * 1000;

  function abrir(canal, deps) {
    const el = deps.el;
    const api = deps.api;
    const toast = deps.toast || (() => {});
    const aoConectar = deps.aoConectar || (() => {});

    let vivo = true;
    let timerQr = null;
    let timerEstado = null;
    const inicio = Date.now();

    const fundo = el('div', { class: 'modal-backdrop' });
    const area = el('div', {
      style: 'min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px',
    });

    function encerrar() {
      vivo = false;
      clearTimeout(timerQr);
      clearTimeout(timerEstado);
      fundo.remove();
    }

    function mostrar(...nos) {
      area.innerHTML = '';
      area.append(...nos.filter(Boolean));
    }

    function carregando(texto) {
      mostrar(
        el('div', {
          style:
            'width:38px;height:38px;border:3px solid rgba(225,6,0,.25);border-top-color:#e10600;' +
            'border-radius:50%;animation:qrSpin .9s linear infinite',
        }),
        el('div', { style: 'font-size:13px;color:var(--text-dim)' }, texto),
      );
    }

    function erro(mensagem) {
      mostrar(
        el('div', { style: 'font-size:30px' }, '⚠️'),
        el('div', { style: 'font-size:13px;color:var(--red);text-align:center;max-width:340px;line-height:1.5' }, mensagem),
        el('button', {
          class: 'save-btn',
          style: 'background:linear-gradient(135deg,#e10600,#ff1f18);color:#fff;padding:9px 18px;font-size:13px',
          on: { click: () => pedirQr() },
        }, 'Tentar de novo'),
      );
    }

    function conectado(numero) {
      mostrar(
        el('div', { style: 'font-size:38px' }, '✅'),
        el('div', { style: 'font-size:15px;font-weight:700' }, 'WhatsApp conectado'),
        numero
          ? el('div', { style: 'font-size:13px;color:var(--text-dim)' }, 'Número: ' + numero)
          : null,
        el('div', { style: 'font-size:12px;color:var(--text-dim);text-align:center;max-width:340px;line-height:1.5' },
          'As mensagens dos seus contatos já começam a aparecer no funil.'),
        el('button', {
          class: 'save-btn',
          style: 'background:linear-gradient(135deg,#e10600,#ff1f18);color:#fff;padding:10px 22px;font-size:13px;margin-top:4px',
          on: { click: () => { encerrar(); aoConectar(); } },
        }, 'Pronto'),
      );
      clearTimeout(timerQr);
      clearTimeout(timerEstado);
      toast('WhatsApp conectado', 'success');
    }

    function mostrarQr(imagem, codigo) {
      mostrar(
        el('div', { style: 'font-size:13px;color:var(--text-dim);text-align:center;line-height:1.6;max-width:360px' },
          'No celular: abra o WhatsApp → ',
          el('strong', {}, 'Aparelhos conectados'),
          ' → ',
          el('strong', {}, 'Conectar aparelho'),
          ' → aponte para o código.'),
        el('img', {
          src: imagem,
          alt: 'QR Code para conectar o WhatsApp',
          // Fundo branco porque o QR é preto sobre transparente: no tema
          // escuro, sem isto, ele fica preto no preto e não lê.
          style: 'width:250px;height:250px;background:#fff;padding:10px;border-radius:12px',
        }),
        codigo
          ? el('div', { style: 'font-size:12px;color:var(--text-dim);text-align:center' },
              'Ou digite o código: ', el('strong', { style: 'letter-spacing:2px' }, codigo))
          : null,
        el('div', { style: 'font-size:11px;color:var(--text-faint);text-align:center' },
          'O código se renova sozinho a cada 30 segundos.'),
      );
    }

    async function pedirQr() {
      if (!vivo) return;
      if (Date.now() - inicio > MS_DESISTIR) {
        erro('Tempo esgotado. Feche e abra de novo quando puder escanear.');
        return;
      }
      carregando('Preparando seu WhatsApp…');
      try {
        const r = await api(`/channels/${canal.id}/evolution-parear`, { method: 'POST' });
        if (!vivo) return;
        if (r.jaConectado) {
          conectado(r.numero);
          return;
        }
        if (!r.qr) {
          erro('Não recebi o código de conexão. Tente de novo em alguns segundos.');
          return;
        }
        mostrarQr(r.qr, r.codigoDeParear);
        clearTimeout(timerQr);
        timerQr = setTimeout(pedirQr, MS_RENOVAR_QR);
      } catch (e) {
        if (!vivo) return;
        erro(e.message || 'Falha ao preparar a conexão.');
      }
    }

    async function consultarEstado() {
      if (!vivo) return;
      try {
        const r = await api(`/channels/${canal.id}/evolution-estado`);
        if (!vivo) return;
        if (r.conectado) {
          conectado(r.numero);
          return;
        }
      } catch {
        // Falha de consulta não derruba a tela: o QR continua válido, e o
        // ciclo seguinte tenta de novo.
      }
      timerEstado = setTimeout(consultarEstado, MS_CONSULTAR_ESTADO);
    }

    if (!document.getElementById('qr-spin-style')) {
      const st = el('style', { id: 'qr-spin-style' });
      st.textContent = '@keyframes qrSpin{to{transform:rotate(360deg)}}';
      document.head.append(st);
    }

    fundo.append(
      el('div', { class: 'modal', style: 'max-width:460px' },
        el('h3', {}, 'Conectar WhatsApp'),
        area,
        el('div', { class: 'modal-actions' },
          el('button', { type: 'button', class: 'cancel', on: { click: encerrar } }, 'Fechar'),
        ),
      ),
    );
    fundo.addEventListener('click', (e) => { if (e.target === fundo) encerrar(); });
    document.body.append(fundo);

    pedirQr();
    consultarEstado();
  }

  window.PareamentoWhatsApp = { abrir };
})();
