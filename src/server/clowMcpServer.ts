/**
 * clowMcpServer.ts — Clow CRM MCP Server (HTTP / JSON-RPC)
 *
 * Exposes System Clow's CRM operations as MCP tools so an external agent
 * (e.g. OpenClaw on another VPS) can command the CRM: read the pipeline,
 * move cards, reply to customers on WhatsApp, create tasks/follow-ups,
 * add notes, manage contacts — all scoped to a single tenant via API key.
 *
 * Design: each tool is a thin proxy to the EXISTING REST routes under
 * /v1/crm/*. The caller's `Authorization: Bearer clow_...` header is
 * forwarded verbatim to the internal route, so tenant resolution and
 * isolation are inherited from `tenantAuth` (fail-closed — no token, no data).
 *
 * MCP client config (OpenClaw / Claude):
 * {
 *   "mcpServers": {
 *     "system-clow": {
 *       "url": "http://<clow-host>:3001/v1/mcp",
 *       "headers": { "Authorization": "Bearer clow_live_xxx" }
 *     }
 *   }
 * }
 */

import { Hono } from 'hono';

interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

type InternalCall = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string; // path + optional querystring, relative to base
  body?: unknown;
};

interface ClowTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build: (args: Record<string, any>) => InternalCall;
}

const q = (v: unknown) => encodeURIComponent(String(v ?? ''));

