/**
 * Inbox orchestrator — handles inbound messages from any channel.
 *
 * Responsibilities:
 *   1. Identify channel by webhook secret (validates ownership)
 *   2. Upsert contact based on phone (creates if new)
 *   3. Find or create an "open" card for the contact (in default board)
 *   4. Download media (if any) → save to disk → store URL in activity
 *   5. Log message_in activity to the timeline
 *   6. Mark as read (best-effort, non-blocking)
 *   7. Update channel.lastInboundAt
 */

import * as store from './store.js';
import { getCrmDb } from './schema.js';
import * as meta from './channels/meta.js';
import * as evolution from './channels/evolution.js';
import { saveMedia } from './media.js';
import * as automations from './automations.js';
import { applyTagSystem, cardHasTag } from './agents/tools/tags.js';
import { logger } from '../utils/logger.js';
import type { Channel2, Activity, MediaType, Channel, ChannelType } from './types.js';

export interface InboundResult {
  ok: boolean;
  contactId?: string;
  cardId?: string;
  activityId?: string;
  error?: string;
}

/** URLs do WhatsApp (pps.whatsapp.net) tem oe=<hex> no query — timestamp UNIX
 *  hex de quando a URL expira. Sem refresh, foto some do CRM em ~7 dias.
 *  Retorna true se URL nao tem oe (formato desconhecido) ou ja venceu. */
function isAvatarExpired(url: string): boolean {
  const m = url.match(/[?&]oe=([A-F0-9]+)/i);
  if (!m) return false; // formato desconhecido — nao mexe
  const expiresMs = parseInt(m[1]!, 16) * 1000;
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs < Date.now();
}

/**
 * Process a single inbound message from any channel.
 * Idempotent on providerMessageId — if same message arrives twice, we skip.
 */
/**
 * Rotulo de origem gravado na timeline.
 *
 * Era um ternario `meta ? 'whatsapp_meta' : 'whatsapp_zapi'`, que com a
 * chegada da Evolution passou a MENTIR: toda mensagem dela seria registrada
 * como Z-API, e um relatorio por canal ficaria errado sem ninguem perceber.
 */
function rotuloDoCanal(tipo: ChannelType): Channel {
  if (tipo === 'meta') return 'whatsapp_meta';
  return 'whatsapp_evolution';
}

/**
 * Rótulo por tipo, para quem chama sem passar um.
 *
 * O canal Evolution manda o rótulo pronto pelo normalizador, que sabe
 * distinguir figurinha de imagem e nomear o arquivo do documento. Este aqui
 * atende os outros caminhos de ingestão (Meta, criação manual, testes), onde
 * só o tipo é conhecido.
 */
function rotuloPadrao(tipo: MediaType): string {
  switch (tipo) {
    case 'audio': return '🎤 Áudio';
    case 'image': return '[imagem]';
    case 'video': return '[vídeo]';
    case 'document': return '📄 Documento';
    case 'location': return '📍 Localização';
    case 'interactive': return '[mensagem interativa]';
    default: return '[mensagem não suportada]';
  }
}

