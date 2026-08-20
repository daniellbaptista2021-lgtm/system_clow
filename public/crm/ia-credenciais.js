/* ═══════════════════════════════════════════════════════════════════════
 * Inteligência Artificial — a chave é do cliente (BYOK)
 *
 * O cartão que aparece em Configurações da conta. Aqui o cliente escolhe o
 * provedor, cola a chave dele e escolhe o modelo. Nada de chave do dono: sem
 * isto conectado, o agente daquele cliente não roda.
 *
 * Duas decisões de tela que valem explicação:
 *
 *  1. **Testar antes de salvar, sempre.** Chave errada salva vira agente mudo
 *     na frente de um lead real. O teste bate no provedor e não gasta token.
 *  2. **A chave nunca volta do servidor.** Depois de salva, o campo mostra só
 *     a máscara. Para trocar, digita a nova — não existe "ver minha chave",
 *     de propósito.
 *
 * Exposto como window.CartaoIA.montar(destino, deps) e chamado pelo
 * crm-settings-ext.js.
 * ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const BASE = '/v1/ia-credenciais';

  function chave() {
    return (
      localStorage.getItem('clow_crm_key') ||
      localStorage.getItem('clow_token') ||
      ''
    );
  }

  async function api(caminho, opcoes = {}) {
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + chave() };
    const corpo = opcoes.body && typeof opcoes.body !== 'string'
      ? JSON.stringify(opcoes.body)
      : opcoes.body;
    const r = await fetch(BASE + caminho, { ...opcoes, headers: h, body: corpo });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.erro || d.error || 'http_' + r.status);
    return d;
  }

  async function montar(destino, deps) {
    const el = deps.el;
    const toast = deps.toast || (() => {});

    const cartao = el('div', {
      style:
        'max-width:720px;margin:0 auto 20px;background:var(--bg-2);border:1px solid var(--border);border-radius:14px;padding:26px',
    });
    destino.append(cartao);
    cartao.append(el('div', { style: 'font-size:13px;color:var(--text-dim)' }, 'Carregando…'));

    let provedores = [];
    let estado = { conectado: false, credencial: null };
    try {
      const [p, e] = await Promise.all([api('/provedores'), api('/estado')]);
      provedores = p.provedores || [];
      estado = e;
    } catch (err) {
      cartao.innerHTML = '';
      cartao.append(
        el('h3', { style: 'margin:0 0 10px;font-size:15px' }, 'Inteligência Artificial'),
        el('div', { style: 'font-size:13px;color:var(--text-dim)' },
          'Não foi possível carregar: ' + err.message),
      );
      return;
    }

    desenhar();

    function desenhar() {
      cartao.innerHTML = '';
      const cred = estado.credencial;

      cartao.append(
        el('h3', { style: 'margin:0 0 6px;font-size:15px' }, 'Inteligência Artificial'),
        el('div', { style: 'font-size:12.5px;color:var(--text-dim);line-height:1.55;margin-bottom:18px' },
          'O agente usa a SUA conta de IA. Escolha o serviço, cole sua chave e ' +
          'diga qual modelo quer usar. O consumo é cobrado direto na sua conta ' +
          'do provedor — nada passa por nós.'),
      );

      // Estado atual
      if (estado.conectado && cred) {
        const problema = cred.lastError;
        cartao.append(
          el('div', {
            style:
              'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;margin-bottom:18px;' +
              (problema
                ? 'background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.35)'
                : 'background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.35)'),
          },
            el('span', { style: 'font-size:16px' }, problema ? '⚠️' : '✅'),
            el('div', { style: 'font-size:13px;line-height:1.5' },
              el('div', { style: 'font-weight:600' },
                problema ? 'Conectado, mas com erro' : 'Conectado'),
              el('div', { style: 'color:var(--text-dim)' },
                cred.providerLabel + ' · chave ' + cred.keyHint),
              el('div', { style: 'color:var(--text-dim)' },
                'Modelo: ' + cred.model + ' · CRM: ' + cred.crmModel),
              problema ? el('div', { style: 'color:var(--red);margin-top:4px' }, problema) : null,
            ),
          ),
        );
      } else {
        cartao.append(
          el('div', {
            style:
              'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;margin-bottom:18px;' +
              'background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.35)',
          },
            el('span', { style: 'font-size:16px' }, '⚠️'),
            el('div', { style: 'font-size:13px;line-height:1.5' },
              el('div', { style: 'font-weight:600' }, 'Nenhuma chave conectada'),
              el('div', { style: 'color:var(--text-dim)' },
                'Enquanto isso, o agente não responde os seus leads.'),
            ),
          ),
        );
      }

      // ─── Formulário ───────────────────────────────────────────────────
      const rotulo = 'display:block;margin-top:14px;margin-bottom:5px;font-size:12.5px;font-weight:600;color:var(--text-dim)';
      const campo =
        'width:100%;padding:9px 11px;background:var(--bg-3);color:var(--text);' +
        'border:1px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box';

      const selProvedor = el('select', { style: campo });
      for (const p of provedores) {
        const o = el('option', { value: p.id }, p.label);
        if (cred && cred.provider === p.id) o.selected = true;
        selProvedor.append(o);
      }

      const inpChave = el('input', {
        type: 'password',
        style: campo,
        placeholder: estado.conectado ? 'Deixe em branco para manter a chave atual' : 'Cole sua chave aqui',
        autocomplete: 'off',
      });

      const inpUrl = el('input', {
        type: 'text',
        style: campo,
        placeholder: 'https://seu-servico.com/v1',
        value: (cred && cred.baseUrl) || '',
      });
      const linhaUrl = el('div', {}, el('label', { style: rotulo }, 'Endereço do serviço'), inpUrl);

      // Vira <select> assim que o teste devolver a lista de modelos da conta.
      const inpModelo = el('input', {
        type: 'text',
        style: campo,
        placeholder: 'ex: z-ai/glm-5.1',
        value: (cred && cred.model) || '',
      });
      const caixaModelo = el('div', {}, inpModelo);

      const inpModeloCrm = el('input', {
        type: 'text',
        style: campo,
        placeholder: 'deixe vazio para usar o mesmo de cima',
        value: (cred && cred.crmModel !== cred.model && cred.crmModel) || '',
      });

      const dica = el('div', { style: 'font-size:11.5px;color:var(--text-dim);margin-top:6px' });

      function ajustar() {
        const p = provedores.find((x) => x.id === selProvedor.value);
        dica.textContent = p ? p.ajuda : '';
        linhaUrl.style.display = p && p.precisaUrl ? '' : 'none';
        if (p && p.modelSugerido && !inpModelo.value) inpModelo.placeholder = 'ex: ' + p.modelSugerido;
      }
      selProvedor.addEventListener('change', ajustar);

      const aviso = el('div', { style: 'margin-top:14px;font-size:12.5px;min-height:18px' });

      const btTestar = el('button', {
        style:
          'padding:9px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-3);' +
          'color:var(--text);font-size:13px;font-weight:600;cursor:pointer',
      }, 'Testar chave');

      const btSalvar = el('button', {
        style:
          'padding:9px 18px;border-radius:8px;border:none;background:linear-gradient(135deg,#E10600,#FF1F18);' +
          'color:#fff;font-size:13px;font-weight:600;cursor:pointer',
      }, estado.conectado ? 'Salvar alterações' : 'Conectar');

      const btRemover = estado.conectado
        ? el('button', {
            style:
              'padding:9px 16px;border-radius:8px;border:1px solid rgba(239,68,68,.4);background:transparent;' +
              'color:var(--red);font-size:13px;font-weight:600;cursor:pointer;margin-left:auto',
          }, 'Desconectar')
        : null;

      function mostrar(txt, cor) {
        aviso.textContent = txt;
        aviso.style.color = cor;
      }

      btTestar.addEventListener('click', async () => {
        if (!inpChave.value.trim()) {
          mostrar('Cole a chave para testar.', 'var(--red)');
          return;
        }
        btTestar.disabled = true;
        mostrar('Testando com o provedor…', 'var(--text-dim)');
        try {
          const r = await api('/testar', {
            method: 'POST',
            body: {
              provider: selProvedor.value,
              apiKey: inpChave.value.trim(),
              baseUrl: inpUrl.value.trim(),
            },
          });
          if (!r.ok) {
            mostrar(r.erro || 'A chave não foi aceita.', 'var(--red)');
          } else {
            mostrar('Chave válida.' + (r.modelos ? ' ' + r.modelos.length + ' modelos disponíveis.' : ''), '#4ade80');
            // Com a lista em mãos, trocamos o campo livre por um seletor:
            // digitar nome de modelo à mão é a forma mais fácil de errar.
            if (r.modelos && r.modelos.length) {
              const escolhido = inpModelo.value;
              const sel = el('select', { style: campo });
              for (const m of r.modelos) {
                const o = el('option', { value: m }, m);
                if (m === escolhido) o.selected = true;
                sel.append(o);
              }
              caixaModelo.innerHTML = '';
              caixaModelo.append(sel);
              inpModelo.value = sel.value;
              sel.addEventListener('change', () => { inpModelo.value = sel.value; });
            }
          }
        } catch (e) {
          mostrar('Falha ao testar: ' + e.message, 'var(--red)');
        } finally {
          btTestar.disabled = false;
        }
      });

      btSalvar.addEventListener('click', async () => {
        const novaChave = inpChave.value.trim();
        if (!novaChave) {
          mostrar(
            estado.conectado
              ? 'Para trocar a chave, cole a nova. Por segurança a atual não pode ser lida de volta.'
              : 'Cole sua chave para conectar.',
            'var(--red)',
          );
          return;
        }
        btSalvar.disabled = true;
        mostrar('Verificando e salvando…', 'var(--text-dim)');
        try {
          const r = await api('/conectar', {
            method: 'PUT',
            body: {
              provider: selProvedor.value,
              apiKey: novaChave,
              model: inpModelo.value.trim(),
              crmModel: inpModeloCrm.value.trim(),
              baseUrl: inpUrl.value.trim(),
            },
          });
          estado = { conectado: true, credencial: r.credencial };
          toast('Inteligência artificial conectada', 'success');
          desenhar();
        } catch (e) {
          mostrar(e.message, 'var(--red)');
          btSalvar.disabled = false;
        }
      });

      if (btRemover) {
        btRemover.addEventListener('click', async () => {
          if (!confirm('Desconectar sua chave? O agente para de responder até você conectar outra.')) return;
          try {
            await api('/desconectar', { method: 'DELETE' });
            estado = { conectado: false, credencial: null };
            toast('Chave desconectada');
            desenhar();
          } catch (e) {
            mostrar(e.message, 'var(--red)');
          }
        });
      }

      cartao.append(
        el('label', { style: rotulo }, 'Serviço de IA'),
        selProvedor,
        dica,
        linhaUrl,
        el('label', { style: rotulo }, estado.conectado ? 'Trocar a chave' : 'Sua chave'),
        inpChave,
        el('label', { style: rotulo }, 'Modelo do agente'),
        caixaModelo,
        el('label', { style: rotulo }, 'Modelo dos agentes do funil (opcional)'),
        inpModeloCrm,
        el('div', { style: 'font-size:11.5px;color:var(--text-dim);margin-top:6px' },
          'Os agentes das colunas fazem tarefas curtas e repetitivas — dá para ' +
          'usar um modelo mais barato aqui sem piorar a conversa principal.'),
        aviso,
        el('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:16px' },
          btTestar, btSalvar, btRemover),
      );

      ajustar();
    }
  }

  window.CartaoIA = { montar };
})();
