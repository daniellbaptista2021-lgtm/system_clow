/**
 * Servidor MCP do CRM — deixa um agente externo operar o System Clow.
 *
 * ── O que é ──────────────────────────────────────────────────────────────
 *
 * O Model Context Protocol é JSON-RPC 2.0. Este módulo implementa o lado
 * SERVIDOR (`src/mcp/` já tinha o lado cliente, que é o System Clow chamando
 * ferramentas de terceiros — direção oposta). Transporte: Streamable HTTP,
 * um único POST que responde JSON. Sem SSE: nenhuma tool daqui emite progresso
 * parcial, então stream seria complexidade sem uso.
 *
 * ── De onde vêm as tools ────────────────────────────────────────────────
 *
 * De `CrmTools`, o mesmo conjunto que o agente interno usa. Isso é decisão de
 * design, não atalho: reescrever as 27 tools aqui criaria duas definições da
 * mesma operação que divergem no primeiro bug corrigido só de um lado. Quem
 * adiciona uma tool ao agente interno ganha a mesma tool no MCP de graça.
 *
 * O schema é traduzido de Zod para JSON Schema por `zodParaJsonSchema`, o
 * mesmo tradutor que monta as tools para a API da Anthropic — outra vez, uma
 * fonte só.
 *
 * ── Isolamento entre clientes ───────────────────────────────────────────
 *
 * O `tenantId` sai do contexto da requisição, colocado por `tenantAuth` a
 * partir da chave `clow_...` do Authorization. Nunca do corpo do JSON-RPC:
 * campo controlado pelo chamador vira acesso cruzado entre tenants na hora em
 * que alguém mandar o id de outro. `tid()` dentro das tools é fail-closed e
 * lança se o campo estiver vazio, então o pior caso é erro, não vazamento.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { CrmTools } from '../../tools/CrmTool/CrmTool.js';
import { zodParaJsonSchema } from '../../api/anthropic.js';
import { logger } from '../../utils/logger.js';
import type { Tool, ToolUseContext } from '../../tools/Tool.js';

/**
 * Versões do protocolo que sabemos falar.
 *
 * A negociação do MCP manda ecoar a versão pedida quando ela é conhecida; se
 * for desconhecida, responde-se a preferida e o cliente decide se continua.
 */
const VERSOES_SUPORTADAS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const VERSAO_PREFERIDA = '2025-06-18';

const SERVER_INFO = {
  name: 'system-clow-crm',
  title: 'System Clow CRM',
  version: '1.0.0',
};

// ─── Erros JSON-RPC ─────────────────────────────────────────────────────
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface RpcErro { code: number; message: string; data?: unknown }