export async function ingestInbound(channel: Channel2, msg: {
  fromPhone: string;
  fromName?: string;
  messageId: string;
  type: MediaType;
  text?: string;
  caption?: string;
  mediaId?: string; // Meta only (id, must download via API)
  mediaUrl?: string; // Z-API only (direct URL)
  mediaMime?: string;
  mediaFilename?: string;
  context?: { messageId?: string };
  /** Descrição do que a mensagem era, usada só quando não há texto nem mídia. */
  rotulo?: string;
  timestamp: number;
  fromMe?: boolean; // Onda 61: Z-API ecoa msg que o corretor digitou no app/WA Web do numero conectado
}): Promise<InboundResult> {
  const tenantId = channel.tenantId;

  // 1. Idempotency: skip if we already logged this provider message id
  if (msg.messageId && wasAlreadyLogged(tenantId, msg.messageId)) {
    return { ok: true, error: 'duplicate_skipped' };
  }

  // Guarda de contrato: `fromName` só pode descrever a pessoa do outro lado.
  // Numa mensagem `fromMe` o provedor manda o nome da conta que escreveu (o
  // corretor), e gravar isso renomearia o contato do cliente com o nome do
  // operador do CRM. O parser da Evolution já não preenche o campo nesse
  // caso; repetir a checagem aqui protege os outros caminhos de ingestão
  // (Meta, criação manual, agente, automação, import) de reintroduzir o bug.
  const nomeDoContato = msg.fromMe ? undefined : msg.fromName;

  // 2. Upsert contact
  const contact = store.upsertContactByPhone(tenantId, msg.fromPhone, {
    name: nomeDoContato,
    source: rotuloDoCanal(channel.type),
  });

  // 2.1. Sincroniza a foto de perfil sozinho — sem avatar, ou com o link do
  // WhatsApp já vencido (ver isAvatarExpired). Fire-and-forget: é uma chamada
  // de rede pra fora, não pode atrasar o ACK do webhook. Só a Evolution tem
  // esse endpoint hoje; Meta usa outra API e fica pra depois se precisar.
  if (!msg.fromMe && channel.type === 'evolution' && (!contact.avatarUrl || isAvatarExpired(contact.avatarUrl))) {
    void (async () => {
      try {
        const evolution = await import('./channels/evolution.js');
        const picUrl = await evolution.fetchProfilePicture(channel, msg.fromPhone);
        if (picUrl && picUrl !== contact.avatarUrl) {
          store.updateContact(tenantId, contact.id, { avatarUrl: picUrl });
          const { publish } = await import('./events.js');
          publish(tenantId, 'contact.avatar', { contactId: contact.id, avatarUrl: picUrl });
        }
      } catch { /* best-effort, silencioso */ }
    })();
  }

  // 3. Find or create card on the default sales board
  //
  // O título sai do contato já resolvido, não de `fromName` cru: quando o
  // corretor inicia a conversa pelo celular, `fromName` traz o nome dele, e
  // um card novo nasceria batizado com o nome do próprio operador. `contact`
  // acima já é o registro certo do cliente — se ele ainda não tem nome,
  // `upsertContactByPhone` usa o telefone, que é o fallback correto.
  const card = await findOrCreateOpenCardForContact(tenantId, contact.id, contact.name || msg.fromPhone, channel);

  // 4. Download/save media if applicable
  let mediaUrl: string | undefined;
  let savedFilename: string | undefined;
  if (msg.type !== 'text' && msg.type !== 'location' && msg.type !== 'interactive') {
    const result = await downloadAndSave(channel, msg, tenantId);
    if (result) {
      mediaUrl = result.publicUrl;
      savedFilename = result.filename;
    }
  }

  // 5. Build activity content (visible string for timeline preview)
  // Onda 51: caption agora vai PURO (sem prefixo [Imagem]) — frontend
  // renderiza media + caption separadamente.
  let content = '';
  if (msg.type === 'text' || msg.type === 'interactive') {
    content = msg.text || '';
  } else if (msg.type === 'location') {
    content = `[Localização compartilhada]`;
  } else {
    // Pra media: se tem caption, content = caption puro (mostra abaixo da media)
    // Se nao tem caption, content vazio (so a media renderiza)
    content = msg.caption || '';
  }

  // Rede de segurança: chegou aqui sem texto E sem mídia salva, o balão sai
  // com o horário e nada dentro — foi o que aconteceu com conversas inteiras
  // feitas só de áudio. Acontece quando `downloadAndSave` não conseguiu o
  // binário (a Evolution só entrega mídia com S3 ligado; sem isso a `url` do
  // payload aponta para o arquivo criptografado do WhatsApp e não serve) ou
  // quando o formato não tem conteúdo textual nenhum, como uma figurinha.
  //
  // O rótulo diz o que a mensagem era. Não substitui conteúdo: só entra
  // quando não há absolutamente nada para mostrar.
  if (!content && !mediaUrl) {
    content = msg.rotulo || rotuloPadrao(msg.type);
  }

  // 6. Log activity
  // Onda 61: fromMe=true → corretor enviou direto pelo app/WA Web do numero
  // conectado. Loga como message_out / direction:'out' pra aparecer no
  // history do CRM. Idempotencia (passo 1) ja absorve eco de envio via API.
  const isOutbound = msg.fromMe === true;
  const activity = store.logActivity(tenantId, {
    cardId: card?.id, contactId: contact.id,
    type: isOutbound ? 'message_out' : 'message_in',
    channel: rotuloDoCanal(channel.type),
    direction: isOutbound ? 'out' : 'in',
    content,
    mediaUrl,
    mediaType: msg.type,
    providerMessageId: msg.messageId,
    metadata: {
      channelId: channel.id,
      channelName: channel.name,
      ...(isOutbound ? { toPhone: msg.fromPhone, sentFromDevice: true } : { fromPhone: msg.fromPhone }),
      timestamp: msg.timestamp,
      ...(msg.context ? { replyToMessageId: msg.context.messageId } : {}),
      ...(savedFilename ? { savedFilename } : {}),
    },
  });

  // 6.0. Transcreve o áudio e troca o rótulo pelo que foi dito.
  //
  // Fica fora do caminho do ACK de propósito: o whisper leva de segundos a
  // um minuto, e a Evolution reentrega o webhook se demorarmos a responder —
  // o que geraria a mesma mensagem de novo. A conversa recebe "🎤 Áudio"
  // imediatamente e o texto entra no lugar quando fica pronto, via SSE.
  if (msg.type === 'audio' && (mediaUrl || msg.mediaUrl)) {
    void (async () => {
      try {
        const { transcribeAudio } = await import('./ai/agent.js');
        const texto = await transcribeAudio(msg.mediaUrl || mediaUrl!);
        if (!texto) return;
        // O emoji fica: quem lê a conversa precisa continuar sabendo que
        // aquilo foi falado, não digitado.
        store.updateActivityContent(tenantId, activity.id, `🎤 ${texto}`);
        logger.info(`[whisper] áudio transcrito (${texto.length} caracteres) — atividade ${activity.id}`);
      } catch (err: any) {
        logger.warn('[whisper] transcrição falhou:', err?.message);
      }
    })();
  }

  // 6.1. Classifica primeira inbound do card como lead_pago ou lead_aleatorio.
  //      Lead pago vem do Click-to-Chat com texto "✅ Plano Familia/Individual - Clique Aqui".
  //      Set-once por card: nao reclassifica se ja tem qualquer das duas tags.
  if (
    card &&
    !isOutbound &&
    msg.type === 'text' &&
    (msg.text || '').trim() &&
    !cardHasTag(card.id, 'lead_pago') &&
    !cardHasTag(card.id, 'lead_aleatorio')
  ) {
    const isLeadPago = /plano\s+(famil[íi]a|individual).*clique\s+aqui/i.test(msg.text!);
    applyTagSystem(card.id, isLeadPago ? 'lead_pago' : 'lead_aleatorio');
  }

  // 7. Update channel last inbound (non-critical) — só pra direction=in
  if (!isOutbound) {
    try {
      store.updateChannel(tenantId, channel.id, { lastInboundAt: Date.now(), status: 'active' });
    } catch { /* noop */ }
  }

  // 8. Mark as read (best-effort, async) — só pra inbound real
  if (!isOutbound) {
    if (channel.type === 'meta') {
      void meta.markAsRead(channel, msg.messageId);
    } else if (channel.type === 'evolution') {
      void evolution.markAsRead(channel, msg.messageId, msg.fromPhone);
    }
  }

  void automations.emit({
    trigger: isOutbound ? 'outbound_message' : 'inbound_message',
    tenantId, cardId: card?.id, contactId: contact.id, activityId: activity.id,
    text: msg.text || msg.caption || '',
  });

  // Nao precisa publicar 'message.in' aqui: store.logActivity() (chamado
  // acima) ja faz isso sozinho, com payload mais completo (unreadCount,
  // columnId, push mobile) — ver src/crm/store/cardsStore.ts.
  return { ok: true, contactId: contact.id, cardId: card?.id, activityId: activity.id };
}

