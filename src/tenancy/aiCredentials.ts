/**
 * aiCredentials.ts — chave e modelo de IA POR TENANT (BYOK).
 *
 * Regra do produto (decisao do Daniel, 10/08/2026): o dono do sistema nao
 * assume custo de IA de ninguem. Cada cliente pluga a propria chave e escolhe
 * o proprio modelo.
 *
 * Consequencia que atravessa o modulo inteiro: **nao existe fallback global.**
 * Se o tenant nao tem credencial, o agente dele nao roda — e o erro tem de
 * dizer isso em portugues claro, porque a acao que conserta e do cliente, nao
 * nossa. Um fallback silencioso pra chave do dono seria exatamente a conta que
 * este arquivo existe pra impedir.
 *
 * A chave nunca volta pro navegador: o que sai daqui pra tela e a mascara
 * (`key_hint`). Em repouso ela vive cifrada (AES, src/crm/crypto.ts), com a
 * chave de cifra so no env — dump do banco sem o env nao serve pra nada.
 */
import { getCrmDb } from '../crm/schema.js';
import { encryptJson, decryptJson } from '../crm/crypto.js';
import { logger } from '../utils/logger.js';

/** Como a chave viaja no HTTP: header proprio da Anthropic ou Bearer padrao. */
export type WireIa = 'anthropic' | 'openai';

export interface ProvedorIa {
  id: string;
  label: string;
  wire: WireIa;
  baseUrl: string;
  validationPath: string;
  modelsPath: string;
  modelSugerido: string;
  ajuda: string;
}

/** Credencial completa, com a chave em claro. So pra uso do motor. */
export interface CredencialIa {
  tenantId: string;
  provider: string;
  wire: WireIa;
  apiKey: string;
  baseUrl: string;
  model: string;
  crmModel: string;
}

/** O que pode ir pra tela: mascara, nunca a chave. */
export interface CredencialIaPublica {
  provider: string;
  providerLabel: string;
  keyHint: string;
  baseUrl: string;
  model: string;
  crmModel: string;
  updatedAt: number;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface EntradaCredencialIa {
  tenantId: string;
  provider: string;
  apiKey: string;
  model?: string;
  crmModel?: string;
  baseUrl?: string;
}

export interface ResultadoValidacaoIa {
  ok: boolean;
  erro?: string;
  modelos?: string[];
}

export const PROVEDORES: ProvedorIa[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    validationPath: '/v1/models', // verificado: 401 com chave falsa
    modelsPath: '/v1/models',
    modelSugerido: 'claude-sonnet-4-5',
    ajuda: 'Pegue sua chave em console.anthropic.com → API Keys.',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    wire: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    validationPath: '/models',
    modelsPath: '/models',
    modelSugerido: 'gpt-4o',
    ajuda: 'Pegue sua chave em platform.openai.com → API Keys.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (varios modelos numa chave so)',
    wire: 'openai',
    // /key exige autenticacao; /models NAO exige (verificado 10/08/2026).
    validationPath: '/key',
    modelsPath: '/models',
    modelSugerido: 'z-ai/glm-5.1',
    baseUrl: 'https://openrouter.ai/api/v1',
    ajuda: 'Pegue sua chave em openrouter.ai/keys. Da acesso a dezenas de modelos.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    validationPath: '/models', // verificado: 401 com chave falsa
    modelsPath: '/models',
    modelSugerido: 'deepseek-chat',
    ajuda: 'Pegue sua chave em platform.deepseek.com.',
  },
  {
    id: 'custom',
    label: 'Outro (compativel com OpenAI)',
    wire: 'openai',
    baseUrl: '',
    validationPath: '/models',
    modelsPath: '/models',
    modelSugerido: '',
    ajuda: 'Informe a URL base do servico, terminando em /v1.',
  },
];

export function acharProvedor(id: string): ProvedorIa | undefined {
  return PROVEDORES.find((p) => p.id === id);
}