function ok(id: unknown, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function erro(id: unknown, e: RpcErro) {
  return { jsonrpc: '2.0' as const, id, error: e };
}

/**
 * As tools que o MCP expõe — curadoria explícita, não o `CrmTools` inteiro.
 *
 * O agente interno tem 27 tools porque também monta funil e mexe em cobrança
 * a mando do dono. Um agente externo veio operar o dia a dia, e catálogo
 * grande sai caro dos dois lados: o modelo do outro lado escolhe pior quanto
 * mais parecidas as opções, e cada tool ocupa contexto em toda conversa.
 *
 * Editar esta lista é o jeito de mudar o que o MCP oferece. O nome tem que
 * bater com o `name` da tool em CrmTool.ts — nome que não existe é ignorado
 * na montagem, e a checagem logo abaixo grita no log se isso acontecer.
 *
 * DE FORA, e por quê:
 *   - boards e colunas (list/create/update/delete, configure/disable agente):
 *     é montagem de estrutura, feita uma vez pelo dono na tela. Agente externo
 *     apagando coluna leva junto o histórico de card que passou por ela.
 *   - assinaturas (create/mark_paid): mexe em cobrança de cliente. Dinheiro
 *     não entra por integração antes de alguém pedir explicitamente.
 *   - send_whatsapp_batch: dispara para muita gente de uma vez. O avulso
 *     resolve o caso legítimo, e o estrago de um erro fica em uma pessoa.
 *   - apply_tag / remove_tag: classificação acessória; `crm_list_cards` já
 *     filtra por tag para quem só precisa ler.
 */
const TOOLS_EXPOSTAS = [
  // Panorama e busca
  'crm_dashboard',
  'crm_pipeline',
  'crm_search',
  'crm_get_contact',
  'crm_list_cards',
  // Operação do funil
  'crm_find_or_create_contact',
  'crm_create_card',
  'crm_update_card',
  'crm_move_card',
  'crm_add_note',
  // Conversa
  'crm_send_whatsapp',
  // Follow-up
  'crm_create_task',
  'crm_create_reminder',
  'crm_create_appointment',
];

const todas = new Map<string, Tool<any, any, any>>(
  (CrmTools as Tool<any, any, any>[]).map((t) => [t.name, t]),
);

/**
 * As tools do CRM expostas, indexadas por nome.
 *
 * Filtrar só o catálogo não bastaria: `tools/call` casa pelo nome, e um agente
 * que chutasse `crm_send_whatsapp_batch` executaria uma tool que decidimos não
 * oferecer. A curadoria vale para os dois caminhos porque os dois leem daqui.
 */
const porNome = new Map<string, Tool<any, any, any>>(
  TOOLS_EXPOSTAS.flatMap((nome) => {
    const t = todas.get(nome);
    if (!t) {
      // Renomearam ou removeram a tool em CrmTool.ts e esta lista ficou para
      // trás. Silenciar viraria "sumiu uma ferramenta do MCP e ninguém sabe
      // desde quando".
      logger.warn(`[crm-mcp] tool "${nome}" está na lista de expostas mas não existe em CrmTools`);
      return [];
    }
    return [[nome, t] as [string, Tool<any, any, any>]];
  }),
);

/**
 * Catálogo no formato do MCP.
 *
 * `annotations` são dicas para o cliente decidir o que pode rodar sozinho e o
 * que merece confirmação humana. As tools já respondem `isReadOnly` e
 * `isDestructive`; repassar isso evita que um agente externo dispare um
 * `crm_send_whatsapp` — que fala com cliente de verdade — achando que era uma
 * consulta.
 *
 * Sai de `porNome`, que já é a lista curada: catálogo e execução leem a mesma
 * fonte, então não existe estado em que um anuncia o que o outro recusa.
 */
export function listarTools() {
  return [...porNome.values()].map((t) => {
    // As flags do contrato podem depender do input (BashTool decide por
    // comando). Nenhuma tool do CRM faz isso — todas respondem fixo — então
    // consultar com input vazio dá a resposta certa para o catálogo. Se um dia
    // alguma passar a variar, o catch abaixo mantém o palpite conservador em
    // vez de anunciar como leitura algo que escreve.
    let readOnly = false;
    let destructive = true;
    try { readOnly = !!t.isReadOnly({} as any); } catch { /* mantém o padrão */ }
    try { destructive = !!t.isDestructive?.({} as any); } catch { /* mantém o padrão */ }
    return {
      name: t.name,
      description: t.description,
      inputSchema: zodParaJsonSchema(t.inputSchema),
      annotations: {
        title: typeof t.userFacingName === 'function' ? safeUserFacingName(t) : t.name,
        readOnlyHint: readOnly,
        destructiveHint: readOnly ? false : destructive,
      },
    };
  });
}

function safeUserFacingName(t: Tool<any, any, any>): string {
  try { return t.userFacingName() || t.name; } catch { return t.name; }
}

/**
 * Contexto sintético para a chamada de tool.
 *
 * As tools do CRM só leem `tenantId` e `sessionId` — as demais casas existem
 * porque o contrato `ToolUseContext` é compartilhado com as tools de arquivo e
 * shell, que precisam de cwd e permissões. `permissionMode: 'default'` e a
 * ausência de tools de sistema nas `options` mantêm este contexto incapaz de
 * tocar disco mesmo se alguém plugar outra tool aqui um dia.
 */
function contextoDe(tenantId: string, sessionId: string): ToolUseContext {
  return {
    cwd: process.cwd(),
    sessionId,
    tenantId,
    permissionMode: 'default',
    depth: 0,
    options: { tools: [] },
  };
}

/** Resultado de uma tool no formato de conteúdo do MCP. */
function conteudoDe(resultado: { output: unknown; outputText: string; isError?: boolean }) {
  const partes: Array<Record<string, unknown>> = [
    { type: 'text', text: resultado.outputText || '' },
  ];
  return {
    content: partes,
    // `structuredContent` é o payload cru, para o cliente que quiser os
    // campos em vez do texto. O texto sozinho obrigaria o agente do outro
    // lado a fazer parsing de português para achar um id.
    structuredContent: resultado.output ?? null,
    isError: !!resultado.isError,
  };
}

async function chamarTool(nome: string, args: unknown, tenantId: string, sessionId: string) {
  const tool = porNome.get(nome);
  if (!tool) {
    return { erro: { code: METHOD_NOT_FOUND, message: `tool_desconhecida: ${nome}` } };
  }

  // Valida com o mesmo Zod que o agente interno usa. Sem isto uma chamada
  // malformada explodiria lá dentro com stack trace de implementação em vez
  // de dizer ao agente qual campo está errado.
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const detalhe = parsed.error.issues
      .map((i: z.ZodIssue) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return { erro: { code: INVALID_PARAMS, message: `argumentos_invalidos: ${detalhe}` } };
  }

  const ctx = contextoDe(tenantId, sessionId);
  try {
    const r = await tool.call(
      parsed.data,
      ctx,
      async () => ({ behavior: 'allow' as const, updatedInput: parsed.data }),
      randomUUID(),
    );
    return { resultado: conteudoDe(r as any) };
  } catch (err: any) {
    // Falha de tool volta como resultado com isError, não como erro de
    // JSON-RPC: pelo protocolo, erro de transporte é problema do cliente e
    // erro de execução é informação que o modelo precisa ler para corrigir a
    // própria chamada. Trocar os dois faz o agente externo desistir em vez de
    // tentar de novo com o argumento certo.
    logger.warn(`[crm-mcp] tool ${nome} falhou:`, err?.message);
    return {
      resultado: {
        content: [{ type: 'text', text: `Erro ao executar ${nome}: ${err?.message || 'falha desconhecida'}` }],
        structuredContent: null,
        isError: true,
      },
    };
  }
}

/**
 * Processa uma mensagem JSON-RPC.
 *
 * Devolve `null` para notificação (mensagem sem `id`), que por protocolo não
 * tem resposta — o HTTP responde 202 sem corpo nesse caso.
 */
export async function tratarMensagem(
  msg: any,
  tenantId: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return erro(msg?.id ?? null, { code: INVALID_REQUEST, message: 'requisicao_invalida' });
  }

  const ehNotificacao = msg.id === undefined || msg.id === null;
  const { method, params, id } = msg;

  switch (method) {
    case 'initialize': {
      const pedida = params?.protocolVersion;
      const versao = VERSOES_SUPORTADAS.includes(pedida) ? pedida : VERSAO_PREFERIDA;
      return ok(id, {
        protocolVersion: versao,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Ferramentas do CRM System Clow. Antes de criar card ou mandar mensagem, ' +
          'resolva o contato com crm_find_or_create_contact e use o id retornado. ' +
          'crm_pipeline e crm_dashboard dão o panorama; crm_search encontra por texto. ' +
          'Tools de envio falam com clientes reais — confirme com o usuário antes de disparar.',
      });
    }

    // Notificações do handshake: reconhecidas e sem resposta, como manda o
    // protocolo. Responder a uma notificação faz cliente estrito abortar.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ehNotificacao ? null : ok(id, {});

    case 'tools/list':
      return ok(id, { tools: listarTools() });

    case 'tools/call': {
      const nome = params?.name;
      if (typeof nome !== 'string') {
        return erro(id, { code: INVALID_PARAMS, message: 'params.name obrigatorio' });
      }
      const r = await chamarTool(nome, params?.arguments, tenantId, sessionId);
      if (r.erro) return erro(id, r.erro);
      return ok(id, r.resultado);
    }

    // Declaramos apenas `tools` em capabilities, mas cliente que pergunta por
    // recurso e prompt é comum. Lista vazia é resposta válida e evita que o
    // cliente trate "método não encontrado" como servidor quebrado.
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });

    default:
      if (ehNotificacao) return null;
      return erro(id, { code: METHOD_NOT_FOUND, message: `metodo_desconhecido: ${method}` });
  }
}

/**
 * Processa o corpo de um POST — mensagem única ou lote.
 *
 * Devolve `null` quando nada precisa de resposta (lote só de notificações).
 */
export async function tratarPayload(
  body: unknown,
  tenantId: string,
  sessionId: string,
): Promise<Record<string, unknown> | Array<Record<string, unknown>> | null> {
  if (Array.isArray(body)) {
    if (!body.length) {
      return erro(null, { code: INVALID_REQUEST, message: 'lote_vazio' });
    }
    const respostas: Array<Record<string, unknown>> = [];
    for (const m of body) {
      const r = await tratarMensagem(m, tenantId, sessionId);
      if (r) respostas.push(r);
    }
    return respostas.length ? respostas : null;
  }
  return tratarMensagem(body, tenantId, sessionId);
}

export const _internos = { PARSE_ERROR, INVALID_REQUEST, INTERNAL_ERROR, erro, SERVER_INFO };