/** Check if a provider message id was already logged in the last 7 days. */
function wasAlreadyLogged(tenantId: string, providerMessageId: string): boolean {
  const acts = store.listActivitiesByContact(tenantId, '__never__', 0); // tiny query, just for db ref
  // Direct check via DB — store doesn't expose raw query, do via list scan as fallback
  // Cleaner: dedicated lookup
  return checkProviderId(tenantId, providerMessageId);
}

function checkProviderId(tenantId: string, pid: string): boolean {
  const db = getCrmDb();
  const r = db.prepare(`
    SELECT 1 FROM crm_activities WHERE tenant_id = ? AND provider_message_id = ? LIMIT 1
  `).get(tenantId, pid);
  return !!r;
}

/**
 * Find an "open" card for the contact (one that's not in a terminal column).
 * If none exists, create a fresh one on the first non-terminal column of the
 * default sales board.
 */
async function findOrCreateOpenCardForContact(tenantId: string, contactId: string, displayTitle: string, channel?: any) {
  // Onda 42: respeitar config do channel
  // - Se channel.auto_create_cards === 0, nao criar; so retornar card existente
  // - Se channel.inbox_column_id setado, criar card LA (mesmo se contato ja tem card em outra coluna)
  const channelTargetColumn = channel?.inboxColumnId || channel?.inbox_column_id;
  const channelTargetBoard = channel?.inboxBoardId || channel?.inbox_board_id;
  const autoCreate = channel ? (channel.autoCreateCards !== false && channel.auto_create_cards !== 0) : true;

  const cards = store.listCardsByContact(tenantId, contactId);

  // Se channel forca uma coluna especifica, verificar se ja existe card naquela coluna
  if (channelTargetColumn) {
    const existing = cards.find(c => c.columnId === channelTargetColumn);
    if (existing) return existing;
  } else {
    // Padrao: reutilizar qualquer card em coluna nao-terminal
    for (const card of cards) {
      const cols = store.listColumns(tenantId, card.boardId);
      const col = cols.find(c => c.id === card.columnId);
      if (col && !col.isTerminal) return card;
    }
  }

  if (!autoCreate) return null;

  // Criar card novo
  let boardId = channelTargetBoard;
  let columnId = channelTargetColumn;

  if (!boardId || !columnId) {
    const boards = store.listBoards(tenantId);
    let board = boards.find(b => b.type === 'sales') || boards[0];
    if (!board) board = store.seedDefaultBoards(tenantId);
    boardId = board.id;
    const cols = store.listColumns(tenantId, board.id);
    // Preferir coluna chamada "Lead", "Lead novo", "Novo" ou primeira nao-terminal
    const leadCol = cols.find(c => /^lead(\s|$)/i.test(c.name) || /^novo/i.test(c.name)) || cols.find(c => !c.isTerminal) || cols[0];
    if (!leadCol) return null;
    columnId = leadCol.id;
  }

  // Onda 45: novos leads inbound aparecem no TOPO da coluna (position = MIN-1)
  const { getCrmDb } = await import('./schema.js');
  const dbForPos = getCrmDb();
  const minPosRow = dbForPos.prepare('SELECT COALESCE(MIN(position), 0) as m FROM crm_cards WHERE column_id = ?').get(columnId) as { m: number };
  const topPosition = (minPosRow?.m ?? 0) - 1;
  return store.createCard(tenantId, {
    boardId, columnId, title: displayTitle, contactId,
    position: topPosition,
  });
}

