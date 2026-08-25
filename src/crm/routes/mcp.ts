/**
 * Rotas do servidor MCP do CRM.
 *
 *   POST /v1/crm/mcp        — endpoint JSON-RPC que o agente externo consome
 *   GET  /v1/crm/mcp        — descoberta legível (o que é, quantas tools tem)
 *   GET  /v1/crm/mcp/info   — dados para a tela de conexão (URL, tools, chaves)
 *   POST /v1/crm/mcp/keys   — cria chave de acesso
 *   DELETE /v1/crm/mcp/keys/:id — revoga
 *
 * Autenticação é a que já existe: `tenantAuth` roda antes de `/v1/crm/*` e
 * resolve a chave `clow_...` do header Authorization para um tenant. Por isso
 * não há tabela nem token novo aqui — o MCP entra como mais um consumidor da
 * API, e revogar a chave corta o acesso do agente externo na mesma hora.
 */
import { Hono } from 'hono';
import { tenantOf } from './_helpers.js';
import { tratarPayload, listarTools } from '../mcp/mcpServer.js';
import {
  createApiKeyForTenant, revokeApiKey, listApiKeysForTenant, hashApiKey,
} from '../../tenancy/tenantStore.js';
import { logger } from '../../utils/logger.js';

/**
 * Hash da chave que autenticou ESTA requisição, quando houver uma.
 *
 * Serve para a tela marcar qual das chaves é a que o próprio navegador está
 * usando. Sem isso o painel listaria todas iguais e um clique em "Revogar" na
 * linha errada tranca o usuário para fora do próprio CRM — a chave da sessão
 * do navegador mora na mesma lista das chaves de MCP.
 *
 * Sessão de usuário (JWT) não casa com nenhuma, e aí nenhuma é marcada, que é
 * o comportamento certo: nesse caso revogar qualquer uma não derruba a tela.
 */
function hashDaChaveAtual(c: any): string | null {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token.startsWith('clow_')) return null;
  return hashApiKey(token);
}

/** Monta a URL pública do endpoint a partir da requisição. */
function urlDoEndpoint(c: any): string {
  const url = new URL(c.req.url);
  // Atrás do Traefik o protocolo interno é http; sem isto a tela mostraria
  // uma URL http:// que o cliente MCP recusa por ser insegura.
  const proto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || url.host;
  return `${proto}://${host}/v1/crm/mcp`;
}

export function registerMcpRoutes(app: Hono): void {
  // ─── Endpoint JSON-RPC ────────────────────────────────────────────────
  app.post('/mcp', async (c) => {
    const tenantId = tenantOf(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'json_invalido' } },
        400,
      );
    }

    // O MCP identifica sessão por header. Aceitamos sem exigir: este servidor
    // é sem estado — cada chamada carrega o tenant na própria autenticação —
    // e recusar cliente que não manda o header só quebraria integração à toa.
    const sessionId = c.req.header('mcp-session-id') || `mcp-${tenantId.slice(0, 8)}`;

    const resposta = await tratarPayload(body, tenantId, sessionId);

    // Lote só de notificações não tem o que responder. 202 é o que o
    // protocolo manda; devolver 200 com corpo vazio faz cliente estrito
    // tentar dar parse em nada e derrubar a conexão.
    if (resposta === null) return c.body(null, 202);

    return c.json(resposta as any);
  });

  // ─── Descoberta ───────────────────────────────────────────────────────
  //
  // Alguns clientes batem GET no endpoint antes de falar JSON-RPC. O protocolo
  // reserva o GET para abrir stream SSE, que este servidor não oferece — mas
  // responder 405 seco deixa quem está configurando sem nenhuma pista de que
  // acertou a URL. Uma descrição curta resolve isso sem fingir um stream.
  app.get('/mcp', async (c) => {
    const tenantId = tenantOf(c);
    return c.json({
      protocol: 'mcp',
      transport: 'streamable-http',
      method: 'POST',
      server: 'system-clow-crm',
      tools: listarTools().length,
      tenant: tenantId.slice(0, 8),
      hint: 'Mande JSON-RPC 2.0 por POST nesta mesma URL. Comece por initialize.',
    });
  });

  // ─── Dados da tela de conexão ─────────────────────────────────────────
  app.get('/mcp/info', async (c) => {
    const tenantId = tenantOf(c);
    const tools = listarTools();
    const atual = hashDaChaveAtual(c);
    return c.json({
      endpoint: urlDoEndpoint(c),
      tools: tools.map((t) => ({
        name: t.name,
        description: (t.description || '').split('\n')[0].slice(0, 160),
        readOnly: !!t.annotations?.readOnlyHint,
      })),
      // Só metadado: a chave em si existe em texto claro uma única vez, na
      // resposta de POST /mcp/keys. Depois disso só sobra o hash, e nem o
      // dono consegue lê-la de volta — perdeu, gera outra.
      keys: listApiKeysForTenant(tenantId).map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at ?? null,
        emUso: k.key_hash === atual,
      })),
    });
  });

  // ─── Chaves ───────────────────────────────────────────────────────────
  app.post('/mcp/keys', async (c) => {
    const tenantId = tenantOf(c);
    const body = await c.req.json().catch(() => ({}));
    const nome = String(body?.name || '').trim() || 'MCP';
    if (nome.length > 60) {
      return c.json({ error: 'nome_muito_longo', message: 'Máximo de 60 caracteres.' }, 400);
    }
    const chave = createApiKeyForTenant(tenantId, nome);
    logger.info(`[crm-mcp] chave criada para tenant=${tenantId.slice(0, 8)} nome=${nome}`);
    return c.json({ key: chave, name: nome, endpoint: urlDoEndpoint(c) }, 201);
  });

  app.delete('/mcp/keys/:id', async (c) => {
    const tenantId = tenantOf(c);
    const id = c.req.param('id');
    // `revokeApiKey` acha a chave pelo id sem olhar tenant. Chamar direto com
    // um id de fora revogaria a chave de outro cliente — por isso a posse é
    // conferida aqui antes, contra a lista do próprio tenant.
    const minhas = listApiKeysForTenant(tenantId);
    const alvo = minhas.find((k) => k.id === id);
    if (!alvo) {
      return c.json({ error: 'chave_nao_encontrada' }, 404);
    }
    // Recusa revogar a chave que está autenticando esta própria chamada. A
    // trava também existe na tela, mas precisa estar aqui: a tela é uma das
    // formas de chamar esta rota, não a única, e revogar a chave da sessão
    // tranca o dono para fora do CRM sem caminho de volta pela interface.
    if (alvo.key_hash === hashDaChaveAtual(c)) {
      return c.json({
        error: 'chave_em_uso',
        message: 'Esta é a chave que está autenticando você agora. Revogá-la tiraria seu acesso ao CRM.',
      }, 409);
    }
    const ok = revokeApiKey(id);
    if (!ok) return c.json({ error: 'chave_nao_encontrada' }, 404);
    logger.info(`[crm-mcp] chave revogada tenant=${tenantId.slice(0, 8)} id=${id}`);
    return c.json({ revoked: true });
  });
}
