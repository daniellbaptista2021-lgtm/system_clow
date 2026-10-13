/* Sessão por janela: nunca grava a credencial do Território no localStorage. */
(() => {
  let nested = false;
  try { nested = window.parent !== window && !!window.parent.clowTerritorio; } catch {}
  const embedded = nested || new URLSearchParams(location.search).get('territorio') === '1';
  window.clowTerritorio = embedded;
  if (!embedded) { window.clowStorage = localStorage; return; }

  // ─── Identidade visual do cliente ─────────────────────────────────────
  // O Território manda a marca que o cliente definiu no painel (pela Aurora
  // ou por "Personalizar marca"). Só entra cor hexadecimal, texto curto e
  // logo https — nada que vire CSS ou HTML livre. Cliente sem marca não
  // recebe mensagem nenhuma e o CRM fica com a cara padrão.
  const HEX = /^#[0-9a-fA-F]{6}$/;
  function rgba(hex, a) {
    const n = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 'rgba(' + n.join(',') + ',' + a + ')';
  }
  function mix(a, b, pesoA) { return 'color-mix(in srgb, ' + a + ' ' + pesoA + '%, ' + b + ')'; }
  function validarMarca(d) {
    const cores = ['primaria', 'destaque', 'fundo', 'superficie', 'texto'];
    if (!d || cores.some(k => typeof d[k] !== 'string' || !HEX.test(d[k]))) return null;
    const nome = typeof d.nome === 'string' ? d.nome.trim().slice(0, 48) : '';
    const slogan = typeof d.slogan === 'string' ? d.slogan.trim().slice(0, 90) : '';
    let logoUrl = null;
    try { if (typeof d.logoUrl === 'string' && new URL(d.logoUrl).protocol === 'https:') logoUrl = d.logoUrl; } catch {}
    const m = { nome, slogan, logoUrl };
    cores.forEach(k => { m[k] = d[k].toLowerCase(); });
    return m;
  }
  function aplicarCores(m) {
    const css = {
      '--bg': m.fundo,
      '--bg-2': mix(m.superficie, m.fundo, 45),
      '--bg-3': m.superficie,
      '--bg-4': mix(m.superficie, m.texto, 92),
      '--border': mix(m.texto, 'transparent', 9),
      '--border-2': rgba(m.primaria, .28),
      '--text': m.texto,
      '--text-2': mix(m.texto, m.fundo, 68),
      '--text-dim': mix(m.texto, m.fundo, 68),
      '--text-faint': mix(m.texto, m.fundo, 50),
      '--purple': m.primaria,
      '--blue': m.destaque,
      '--grad': 'linear-gradient(135deg, ' + m.primaria + ', ' + m.destaque + ')',
      '--grad-soft': 'linear-gradient(135deg, ' + rgba(m.primaria, .16) + ', ' + rgba(m.destaque, .10) + ')',
      '--primary-soft': rgba(m.primaria, .14),
      // A pagina do Agente IA (/agente) usa nomes proprios para as mesmas cores.
      '--accent': m.primaria,
      '--bg-soft': mix(m.superficie, m.fundo, 45),
      '--bg-panel': mix(m.superficie, m.fundo, 45),
      '--bg-card': m.superficie,
      '--line': mix(m.texto, 'transparent', 7),
      '--line-soft': mix(m.texto, 'transparent', 5),
      '--muted': mix(m.texto, m.fundo, 68),
      '--muted-2': mix(m.texto, m.fundo, 50),
    };
    const raiz = document.documentElement.style;
    Object.entries(css).forEach(([k, v]) => raiz.setProperty(k, v));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', m.fundo);
  }
  function aplicarTopo(m) {
    const caixa = document.querySelector('.sidebar .brand');
    if (!caixa) return false;
    caixa.replaceChildren();
    caixa.classList.add('brand-cliente');
    if (m.logoUrl) {
      const img = document.createElement('img');
      img.className = 'brand-logo';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = m.logoUrl;
      img.addEventListener('error', () => img.remove());
      caixa.append(img);
    }
    const texto = document.createElement('div');
    texto.className = 'brand-cliente-texto';
    const nome = document.createElement('strong');
    nome.textContent = m.nome || 'Meu CRM';
    texto.append(nome);
    if (m.slogan) {
      const sub = document.createElement('span');
      sub.textContent = m.slogan;
      texto.append(sub);
    }
    caixa.append(texto);
    caixa.setAttribute('aria-label', m.nome || 'Meu CRM');
    return true;
  }
  function aplicarMarca(m) {
    window.clowTerritorioMarca = m;
    aplicarCores(m);
    if (m.nome) document.title = 'CRM — ' + m.nome;
    if (!aplicarTopo(m)) document.addEventListener('DOMContentLoaded', () => aplicarTopo(m), { once: true });
  }
  if (nested) {
    window.clowStorage = window.parent.clowStorage;
    window.clowTerritorioReady = window.parent.clowTerritorioReady;
    try { if (window.parent.clowTerritorioMarca) aplicarMarca(window.parent.clowTerritorioMarca); } catch {}
    return;
  }
  const secrets = new Map();
  const authKeys = new Set(['clow_token', 'clow_crm_key', 'clow_login_user', 'clow_bridge_mode']);
  window.clowStorage = {
    getItem(key) { return authKeys.has(key) ? secrets.get(key) || null : localStorage.getItem(key); },
    setItem(key, value) { if (authKeys.has(key)) secrets.set(key, String(value)); else localStorage.setItem(key, value); },
    removeItem(key) { if (authKeys.has(key)) secrets.delete(key); else localStorage.removeItem(key); },
  };
  let resolveReady;
  let profileId;
  let expiresTimer;
  window.clowTerritorioReady = new Promise(resolve => { resolveReady = resolve; });
  function block() {
    secrets.clear();
    location.replace('/crm/?territorio=1');
  }
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== window.CLOW_TERRITORIO_ORIGIN) return;
    if (event.data?.type === 'territorio:crm:blocked') { block(); return; }
    if (event.data?.type === 'territorio:crm:brand') { const m = validarMarca(event.data); if (m) aplicarMarca(m); return; }
    if (event.data?.type !== 'territorio:crm:session' || typeof event.data.token !== 'string' || !event.data.token.startsWith('tp.') || !Number.isFinite(event.data.expiresAt)) return;
    if (profileId && profileId !== event.data.profileId) { block(); return; }
    profileId = event.data.profileId;
    window.clowStorage.setItem('clow_token', event.data.token);
    window.clowStorage.setItem('clow_crm_key', event.data.token);
    clearTimeout(expiresTimer);
    expiresTimer = setTimeout(block, Math.max(0, event.data.expiresAt - Date.now()));
    resolveReady();
    window.dispatchEvent(new Event('territorio-session'));
  });
  if (window.parent !== window && window.CLOW_TERRITORIO_ORIGIN) {
    window.parent.postMessage({ type: 'territorio:crm:ready' }, window.CLOW_TERRITORIO_ORIGIN);
  }
})();
