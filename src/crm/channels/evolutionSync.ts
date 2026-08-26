/**
 * Reconciliação Evolution → CRM.
 *
 * ── Por que isto existe ──────────────────────────────────────────────────
 *
 * Até 25/08/2026 a conversa do CRM era um espelho ao vivo do webhook e nada
 * mais: mensagem cujo webhook não chegasse na hora estava perdida para sempre.
 * Não havia como o CRM sequer descobrir que ela existiu.
 *
 * Isso apareceu como conversa incompleta. Medido na época: 351 de 1.765
 * mensagens (20%) faltando no CRM, sendo 256 áudios e 76 fotos que o corretor
 * mandou do próprio aparelho. A causa era a Evolution 2.3.7 abortar o handler
 * de `messages.upsert` — um `return` silencioso dentro do bloco do S3, antes
 * do `sendDataWebhook` — quando não conseguia extrair o binário da mídia. Essa
 * causa foi removida desligando o S3 (ver deploy/docker-compose.evolution.yml).
 *
 * Só que aquele bug era uma das formas de perder webhook, não a única. Restart
 * do processo, deploy, queda de conexão da instância e timeout de rede
 * produzem exatamente o mesmo estrago, e continuariam produzindo. Este job
 * fecha a categoria inteira: a cada poucos minutos ele compara o que a
 * Evolution registrou com o que o CRM tem, e ingere a diferença.
 *
 * ── Como se mantém seguro ────────────────────────────────────────────────
 *
 * A ingestão passa pelo mesmo `ingestInbound` do webhook, que já descarta
 * `provider_message_id` repetido. Rodar duas vezes na mesma janela não duplica
 * nada. O pré-filtro em lote existe só para não gastar rede buscando mídia de
 * mensagem que já está lá.
 *
 * O agente de IA NÃO é disparado por aqui de propósito. Quem chama
 * `handleInboundForAI` é o handler do webhook; se a reconciliação também
 * chamasse, uma mensagem que chegasse pelos dois caminhos poderia render duas
 * respostas ao cliente. Automação e push continuam ligados: uma mensagem que o
 * webhook perdeu deveria ter passado por eles de qualquer forma.
 */
import * as store from '../store.js';
import { getCrmDb } from '../schema.js';
import { ingestInbound } from '../inbox.js';
import { logger } from '../../utils/logger.js';
import * as evolution from './evolution.js';
import type { Channel2 } from '../types.js';

/** Janela padrão de cada passada. Folga generosa sobre o intervalo do tick. */
export const JANELA_PADRAO_MS = 15 * 60_000;

/**
 * Teto da janela.
 *
 * A reconciliação dispara automação e push como se a mensagem tivesse acabado
 * de chegar. Isso é o certo para o que o webhook perdeu minutos atrás, e é
 * errado para conversa de semanas atrás — ninguém quer uma enxurrada de push
 * de mensagem antiga porque alguém pediu uma janela larga. Quem precisar de
 * resgate histórico faz uma passada dedicada, com o silenciamento pensado.
 */
export const JANELA_MAX_MS = 6 * 3600_000;

/** Quantos registros por página pedir à Evolution. */
const PAGINA = 200;

/** Trava contra passadas concorrentes no mesmo processo. */
let _rodando = false;

export interface ResultadoSync {
  canal: string;
  lidas: number;
  faltando: number;
  ingeridas: number;
  midiaRecuperada: number;
  /** Alertas de não lida apagados por já estarem lidos no aparelho. */
  alertasLimpos: number;
  erro?: string;
}

/**
 * Dos ids informados, quais já existem como atividade deste tenant.
 *
 * Em lote porque o caso normal é "nenhuma faltando": uma consulta resolve a
 * passada inteira, em vez de uma por mensagem.
 */