async function downloadAndSave(channel: Channel2, msg: any, tenantId: string) {
  let bytes: Buffer | undefined;
  let mime = msg.mediaMime;
  try {
    if (channel.type === 'meta' && msg.mediaId) {
      const res = await meta.fetchMedia(channel, msg.mediaId);
      if (!res.ok) return null;
      bytes = res.bytes;
      mime = res.mime || mime;
    } else if (channel.type === 'evolution' && msg.mediaUrl) {
      const res = await evolution.fetchMedia(channel, msg.mediaUrl);
      if (!res.ok) return null;
      bytes = res.bytes;
      mime = res.mime || mime;
    }
  } catch { return null; }
  if (!bytes) return null;
  return saveMedia(tenantId, bytes, {
    mime, mediaType: msg.type as MediaType, suggestedFilename: msg.mediaFilename,
  });
}

// ─── OUTBOUND: send + log ───────────────────────────────────────────────
export interface SendInbox {
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'audio' | 'document' | 'video';
  mediaFilename?: string;
  caption?: string;
  cardId?: string;
  contactId?: string;
  agentId?: string;
  replyToMessageId?: string;
}

export interface SendInboxResult {
  ok: boolean;
  messageId?: string;
  activityId?: string;
  error?: string;
}

export async function sendOutbound(channel: Channel2, opts: SendInbox): Promise<SendInboxResult> {
  const tenantId = channel.tenantId;
  let result: { ok: boolean; messageId?: string; error?: any };
  // Despacho explicito por tipo. Antes era `meta ? meta : zapi`, e um `else`
  // que engole todo tipo novo e uma bomba-relogio: a Evolution seria enviada
  // pelo cliente do Z-API, com credenciais de formato completamente diferente,
  // e o erro apareceria como uma falha de envio sem explicacao.
  if (channel.type === 'meta') {
    result = await meta.sendMessage(channel, opts);
  } else if (channel.type === 'evolution') {
    result = await evolution.sendMessage(channel, opts);
  } else {
    return { ok: false, error: `canal_desconhecido: ${channel.type}` };
  }
  if (!result.ok) {
    return { ok: false, error: result.error?.message || 'send_failed' };
  }

  // Resolve contact (by phone if not provided)
  let contactId = opts.contactId;
  if (!contactId) {
    const c = store.findContactByPhone(tenantId, opts.to);
    if (c) contactId = c.id;
    else {
      const created = store.createContact(tenantId, { name: opts.to, phone: opts.to, source: 'outbound' });
      contactId = created.id;
    }
  }

  // Build content preview
  let content = opts.text || '';
  if (!content && opts.mediaType) {
    content = `[${opts.mediaType}]${opts.caption ? ': ' + opts.caption : ''}`;
  }

  const activity = store.logActivity(tenantId, {
    cardId: opts.cardId, contactId,
    type: 'message_out',
    channel: rotuloDoCanal(channel.type),
    direction: 'out',
    content,
    mediaUrl: opts.mediaUrl,
    mediaType: opts.mediaType as MediaType,
    providerMessageId: result.messageId,
    createdByAgentId: opts.agentId,
    metadata: { channelId: channel.id, channelName: channel.name, toPhone: opts.to },
  });
  void automations.emit({ trigger: 'outbound_message', tenantId, cardId: opts.cardId, contactId, activityId: activity.id, text: opts.text || '' });
  return { ok: true, messageId: result.messageId, activityId: activity.id };
}