// ─── Tool catalogue ──────────────────────────────────────────────────────────
// Each tool maps 1:1 to an existing /v1/crm route. Keep names stable: the
// external agent references them by name.
const TOOLS: ClowTool[] = [
  {
    name: 'list_boards',
    description: 'Lista os funis (boards) do CRM do tenant. Use para descobrir o boardId antes de ler o pipeline.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({ method: 'GET', path: '/v1/crm/boards' }),
  },
  {
    name: 'get_pipeline',
    description: 'Retorna o funil completo (board + colunas/tabelas + cards agrupados por coluna). É a forma de "ver tudo": quais clientes estão em cada tabela de atendimento.',
    inputSchema: {
      type: 'object',
      properties: { boardId: { type: 'string', description: 'ID do board (de list_boards)' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'GET', path: `/v1/crm/boards/${q(a.boardId)}/pipeline` }),
  },
  {
    name: 'list_channels',
    description: 'Lista os canais de WhatsApp (Meta/Z-API) do tenant. Use para obter o channelId necessário em send_message.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    build: () => ({ method: 'GET', path: '/v1/crm/channels' }),
  },
  {
    name: 'get_card',
    description: 'Detalhe de um card/oportunidade, incluindo atividades (timeline de mensagens).',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' } },
      required: ['cardId'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'GET', path: `/v1/crm/cards/${q(a.cardId)}` }),
  },
  {
    name: 'send_message',
    description: 'Responde o cliente enviando uma mensagem de WhatsApp pelo canal. É assim que o agente "atende". Informe channelId (de list_channels), to (telefone do cliente) e text. Opcional: cardId/contactId para vincular à oportunidade.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'ID do canal (de list_channels)' },
        to: { type: 'string', description: 'Telefone do cliente em formato internacional, ex: 5511999999999' },
        text: { type: 'string', description: 'Texto da mensagem' },
        cardId: { type: 'string' },
        contactId: { type: 'string' },
        mediaUrl: { type: 'string' },
        mediaType: { type: 'string', enum: ['image', 'audio', 'document', 'video'] },
        caption: { type: 'string' },
        replyToMessageId: { type: 'string' },
      },
      required: ['channelId', 'to', 'text'],
      additionalProperties: false,
    },
    build: (a) => {
      const { channelId, ...body } = a;
      return { method: 'POST', path: `/v1/crm/channels/${q(channelId)}/send`, body };
    },
  },
  {
    name: 'move_card',
    description: 'Move um card para outra coluna/tabela do funil (ex: avançar do atendimento para "Lançar Venda"). Dispara as automações da coluna de destino.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        toColumnId: { type: 'string', description: 'ID da coluna destino (de get_pipeline)' },
        position: { type: 'number' },
      },
      required: ['cardId', 'toColumnId'],
      additionalProperties: false,
    },
    build: (a) => {
      const { cardId, ...body } = a;
      return { method: 'POST', path: `/v1/crm/cards/${q(cardId)}/move`, body };
    },
  },
  {
    name: 'create_card',
    description: 'Cria um novo card/oportunidade em uma coluna de um board.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        columnId: { type: 'string' },
        title: { type: 'string' },
        contactId: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['boardId', 'columnId', 'title'],
      additionalProperties: true,
    },
    build: (a) => ({ method: 'POST', path: '/v1/crm/cards', body: a }),
  },
  {
    name: 'update_card',
    description: 'Atualiza campos de um card (título, owner, custom fields, etc).',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' } },
      required: ['cardId'],
      additionalProperties: true,
    },
    build: (a) => {
      const { cardId, ...body } = a;
      return { method: 'PATCH', path: `/v1/crm/cards/${q(cardId)}`, body };
    },
  },
  {
    name: 'win_card',
    description: 'Marca um card como GANHO (venda fechada).',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' }, reason: { type: 'string' } },
      required: ['cardId'],
      additionalProperties: false,
    },
    build: (a) => {
      const { cardId, ...body } = a;
      return { method: 'POST', path: `/v1/crm/cards/${q(cardId)}/win`, body };
    },
  },
  {
    name: 'lose_card',
    description: 'Marca um card como PERDIDO. reason é obrigatório.',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' }, reason: { type: 'string' }, toColumnId: { type: 'string' } },
      required: ['cardId', 'reason'],
      additionalProperties: false,
    },
    build: (a) => {
      const { cardId, ...body } = a;
      return { method: 'POST', path: `/v1/crm/cards/${q(cardId)}/lose`, body };
    },
  },
  {
    name: 'add_card_comment',
    description: 'Adiciona um comentário/nota interna a um card (não é enviado ao cliente).',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' }, content: { type: 'string' } },
      required: ['cardId', 'content'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'POST', path: `/v1/crm/cards/${q(a.cardId)}/comments`, body: { content: a.content } }),
  },
  {
    name: 'create_task',
    description: 'Cria uma tarefa/follow-up (ex: cobrar mensalidade, ligar para o cliente). Use type "followup" e dueAt (epoch ms) para agendar.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['call', 'email', 'meeting', 'followup', 'other'] },
        priority: { type: 'string', enum: ['low', 'med', 'high', 'urgent'] },
        dueAt: { type: 'number', description: 'Vencimento em epoch ms' },
        cardId: { type: 'string' },
        contactId: { type: 'string' },
        assignedToAgentId: { type: 'string' },
        alertMinutesBefore: { type: 'number' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'POST', path: '/v1/crm/tasks', body: a }),
  },
  {
    name: 'list_tasks',
    description: 'Lista tarefas do tenant (cobranças, follow-ups). Filtro opcional por status.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    build: (a) => {
      const params = new URLSearchParams();
      if (a.status) params.set('status', String(a.status));
      if (a.limit) params.set('limit', String(a.limit));
      const qs = params.toString();
      return { method: 'GET', path: `/v1/crm/tasks${qs ? `?${qs}` : ''}` };
    },
  },
  {
    name: 'complete_task',
    description: 'Marca uma tarefa como concluída.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'POST', path: `/v1/crm/tasks/${q(a.taskId)}/complete` }),
  },
  {
    name: 'search_contacts',
    description: 'Busca contatos por nome, telefone ou documento.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'GET', path: `/v1/crm/contacts/search?q=${q(a.q)}` }),
  },
  {
    name: 'list_contacts',
    description: 'Lista contatos do tenant.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' }, offset: { type: 'number' }, tag: { type: 'string' } },
      additionalProperties: false,
    },
    build: (a) => {
      const params = new URLSearchParams();
      if (a.limit) params.set('limit', String(a.limit));
      if (a.offset) params.set('offset', String(a.offset));
      if (a.tag) params.set('tag', String(a.tag));
      const qs = params.toString();
      return { method: 'GET', path: `/v1/crm/contacts${qs ? `?${qs}` : ''}` };
    },
  },
  {
    name: 'add_contact_note',
    description: 'Adiciona uma nota a um contato.',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' }, content: { type: 'string' } },
      required: ['contactId', 'content'],
      additionalProperties: false,
    },
    build: (a) => ({ method: 'POST', path: `/v1/crm/contacts/${q(a.contactId)}/notes`, body: { content: a.content } }),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function rpcError(id: string | number | undefined, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

export function buildClowMcpRoutes(): Hono {
  const app = new Hono();
  const BASE = `http://127.0.0.1:${process.env.PORT || '3001'}`;

  app.post('/v1/mcp', async (c) => {
    let body: MCPRequest;
    try {
      body = (await c.req.json()) as MCPRequest;
    } catch (err: any) {
      return c.json(rpcError(undefined, -32700, `Parse error: ${err.message}`), 400);
    }

    const { jsonrpc, id, method, params } = body;
    if (jsonrpc !== '2.0') {
      return c.json(rpcError(id, -32600, 'Invalid Request'));
    }

    switch (method) {
      case 'initialize':
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'system-clow-crm', version: '1.0.0' },
          },
        });

      case 'notifications/initialized':
        return c.json({ jsonrpc: '2.0' });

      case 'tools/list':
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });

      case 'tools/call': {
        const toolName = params?.name as string | undefined;
        const args = (params?.arguments as Record<string, any> | undefined) || {};
        if (!toolName) return c.json(rpcError(id, -32602, 'Missing tool name'));

        const tool = TOOL_BY_NAME.get(toolName);
        if (!tool) return c.json(rpcError(id, -32602, `Unknown tool: ${toolName}`));

        // Auth is mandatory for any data operation: forward the caller's token.
        const auth = c.req.header('Authorization');
        if (!auth) {
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'Erro: header Authorization: Bearer clow_... ausente.' }],
              isError: true,
            },
          });
        }

        let call: InternalCall;
        try {
          call = tool.build(args);
        } catch (err: any) {
          return c.json(rpcError(id, -32602, `Invalid arguments for ${toolName}: ${err.message}`));
        }

        try {
          const res = await fetch(`${BASE}${call.path}`, {
            method: call.method,
            headers: {
              Authorization: auth,
              ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
          });
          const text = await res.text();
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
              isError: res.status >= 400,
            },
          });
        } catch (err: any) {
          return c.json(rpcError(id, -32603, `Tool execution failed: ${err.message}`));
        }
      }

      default:
        return c.json(rpcError(id, -32601, `Method not found: ${method}`));
    }
  });

  // Lightweight discovery endpoint (no auth) — handy for debugging connectivity.
  app.get('/v1/mcp/info', (c) =>
    c.json({
      name: 'system-clow-crm',
      version: '1.0.0',
      protocolVersion: '2024-11-05',
      transport: 'http-jsonrpc',
      endpoint: '/v1/mcp',
      toolCount: TOOLS.length,
      tools: TOOLS.map((t) => t.name),
    }),
  );

  return app;
}
