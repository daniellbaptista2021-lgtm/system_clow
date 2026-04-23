/**
 * CrmTool.ts — AI tools that let the System Clow agent operate the CRM.
 *
 * All tools are tenant-scoped: they read context.tenantId. When called from
 * a multi-tenant session, only that tenant's data is touched.
 *
 * Tools exposed:
 *   - crm_find_or_create_contact
 *   - crm_create_card
 *   - crm_move_card
 *   - crm_add_note
 *   - crm_send_whatsapp
 *   - crm_search
 *   - crm_pipeline
 *   - crm_get_contact
 *   - crm_create_reminder
 *   - crm_dashboard
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext } from '../Tool.js';
import * as crm from '../../crm/store.js';
import { sendOutbound } from '../../crm/inbox.js';

// ─── Helpers ────────────────────────────────────────────────────────────
function tid(ctx: ToolUseContext): string {
  return ctx.tenantId || 'default';
}

function fmtMoney(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ensureBoardForTenant(t: string): { id: string; name: string } {
  const boards = crm.listBoards(t);
  if (boards.length > 0) return { id: boards[0].id, name: boards[0].name };
  const seeded = crm.seedDefaultBoards(t);
  return { id: seeded.id, name: seeded.name };
}

// ════════════════════════════════════════════════════════════════════════
// 1. crm_find_or_create_contact
// ════════════════════════════════════════════════════════════════════════
const FindOrCreateContactSchema = z.object({
  name: z.string().describe('Nome da pessoa (ex: "João Silva")'),
  phone: z.string().optional().describe('Telefone E.164 ou nacional (ex: "5521999991234" ou "21999991234")'),
  email: z.string().optional().describe('Email (opcional)'),
  source: z.string().optional().describe('De onde veio o lead (ex: "Instagram", "indicação", "site")'),
  tags: z.array(z.string()).optional().describe('Tags pra classificar (ex: ["vip", "interesse-premium"])'),
});

export const CrmFindOrCreateContactTool = buildTool<z.infer<typeof FindOrCreateContactSchema>>({
  name: 'crm_find_or_create_contact',
  searchHint: 'crm contact lead create find',
  description: `Busca um contato pelo telefone/email; se não existir, cria um novo. Use isso ANTES de criar cards ou enviar mensagens.
Retorna o contact com id (use esse id em outras tools de CRM).`,
  inputSchema: FindOrCreateContactSchema,
  userFacingName: (i) => i ? `crm_find_or_create_contact(${i.name})` : 'crm_find_or_create_contact',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.name,
  renderToolUseMessage: (i) => `Buscar/criar contato ${i.name}`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    let contact = null;
    if (input.phone) contact = crm.findContactByPhone(t, input.phone);
    if (!contact && input.email) contact = crm.findContactByEmail(t, input.email);
    if (contact) {
      const patch: any = {};
      if (input.tags?.length) patch.tags = [...new Set([...contact.tags, ...input.tags])];
      if (input.source && !contact.source) patch.source = input.source;
      if (Object.keys(patch).length) contact = crm.updateContact(t, contact.id, patch) || contact;
      return {
        output: { contact, created: false },
        outputText: `Contato encontrado: ${contact.name} (${contact.id})${contact.phone ? ', tel ' + contact.phone : ''}`,
      };
    }
    contact = crm.createContact(t, {
      name: input.name, phone: input.phone, email: input.email,
      source: input.source || 'ai', tags: input.tags,
    });
    return {
      output: { contact, created: true },
      outputText: `Novo contato criado: ${contact.name} (${contact.id})${contact.phone ? ', tel ' + contact.phone : ''}`,
    };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 2. crm_create_card
// ════════════════════════════════════════════════════════════════════════
const CreateCardSchema = z.object({
  title: z.string().describe('Título curto do card (ex: "Interessado em plano Premium")'),
  contactId: z.string().optional().describe('ID do contato vinculado (se houver — use crm_find_or_create_contact antes)'),
  columnName: z.string().optional().describe('Nome da coluna alvo (ex: "Lead novo", "Qualificado"). Se omitido, usa primeira coluna do board principal.'),
  boardName: z.string().optional().describe('Nome do board (default: pipeline de vendas)'),
  valueCents: z.number().optional().describe('Valor estimado em centavos (ex: 50000 = R$500)'),
  probability: z.number().min(0).max(100).optional().describe('Probabilidade de fechar 0-100'),
  labels: z.array(z.string()).optional().describe('Labels (ex: ["urgente", "B2B"])'),
  description: z.string().optional().describe('Detalhes longos do lead'),
  dueDateDaysFromNow: z.number().optional().describe('Vencimento N dias no futuro'),
});

export const CrmCreateCardTool = buildTool<z.infer<typeof CreateCardSchema>>({
  name: 'crm_create_card',
  searchHint: 'crm card deal opportunity create',
  description: `Cria um novo card (lead/deal) no kanban do CRM. Pode escolher coluna por nome.
Retorna card.id pra uso em outras tools.`,
  inputSchema: CreateCardSchema,
  userFacingName: (i) => i ? `crm_create_card(${i.title})` : 'crm_create_card',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.title,
  renderToolUseMessage: (i) => `Criar card "${i.title}"`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    const boards = crm.listBoards(t);
    let board = input.boardName
      ? boards.find(b => b.name.toLowerCase().includes(input.boardName!.toLowerCase()))
      : boards.find(b => b.type === 'sales') || boards[0];
    if (!board) board = crm.seedDefaultBoards(t);

    const cols = crm.listColumns(t, board.id);
    let col = input.columnName
      ? cols.find(c => c.name.toLowerCase().includes(input.columnName!.toLowerCase()))
      : cols.find(c => !c.isTerminal) || cols[0];
    if (!col) {
      return { output: null, outputText: 'Erro: nenhuma coluna disponível no board.', isError: true };
    }

    const card = crm.createCard(t, {
      boardId: board.id,
      columnId: col.id,
      title: input.title,
      contactId: input.contactId,
      valueCents: input.valueCents ?? 0,
      probability: input.probability ?? 50,
      labels: input.labels ?? [],
      description: input.description,
      dueDate: input.dueDateDaysFromNow ? Date.now() + input.dueDateDaysFromNow * 86400_000 : undefined,
    });
    if (!card) {
      return { output: null, outputText: 'Erro: não foi possível criar o card.', isError: true };
    }
    return {
      output: { card, board: { id: board.id, name: board.name }, column: { id: col.id, name: col.name } },
      outputText: `Card "${card.title}" criado em "${board.name} > ${col.name}" (id: ${card.id}${card.valueCents ? ', valor ' + fmtMoney(card.valueCents) : ''})`,
    };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 3. crm_move_card
// ════════════════════════════════════════════════════════════════════════
const MoveCardSchema = z.object({
  cardId: z.string().describe('ID do card a mover'),
  toColumnName: z.string().describe('Nome da coluna destino (ex: "Qualificado", "Ganho", "Perdido")'),
});

export const CrmMoveCardTool = buildTool<z.infer<typeof MoveCardSchema>>({
  name: 'crm_move_card',
  searchHint: 'crm move kanban stage progress',
  description: 'Move um card pra outra coluna no kanban. Use o NOME da coluna (ex: "Qualificado", "Ganho").',
  inputSchema: MoveCardSchema,
  userFacingName: (i) => i ? `crm_move_card(${i.cardId} → ${i.toColumnName})` : 'crm_move_card',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.cardId,
  renderToolUseMessage: (i) => `Mover ${i.cardId} → ${i.toColumnName}`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    const card = crm.getCard(t, input.cardId);
    if (!card) return { output: null, outputText: `Card ${input.cardId} não encontrado.`, isError: true };
    const cols = crm.listColumns(t, card.boardId);
    const target = cols.find(c => c.name.toLowerCase() === input.toColumnName.toLowerCase())
      || cols.find(c => c.name.toLowerCase().includes(input.toColumnName.toLowerCase()));
    if (!target) {
      return {
        output: null,
        outputText: `Coluna "${input.toColumnName}" não encontrada. Disponíveis: ${cols.map(c => c.name).join(', ')}`,
        isError: true,
      };
    }
    if (target.id === card.columnId) {
      return { output: { card }, outputText: `Card já está na coluna "${target.name}".` };
    }
    const moved = crm.moveCard(t, input.cardId, target.id);
    return {
      output: { card: moved },
      outputText: `Card "${card.title}" movido pra "${target.name}".`,
    };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 4. crm_add_note
// ════════════════════════════════════════════════════════════════════════
const AddNoteSchema = z.object({
  content: z.string().describe('Conteúdo da nota (ex: "Cliente pediu desconto, oferecer 10%")'),
  cardId: z.string().optional().describe('ID do card pra anexar a nota'),
  contactId: z.string().optional().describe('ID do contato pra anexar (se sem card)'),
});

export const CrmAddNoteTool = buildTool<z.infer<typeof AddNoteSchema>>({
  name: 'crm_add_note',
  searchHint: 'crm note comment annotation timeline',
  description: 'Adiciona uma nota na timeline de um card ou contato. Use pra registrar insights, decisões, próximos passos.',
  inputSchema: AddNoteSchema,
  userFacingName: () => 'crm_add_note',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.content.slice(0, 80),
  renderToolUseMessage: (i) => `Nota: "${i.content.slice(0, 50)}..."`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    if (!input.cardId && !input.contactId) {
      return { output: null, outputText: 'Erro: forneça cardId ou contactId.', isError: true };
    }
    const a = crm.logActivity(t, {
      cardId: input.cardId, contactId: input.contactId,
      type: 'note', channel: 'ai', content: input.content,
    });
    return { output: { activity: a }, outputText: `Nota registrada (${a.id}).` };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 5. crm_send_whatsapp
// ════════════════════════════════════════════════════════════════════════
const SendWhatsAppSchema = z.object({
  contactId: z.string().optional().describe('ID do contato (preferido — usa o phone do contato)'),
  toPhone: z.string().optional().describe('Telefone alternativo se não tiver contactId'),
  text: z.string().optional().describe('Texto da mensagem'),
  mediaUrl: z.string().optional().describe('URL pública de mídia (image/audio/video/document)'),
  mediaType: z.enum(['image', 'audio', 'video', 'document']).optional(),
  channelId: z.string().optional().describe('ID do canal específico (default: primeiro canal ativo)'),
  cardId: z.string().optional().describe('Card pra anexar a mensagem na timeline'),
});

export const CrmSendWhatsAppTool = buildTool<z.infer<typeof SendWhatsAppSchema>>({
  name: 'crm_send_whatsapp',
  searchHint: 'crm whatsapp send message message text reply',
  description: `Envia mensagem WhatsApp pelo canal CRM (Meta ou Z-API). Loga automaticamente como message_out na timeline.
Precisa do canal estar configurado em /crm/ (aba Canais).`,
  inputSchema: SendWhatsAppSchema,
  userFacingName: (i) => i ? `crm_send_whatsapp(${i.contactId || i.toPhone})` : 'crm_send_whatsapp',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.text || i.mediaType || 'wa',
  renderToolUseMessage: (i) => `Enviar WhatsApp pra ${i.contactId || i.toPhone}`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    if (!input.text && !input.mediaUrl) {
      return { output: null, outputText: 'Erro: forneça text ou mediaUrl.', isError: true };
    }
    let toPhone = input.toPhone;
    if (input.contactId) {
      const c = crm.getContact(t, input.contactId);
      if (!c) return { output: null, outputText: `Contato ${input.contactId} não encontrado.`, isError: true };
      toPhone = c.phone || toPhone;
    }
    if (!toPhone) {
      return { output: null, outputText: 'Erro: nem contactId.phone nem toPhone fornecidos.', isError: true };
    }
    const channels = crm.listChannels(t).filter(c => c.status !== 'disabled');
    const channel = input.channelId ? channels.find(c => c.id === input.channelId) : channels[0];
    if (!channel) {
      return { output: null, outputText: 'Erro: nenhum canal WhatsApp configurado. Acesse /crm/ → Canais.', isError: true };
    }
    const result = await sendOutbound(channel, {
      to: toPhone, text: input.text, mediaUrl: input.mediaUrl,
      mediaType: input.mediaType, cardId: input.cardId, contactId: input.contactId,
    });
    if (!result.ok) {
      return { output: result, outputText: `Falha ao enviar: ${result.error}`, isError: true };
    }
    return {
      output: result,
      outputText: `Mensagem enviada via ${channel.name} (${channel.type}). messageId: ${result.messageId}`,
    };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 6. crm_search
// ════════════════════════════════════════════════════════════════════════
const SearchSchema = z.object({
  query: z.string().describe('Termo de busca (nome, telefone, email)'),
  limit: z.number().optional().describe('Máx resultados (default 10)'),
});

export const CrmSearchTool = buildTool<z.infer<typeof SearchSchema>>({
  name: 'crm_search',
  searchHint: 'crm search find contact lead lookup',
  description: 'Busca contatos por nome, telefone ou email. Retorna lista resumida.',
  inputSchema: SearchSchema,
  userFacingName: (i) => i ? `crm_search(${i.query})` : 'crm_search',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.query,
  renderToolUseMessage: (i) => `Buscar "${i.query}"`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    const contacts = crm.searchContacts(t, input.query, input.limit ?? 10);
    if (!contacts.length) {
      return { output: { contacts: [] }, outputText: `Nenhum contato encontrado pra "${input.query}".` };
    }
    const lines = contacts.map(c => `  • ${c.name} (${c.id})${c.phone ? ' tel:' + c.phone : ''}${c.email ? ' email:' + c.email : ''}`);
    return {
      output: { contacts },
      outputText: `${contacts.length} contato(s):\n${lines.join('\n')}`,
    };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 7. crm_pipeline
// ════════════════════════════════════════════════════════════════════════
const PipelineSchema = z.object({
  boardName: z.string().optional().describe('Nome do board (default: principal)'),
});

export const CrmPipelineTool = buildTool<z.infer<typeof PipelineSchema>>({
  name: 'crm_pipeline',
  searchHint: 'crm pipeline kanban board overview status',
  description: 'Mostra resumo do kanban: colunas + número de cards + valor total por coluna.',
  inputSchema: PipelineSchema,
  userFacingName: (i) => i?.boardName ? `crm_pipeline(${i.boardName})` : 'crm_pipeline',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.boardName || 'pipeline',
  renderToolUseMessage: (i) => i.boardName ? `Pipeline ${i.boardName}` : 'Pipeline',
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    const boards = crm.listBoards(t);
    let board = input.boardName
      ? boards.find(b => b.name.toLowerCase().includes(input.boardName!.toLowerCase()))
      : boards[0];
    if (!board) board = ensureBoardForTenant(t) as any;
    const cols = crm.listColumns(t, board!.id);
    const cards = crm.listCardsByBoard(t, board!.id);
    const summary = cols.map(col => {
      const colCards = cards.filter(c => c.columnId === col.id);
      const value = colCards.reduce((acc, c) => acc + c.valueCents, 0);
      return { name: col.name, count: colCards.length, valueCents: value };
    });
    const total = cards.reduce((a, c) => a + c.valueCents, 0);
    const weighted = cards.reduce((a, c) => a + c.valueCents * c.probability / 100, 0);
    const lines = summary.map(s => `  ${s.name.padEnd(22)} ${String(s.count).padStart(3)} cards   ${fmtMoney(s.valueCents)}`);
    return {
      output: { board, summary, totalCards: cards.length, totalValueCents: total, weightedValueCents: weighted },
      outputText: `Board "${board!.name}":\n${lines.join('\n')}\n\nTotal: ${cards.length} cards, ${fmtMoney(total)} (forecast ponderado: ${fmtMoney(weighted)})`,
    };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 8. crm_get_contact
// ════════════════════════════════════════════════════════════════════════
const GetContactSchema = z.object({
  contactId: z.string().optional().describe('ID do contato'),
  phone: z.string().optional().describe('Telefone — busca por phone se não tiver ID'),
});

export const CrmGetContactTool = buildTool<z.infer<typeof GetContactSchema>>({
  name: 'crm_get_contact',
  searchHint: 'crm contact details history timeline',
  description: 'Retorna detalhes completos de um contato + cards vinculados + timeline (últimas 30 atividades).',
  inputSchema: GetContactSchema,
  userFacingName: (i) => i ? `crm_get_contact(${i.contactId || i.phone})` : 'crm_get_contact',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.contactId || i.phone || '',
  renderToolUseMessage: (i) => `Detalhes de ${i.contactId || i.phone}`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    let contact = null;
    if (input.contactId) contact = crm.getContact(t, input.contactId);
    if (!contact && input.phone) contact = crm.findContactByPhone(t, input.phone);
    if (!contact) return { output: null, outputText: 'Contato não encontrado.', isError: true };

    const cards = crm.listCardsByContact(t, contact.id);
    const activities = crm.listActivitiesByContact(t, contact.id, 30);

    const cardsLines = cards.map(c => `  • ${c.title} (${c.id}) ${fmtMoney(c.valueCents)} ${c.probability}%`);
    const actLines = activities.slice(-12).map(a => {
      const arrow = a.direction === 'in' ? '←' : a.direction === 'out' ? '→' : '·';
      const when = new Date(a.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
      return `  ${arrow} [${a.type}/${a.channel}] ${when}: ${a.content.slice(0, 80)}`;
    });
    const text = [
      `${contact.name} (${contact.id})`,
      contact.phone ? `Tel: ${contact.phone}` : '',
      contact.email ? `Email: ${contact.email}` : '',
      contact.tags?.length ? `Tags: ${contact.tags.join(', ')}` : '',
      contact.source ? `Origem: ${contact.source}` : '',
      '',
      `${cards.length} card(s):`, ...cardsLines,
      '',
      `${activities.length} atividade(s) — últimas 12:`, ...actLines,
    ].filter(Boolean).join('\n');
    return { output: { contact, cards, activities }, outputText: text };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 9. crm_create_reminder
// ════════════════════════════════════════════════════════════════════════
const CreateReminderSchema = z.object({
  content: z.string().describe('Lembrete (ex: "Ligar pro João sobre proposta")'),
  hoursFromNow: z.number().optional().describe('Disparar em N horas (default: 24)'),
  cardId: z.string().optional(),
  contactId: z.string().optional(),
});

export const CrmCreateReminderTool = buildTool<z.infer<typeof CreateReminderSchema>>({
  name: 'crm_create_reminder',
  searchHint: 'crm reminder followup task notification',
  description: 'Cria um lembrete pra disparar no futuro. Use pra agendar follow-ups.',
  inputSchema: CreateReminderSchema,
  userFacingName: () => 'crm_create_reminder',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => i.content.slice(0, 60),
  renderToolUseMessage: (i) => `Lembrete em ${i.hoursFromNow ?? 24}h: "${i.content.slice(0, 50)}"`,
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    const dueAt = Date.now() + (input.hoursFromNow ?? 24) * 3600_000;
    const r = crm.createReminder(t, {
      content: input.content, dueAt,
      cardId: input.cardId, contactId: input.contactId,
    });
    const when = new Date(dueAt).toLocaleString('pt-BR');
    return { output: r, outputText: `Lembrete criado pra ${when}: "${input.content}"` };
  },
});

// ════════════════════════════════════════════════════════════════════════
// 10. crm_dashboard
// ════════════════════════════════════════════════════════════════════════
const DashboardSchema = z.object({});

export const CrmDashboardTool = buildTool<z.infer<typeof DashboardSchema>>({
  name: 'crm_dashboard',
  searchHint: 'crm dashboard stats summary kpi metrics',
  description: 'Resumo executivo do CRM: total de boards, cards, contatos, valor pipeline, forecast ponderado, agentes, canais.',
  inputSchema: DashboardSchema,
  userFacingName: () => 'crm_dashboard',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: () => 'dashboard',
  renderToolUseMessage: () => 'Dashboard CRM',
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  async call(_input, ctx): Promise<ToolResult> {
    const t = tid(ctx);
    const boards = crm.listBoards(t);
    const allCards = boards.flatMap(b => crm.listCardsByBoard(t, b.id));
    const total = allCards.reduce((a, c) => a + c.valueCents, 0);
    const weighted = allCards.reduce((a, c) => a + c.valueCents * c.probability / 100, 0);
    const contacts = crm.listContacts(t, { limit: 1000 }).length;
    const agents = crm.listAgents(t).length;
    const channels = crm.listChannels(t);
    const subsActive = crm.listSubscriptions(t, 'active').length;
    const text = [
      `📊 CRM Dashboard`,
      `  Boards: ${boards.length}`,
      `  Cards totais: ${allCards.length}`,
      `  Pipeline bruto: ${fmtMoney(total)}`,
      `  Forecast ponderado: ${fmtMoney(weighted)}`,
      `  Contatos: ${contacts}`,
      `  Agentes: ${agents}`,
      `  Canais WA: ${channels.length} (${channels.filter(c => c.status === 'active').length} ativo(s))`,
      `  Assinaturas ativas: ${subsActive}`,
    ].join('\n');
    return {
      output: { boards: boards.length, totalCards: allCards.length, totalValueCents: total, weightedValueCents: weighted, contacts, agents, channels: channels.length, subsActive },
      outputText: text,
    };
  },
});

// ─── Registry: array exposto pra tools.ts ───────────────────────────────
export const CrmTools = [
  CrmFindOrCreateContactTool,
  CrmCreateCardTool,
  CrmMoveCardTool,
  CrmAddNoteTool,
  CrmSendWhatsAppTool,
  CrmSearchTool,
  CrmPipelineTool,
  CrmGetContactTool,
  CrmCreateReminderTool,
  CrmDashboardTool,
];