/** Mascara pra tela: mantem o prefixo (que identifica o provedor) e o fim. */
export function mascarar(chave: string): string {
  const s = chave.trim();
  if (s.length <= 12) return '•'.repeat(Math.max(s.length, 4));
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

// ─── Leitura ──────────────────────────────────────────────────────────────

/**
 * Credencial completa (com a chave em claro) pra uso do motor.
 * Devolve null quando o tenant nao plugou chave — quem chama TEM de tratar
 * esse null como "o cliente precisa conectar", nunca como "usa a do sistema".
 */
export function obterCredencial(tenantId: string): CredencialIa | null {
  if (!tenantId) return null;
  const linha = getCrmDb()
    .prepare('SELECT * FROM tenant_ai_credentials WHERE tenant_id = ?')
    .get(tenantId) as any;
  if (!linha) return null;
  let apiKey: string;
  try {
    apiKey = decryptJson<string>(linha.api_key_encrypted);
  } catch (e) {
    // Cifra ilegivel = CLOW_CRM_SECRET trocada depois da gravacao. Nao da pra
    // recuperar; tratar como "sem credencial" e deixar o cliente replugar.
    logger.error(`[byok] credencial do tenant ${tenantId} nao pode ser decifrada (CLOW_CRM_SECRET mudou?)`);
    return null;
  }
  const spec = acharProvedor(linha.provider);
  return {
    tenantId,
    provider: linha.provider,
    wire: spec?.wire ?? 'openai',
    apiKey,
    baseUrl: linha.base_url || spec?.baseUrl || '',
    model: linha.model,
    crmModel: linha.crm_model || linha.model,
  };
}

/** Versao pra tela — sem segredo nenhum. */
export function obterCredencialPublica(tenantId: string): CredencialIaPublica | null {
  const linha = getCrmDb()
    .prepare('SELECT * FROM tenant_ai_credentials WHERE tenant_id = ?')
    .get(tenantId) as any;
  if (!linha) return null;
  const spec = acharProvedor(linha.provider);
  return {
    provider: linha.provider,
    providerLabel: spec?.label ?? linha.provider,
    keyHint: linha.key_hint,
    baseUrl: linha.base_url || spec?.baseUrl || '',
    model: linha.model,
    crmModel: linha.crm_model || linha.model,
    updatedAt: linha.updated_at,
    lastOkAt: linha.last_ok_at,
    lastError: linha.last_error,
  };
}

export function temCredencial(tenantId: string): boolean {
  if (!tenantId) return false;
  const r = getCrmDb()
    .prepare('SELECT 1 AS x FROM tenant_ai_credentials WHERE tenant_id = ?')
    .get(tenantId) as any;
  return !!r;
}

export function salvarCredencial(entrada: EntradaCredencialIa): CredencialIaPublica | null {
  const { tenantId } = entrada;
  if (!tenantId) throw new Error('tenant_id_obrigatorio');
  const spec = acharProvedor(entrada.provider);
  if (!spec) throw new Error(`provedor_desconhecido: ${entrada.provider}`);
  const apiKey = entrada.apiKey?.trim() ?? '';
  if (!apiKey) throw new Error('chave_obrigatoria');
  const model = entrada.model?.trim() || spec.modelSugerido;
  if (!model) throw new Error('modelo_obrigatorio');
  const baseUrl = (entrada.baseUrl?.trim() || spec.baseUrl).replace(/\/+$/, '');
  if (!baseUrl) throw new Error('url_base_obrigatoria');
  const agora = Date.now();
  getCrmDb()
    .prepare(
      `INSERT INTO tenant_ai_credentials
         (tenant_id, provider, api_key_encrypted, base_url, model, crm_model,
          key_hint, created_at, updated_at, last_ok_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(tenant_id) DO UPDATE SET
         provider          = excluded.provider,
         api_key_encrypted = excluded.api_key_encrypted,
         base_url          = excluded.base_url,
         model             = excluded.model,
         crm_model         = excluded.crm_model,
         key_hint          = excluded.key_hint,
         updated_at        = excluded.updated_at,
         last_error        = NULL`,
    )
    .run(tenantId, entrada.provider, encryptJson(apiKey), baseUrl, model, entrada.crmModel?.trim() || null, mascarar(apiKey), agora, agora);
  logger.info(`[byok] credencial gravada — tenant=${tenantId} provedor=${entrada.provider} modelo=${model}`);
  return obterCredencialPublica(tenantId);
}

export function removerCredencial(tenantId: string): void {
  getCrmDb().prepare('DELETE FROM tenant_ai_credentials WHERE tenant_id = ?').run(tenantId);
  logger.info(`[byok] credencial removida — tenant=${tenantId}`);
}

export function marcarSucesso(tenantId: string): void {
  getCrmDb()
    .prepare('UPDATE tenant_ai_credentials SET last_ok_at = ?, last_error = NULL WHERE tenant_id = ?')
    .run(Date.now(), tenantId);
}

export function marcarErro(tenantId: string, erro: string): void {
  getCrmDb()
    .prepare('UPDATE tenant_ai_credentials SET last_error = ? WHERE tenant_id = ?')
    .run(erro.slice(0, 300), tenantId);
}

/**
 * Confere a chave de verdade, batendo no endpoint de listagem de modelos.
 * Escolhido de proposito: e uma chamada real (nao um mock, nao um regex de
 * formato) e **nao consome token nenhum** — o cliente nao paga pra descobrir
 * que digitou a chave certa.
 */
export async function validarCredencial(
  provider: string,
  apiKey: string,
  baseUrlCustom?: string,
): Promise<ResultadoValidacaoIa> {
  const spec = acharProvedor(provider);
  if (!spec) return { ok: false, erro: `Provedor desconhecido: ${provider}` };
  const base = (baseUrlCustom?.trim() || spec.baseUrl).replace(/\/+$/, '');
  if (!base) return { ok: false, erro: 'Informe a URL base do serviço.' };
  const headers: Record<string, string> =
    spec.wire === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` };
  try {
    // Passo 1 — a chave presta? Endpoint que EXIGE autenticacao.
    const r = await fetch(`${base}${spec.validationPath}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, erro: 'A chave foi recusada pelo provedor. Confira se copiou ela inteira e se ainda está ativa.' };
    }
    if (!r.ok) {
      return { ok: false, erro: `O provedor respondeu erro ${r.status}. Tente de novo em alguns minutos.` };
    }
    // Passo 2 — lista de modelos, so pra enriquecer a tela. Best-effort: se
    // falhar, a credencial continua valida e o cliente digita o modelo na mao.
    // Falhar aqui e recusar a chave seria punir o cliente por um detalhe de
    // catalogo que nao tem nada a ver com a credencial dele.
    let modelos: string[] | undefined;
    try {
      const rm =
        spec.modelsPath === spec.validationPath
          ? r
          : await fetch(`${base}${spec.modelsPath}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (rm.ok) {
        const corpo = (await rm.json()) as any;
        modelos = Array.isArray(corpo?.data)
          ? corpo.data.map((m: any) => m?.id).filter((s: any) => !!s)
          : undefined;
      }
    } catch {
      // sem lista; segue valido
    }
    return { ok: true, modelos };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout|abort/i.test(msg)) {
      return { ok: false, erro: 'O provedor não respondeu a tempo. Tente de novo.' };
    }
    return { ok: false, erro: `Não foi possível falar com o provedor: ${msg}` };
  }
}

/** Erro padrao de "cliente sem chave". Texto unico, pra tela e log baterem. */
export class SemCredencialIa extends Error {
  tenantId: string;
  code = 'sem_credencial_ia';
  constructor(tenantId: string) {
    super(
      'Nenhuma chave de IA conectada. Abra Configurações → Inteligência Artificial ' +
        'e conecte a chave do provedor que você quiser usar.',
    );
    this.tenantId = tenantId;
    this.name = 'SemCredencialIa';
  }
}
