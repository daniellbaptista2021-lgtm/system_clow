/* Sessão por janela: nunca grava a credencial do Território no localStorage. */
(() => {
  let nested = false;
  try { nested = window.parent !== window && !!window.parent.clowTerritorio; } catch {}
  const embedded = nested || new URLSearchParams(location.search).get('territorio') === '1';
  window.clowTerritorio = embedded;
  if (!embedded) { window.clowStorage = localStorage; return; }
  if (nested) {
    window.clowStorage = window.parent.clowStorage;
    window.clowTerritorioReady = window.parent.clowTerritorioReady;
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