function idsJaRegistrados(tenantId: string, ids: string[]): Set<string> {
  const achados = new Set<string>();
  if (!ids.length) return achados;
  const db = getCrmDb();
  // SQLite tem teto de variáveis por statement (999 por padrão); fatiar
  // mantém a consulta válida mesmo numa janela cheia.
  const LOTE = 400;
  for (let i = 0; i < ids.length; i += LOTE) {
    const fatia = ids.slice(i, i + LOTE);
    const marcadores = fatia.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT provider_message_id AS pid FROM crm_activities
        WHERE tenant_id = ? AND provider_message_id IN (${marcadores})`,
    ).all(tenantId, ...fatia) as Array<{ pid: string }>;
    for (const r of rows) achados.add(r.pid);
  }
  return achados;
}

/**
 * Reconcilia um canal Evolution.
 *
 * `desdeMs` é o tamanho da janela olhando para trás, não um instante.
 */
export async function syncChannel(
  channel: Channel2,
  opts: { desdeMs?: number } = {},
): Promise<ResultadoSync> {
  const base: ResultadoSync = {
    canal: channel.id, lidas: 0, faltando: 0, ingeridas: 0, midiaRecuperada: 0, alertasLimpos: 0,
  };
  if (channel.type !== 'evolution') return { ...base, erro: 'canal_nao_evolution' };

  // Antes da reconciliação de mensagens, e fora dos `return` adiantados dela:
  // o alerta preso precisa ser acertado mesmo numa janela sem mensagem
  // nenhuma faltando — que é justamente o caso normal.
  try {
    base.alertasLimpos = await syncReadState(channel);
  } catch (err: any) {
    logger.warn(`[evolution-read] canal ${channel.id} falhou:`, err?.message);
  }

  const janela = Math.min(opts.desdeMs ?? JANELA_PADRAO_MS, JANELA_MAX_MS);
  const lte = Date.now();
  const gte = lte - janela;

  // 1. Lê a janela inteira da Evolution, paginando.
  const registros: any[] = [];
  let page = 1;
  for (;;) {
    const r = await evolution.findMessages(channel, { gte, lte, page, offset: PAGINA });
    if (!r.ok) return { ...base, erro: r.error };
    registros.push(...r.records);
    if (page >= r.pages || r.records.length === 0) break;
    page++;
    // Guarda contra uma janela absurdamente cheia monopolizar o tick.
    if (page > 25) break;
  }
  base.lidas = registros.length;
  if (!registros.length) return base;

  // 2. Traduz pelo mesmo parser do webhook. Grupo, evento de protocolo e
  //    formato sem conteúdo já saem filtrados de lá.
  const { messages } = evolution.parseWebhook({ event: 'messages.upsert', data: registros });
  if (!messages.length) return base;

  // 3. Descarta o que o CRM já tem.
  const jaTem = idsJaRegistrados(channel.tenantId, messages.map((m) => m.messageId).filter(Boolean));
  const faltando = messages.filter((m) => m.messageId && !jaTem.has(m.messageId));
  base.faltando = faltando.length;
  if (!faltando.length) return base;

  logger.info(
    `[evolution-sync] canal ${channel.id}: ${faltando.length} de ${messages.length} ausentes ` +
    `na janela de ${Math.round(janela / 60_000)}min`,
  );

  // 4. Ingere. Sequencial de propósito: são poucas mensagens no caso normal, e
  //    o card/contato é criado sob demanda — duas ingestões simultâneas do
  //    mesmo contato novo disputariam a criação do mesmo card.
  for (const msg of faltando) {
    try {
      // `findMessages` não traz base64. Sem isto a mídia viraria balão com
      // rótulo e sem player, que é o sintoma que este job existe para acabar.
      if (msg.type !== 'text' && msg.type !== 'location' && msg.type !== 'interactive') {
        // `raw` é o registro cru da Evolution — `unknown` no contrato, porque
        // cada provedor põe uma coisa diferente ali.
        const jid = (msg.raw as any)?.key?.remoteJid as string | undefined;
        if (jid) {
          const bin = await evolution.fetchMediaByKey(channel, {
            id: msg.messageId,
            remoteJid: jid,
            fromMe: msg.fromMe,
          });
          if (bin) {
            const mime = bin.mime || msg.mediaMime || 'application/octet-stream';
            msg.mediaUrl = `data:${mime};base64,${bin.base64}`;
            msg.mediaMime = mime;
            base.midiaRecuperada++;
          }
        }
      }
      await ingestInbound(channel, msg);
      base.ingeridas++;
    } catch (err: any) {
      logger.warn(`[evolution-sync] falha ao ingerir ${msg.messageId}:`, err?.message);
    }
  }

  return base;
}

/**
 * Apaga o alerta dos cards cujas mensagens acabaram de ser lidas no aparelho.
 *
 * Chamada pelo handler do webhook, no caminho rápido: o recibo chega segundos
 * depois de a conversa ser aberta no celular, e o alerta some na tela sem
 * esperar o tick. `syncReadState` cobre o que este caminho perder.
 *
 * Devolve quantos cards mudaram — zero é normal e silencioso: recibo de
 * mensagem que o CRM não ingeriu, ou de card já lido, não tem o que fazer.
 */
export function aplicarRecibosDeLeitura(channel: Channel2, messageIds: string[]): number {
  let limpos = 0;
  for (const id of messageIds) {
    try {
      const cardId = store.findCardIdByProviderMessageId(channel.tenantId, id);
      if (cardId && store.markCardRead(channel.tenantId, cardId)) limpos++;
    } catch (err: any) {
      logger.warn(`[evolution-read] recibo ${id} falhou:`, err?.message);
    }
  }
  return limpos;
}

/**
 * Reconcilia o alerta de não lida contra o estado real do WhatsApp.
 *
 * O recibo de leitura do webhook é o caminho rápido, e como todo webhook ele
 * se perde: restart, deploy, instância caída, timeout. Esta passada fecha a
 * categoria do mesmo jeito que a reconciliação de mensagens fecha a dela — a
 * cada tick, o que o aparelho considera lido e o CRM ainda considera não lido
 * é acertado.
 *
 * Só apaga alerta, nunca acende: um card lido aqui dentro continua lido mesmo
 * que o WhatsApp ainda conte não lidas do lado dele. E só apaga quando a
 * conversa aparece na lista com contador ZERO — conversa ausente da lista, ou
 * telefone que casa com mais de uma conversa e alguma delas ainda tem não
 * lida, fica como está. Na dúvida o alerta permanece: alerta a mais custa um
 * clique, alerta a menos custa um lead sem resposta.
 */
export async function syncReadState(channel: Channel2): Promise<number> {
  const pendentes = store.listUnreadCardsWithPhone(channel.tenantId);
  if (!pendentes.length) return 0;

  const r = await evolution.findChats(channel);
  if (!r.ok) {
    logger.warn(`[evolution-read] canal ${channel.id}: não consegui listar conversas — ${r.error}`);
    return 0;
  }

  // Chaveado pelos últimos 10 dígitos, que é o mesmo critério que
  // `findContactByPhone` usa para tolerar variação de DDI/nono dígito. Uma
  // conversa pode aparecer duas vezes (uma em `@lid`, outra em
  // `@s.whatsapp.net`); guarda-se o MAIOR contador, para que uma delas ainda
  // com não lidas impeça o alerta de ser apagado.
  const naoLidasPorTelefone = new Map<string, number>();
  for (const chat of r.chats) {
    const chave = chat.phone.slice(-10);
    naoLidasPorTelefone.set(chave, Math.max(naoLidasPorTelefone.get(chave) ?? 0, chat.unreadCount));
  }

  let limpos = 0;
  for (const p of pendentes) {
    const chave = p.phone.replace(/\D/g, '').slice(-10);
    const naoLidas = naoLidasPorTelefone.get(chave);
    if (naoLidas !== 0) continue; // ausente da lista (undefined) ou ainda não lida
    if (store.markCardRead(channel.tenantId, p.cardId)) limpos++;
  }
  if (limpos) {
    logger.info(`[evolution-read] canal ${channel.id}: ${limpos} alerta(s) apagado(s) — já lidos no aparelho`);
  }
  return limpos;
}

/**
 * Passada em todos os canais Evolution de todos os tenants.
 *
 * Nunca lança: é chamada de dentro do tick do scheduler, e uma instância
 * desconectada não pode derrubar a reconciliação das outras.
 */
export async function syncAllChannels(opts: { desdeMs?: number } = {}): Promise<ResultadoSync[]> {
  if (_rodando) {
    logger.debug('[evolution-sync] passada anterior ainda rodando — pulando');
    return [];
  }
  _rodando = true;
  const saida: ResultadoSync[] = [];
  try {
    const canais = store.listAllChannels().filter((c) => c.type === 'evolution');
    for (const canal of canais) {
      try {
        saida.push(await syncChannel(canal, opts));
      } catch (err: any) {
        logger.warn(`[evolution-sync] canal ${canal.id} falhou:`, err?.message);
        saida.push({
          canal: canal.id, lidas: 0, faltando: 0, ingeridas: 0, midiaRecuperada: 0, alertasLimpos: 0,
          erro: err?.message || 'erro_desconhecido',
        });
      }
    }
    // Passada com tráfego vira uma linha no log mesmo quando não falta nada.
    // O bug que originou este job passou dias despercebido justamente por não
    // deixar rastro; um vigia contra perda silenciosa que também é silencioso
    // não dá para auditar — ninguém sabe dizer se ele está de pé. Linha só
    // quando houve o que conferir mantém o log quieto na madrugada.
    const lidas = saida.reduce((n, r) => n + r.lidas, 0);
    const recuperadas = saida.reduce((n, r) => n + r.ingeridas, 0);
    const midia = saida.reduce((n, r) => n + r.midiaRecuperada, 0);
    const erros = saida.filter((r) => r.erro);
    const alertas = saida.reduce((n, r) => n + r.alertasLimpos, 0);
    if (lidas || recuperadas || alertas || erros.length) {
      logger.info(
        `[evolution-sync] ${saida.length} canal(is), ${lidas} mensagem(ns) conferida(s), ` +
        `${recuperadas} recuperada(s)${midia ? ` (${midia} com mídia)` : ''}` +
        `${alertas ? `, ${alertas} alerta(s) de não lida apagado(s)` : ''}` +
        `${erros.length ? ` — ${erros.length} canal(is) com erro: ${erros.map((e) => e.erro).join(', ')}` : ''}`,
      );
    }
  } finally {
    _rodando = false;
  }
  return saida;
}
