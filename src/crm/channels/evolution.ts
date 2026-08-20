/**
 * evolution.ts — canal WhatsApp pela Evolution API.
 *
 * A Evolution é auto-hospedada e gratuita, e conecta o número do próprio
 * cliente lendo um QR — que é o caminho que um corretor consegue percorrer
 * sozinho. A Meta Cloud API exige conta de negócios aprovada, modelos de
 * mensagem homologados e um número que não pode estar em uso no WhatsApp
 * comum.
 *
 * Cada canal WhatsApp no CRM é uma instância na Evolution. `sendMessage`,
 * `parseWebhook`, `fetchMedia` e `fetchConnectedPhone` seguem a interface
 * compartilhada definida em `../types.ts`.
 *
 * ── Características ──────────────────────────────────────────────────────
 *
 * 1. **A instância é nossa, não de fornecedor externo.** O servidor Evolution
 *    roda na nossa infra, e cada cliente é uma "instância" dentro dele.
 * 2. **Autenticação por `apikey` em header.**
 * 3. **O número vem como JID** (`5521999998888@s.whatsapp.net`), não limpo.
 * 4. **Mídia vem em base64 no próprio webhook** quando o servidor está com
 *    `WEBHOOK_BASE64=true`; senão vem uma URL que só a Evolution alcança.
 *    Tratamos os dois.
 */
import { decryptJson } from '../crypto.js';
import { logger } from '../../utils/logger.js';
import { readMedia } from '../media.js';
import type { Channel2, SendOptions, SendResult, ParsedInbound, WebhookValue } from '../types.js';

export interface EvolutionCreds {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

export interface EstadoInstancia {
  existe: boolean;
  conectado: boolean;
  estado?: string;
}

export interface ResultadoParear {
  ok: boolean;
  jaConectado?: boolean;
  qr?: string;
  codigoDeParear?: string;
  erro?: string;
}

function url(creds: EvolutionCreds, caminho: string): string {
  return `${creds.baseUrl.replace(/\/+$/, '')}${caminho}`;
}

function headers(creds: EvolutionCreds): Record<string, string> {
  return { 'Content-Type': 'application/json', apikey: creds.apiKey };
}

function credsDo(channel: Channel2): EvolutionCreds {
  return decryptJson<EvolutionCreds>(channel.credentialsEncrypted);
}

/**
 * Extrai o número de um JID do WhatsApp.
 *
 * O JID vem como `5521999998888@s.whatsapp.net` (pessoa) ou
 * `...@g.us` (grupo). Devolvemos só os dígitos, que é o formato que o resto
 * do CRM usa para casar contato.
 */
export function numeroDoJid(jid: unknown): string {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function ehGrupo(jid: unknown): boolean {
  return typeof jid === 'string' && jid.includes('@g.us');
}

/**
 * Se `mediaUrl` é um link interno nosso (/v1/crm/media/...), a Evolution não
 * tem como buscar: ela roda isolada num container Docker à parte, sem rota
 * até o processo do CRM, e mesmo se tivesse a URL exige um Bearer token que
 * a Evolution não sabe mandar. Resolvemos lendo o arquivo do disco aqui
 * (mesmo host) e mandando o conteúdo em base64 — a Evolution aceita os dois
 * formatos no campo `media`. Link realmente externo (outro CDN) passa direto,
 * já que aí sim é a Evolution buscando por fora, sem passar por nós.
 */
function mediaLocalComoBase64(mediaUrl: string): { base64: string; mime: string } | null {
  const m = mediaUrl.match(/\/v1\/crm\/media\/([\w-]+)\/([\w-]+)\/([\w.-]+)$/);
  if (!m) return null;
  const [, tenantId, date, filename] = m;
  const achado = readMedia(tenantId, date, filename);
  if (!achado) return null;
  return { base64: achado.bytes.toString('base64'), mime: achado.mime };
}

export async function sendMessage(channel: Channel2, opts: SendOptions): Promise<SendResult> {
  const creds = credsDo(channel);
  const numero = opts.to.replace(/\D/g, '');
  if (!numero) return { ok: false, error: { message: 'numero_vazio' } };
  const ehMidia = !!opts.mediaUrl;
  const caminho = ehMidia
    ? `/message/sendMedia/${encodeURIComponent(creds.instance)}`
    : `/message/sendText/${encodeURIComponent(creds.instance)}`;
  const corpo: any = { number: numero };
  if (ehMidia) {
    corpo.mediatype = opts.mediaType === 'audio' ? 'audio' : opts.mediaType || 'image';
    const local = mediaLocalComoBase64(opts.mediaUrl!);
    corpo.media = local ? local.base64 : opts.mediaUrl;
    if (opts.caption) corpo.caption = opts.caption;
    if (opts.mediaFilename) corpo.fileName = opts.mediaFilename;
    if (opts.mediaMime) corpo.mimetype = opts.mediaMime;
    else if (local?.mime) corpo.mimetype = local.mime;
  } else {
    corpo.text = opts.text ?? '';
  }
  // Citar mensagem. A Evolution quer a chave inteira, mas na prática só o `id`
  // já resolve — e é só o que guardamos.
  if (opts.replyToMessageId) {
    corpo.quoted = { key: { id: opts.replyToMessageId } };
  }
  try {
    const r = await fetch(url(creds, caminho), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(30_000),
    });
    const texto = await r.text();
    let dados: any;
    try {
      dados = JSON.parse(texto);
    } catch {
      dados = { raw: texto };
    }
    if (!r.ok) {
      return {
        ok: false,
        error: {
          code: r.status,
          message: dados?.message || dados?.error || `http_${r.status}`,
          raw: dados,
        },
      };
    }
    return { ok: true, messageId: dados?.key?.id || dados?.id };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'erro_desconhecido';
    return { ok: false, error: { message: msg } };
  }
}

/** Marca como lida. Best-effort: falhar aqui não pode derrubar o atendimento. */
export async function markAsRead(channel: Channel2, messageId: string, phone: string): Promise<void> {
  const creds = credsDo(channel);
  try {
    await fetch(url(creds, `/chat/markMessageAsRead/${encodeURIComponent(creds.instance)}`), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify({
        readMessages: [
          { id: messageId, remoteJid: `${phone.replace(/\D/g, '')}@s.whatsapp.net`, fromMe: false },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    logger.warn(`[evolution] markAsRead falhou: ${e?.message}`);
  }
}

/** Indicador de "digitando". Também best-effort. */
export async function sendTyping(channel: Channel2, phone: string, ms = 2500): Promise<void> {
  const creds = credsDo(channel);
  try {
    await fetch(url(creds, `/chat/sendPresence/${encodeURIComponent(creds.instance)}`), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify({
        number: phone.replace(/\D/g, ''),
        presence: 'composing',
        delay: ms,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // silencioso de propósito: "digitando" é enfeite, não pode custar uma resposta
  }
}

/** Mapeia o tipo de mensagem da Evolution para o vocabulário do CRM. */
function tipoDaMensagem(m: any): ParsedInbound['type'] {
  if (m?.imageMessage) return 'image';
  if (m?.audioMessage || m?.pttMessage) return 'audio';
  if (m?.videoMessage) return 'video';
  if (m?.documentMessage || m?.documentWithCaptionMessage) return 'document';
  if (m?.stickerMessage) return 'image';
  if (m?.locationMessage) return 'location';
  return 'text';
}

/** Texto de uma mensagem, que a Evolution esconde em lugares diferentes. */
function textoDaMensagem(m: any): string | undefined {
  return (m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.listResponseMessage?.title ||
    m?.templateButtonReplyMessage?.selectedDisplayText ||
    undefined);
}

function midiaDaMensagem(m: any, base64?: string): Partial<ParsedInbound> {
  const bloco = m?.imageMessage || m?.audioMessage || m?.pttMessage || m?.videoMessage ||
    m?.documentMessage || m?.documentWithCaptionMessage?.message?.documentMessage ||
    m?.stickerMessage;
  if (!bloco) return {};
  const mime = bloco.mimetype || undefined;
  // Com WEBHOOK_BASE64=true o conteúdo vem no próprio evento. Preferimos isso:
  // a `url` que a Evolution entrega aponta para o WhatsApp e vem criptografada,
  // então baixá-la por conta própria não daria o arquivo utilizável.
  if (base64) {
    return {
      mediaUrl: `data:${mime || 'application/octet-stream'};base64,${base64}`,
      mediaMime: mime,
      mediaFilename: bloco.fileName || undefined,
    };
  }
  return { mediaUrl: bloco.url || undefined, mediaMime: mime, mediaFilename: bloco.fileName };
}

/**
 * Interpreta o webhook da Evolution.
 *
 * Só nos interessa `messages.upsert`. Os outros eventos (status de conexão,
 * confirmação de entrega, presença) chegam no mesmo endpoint e precisam ser
 * ignorados em silêncio — tratá-los como mensagem faria o agente responder a
 * um "entregue".
 *
 * `fromMe` é filtrado por quem chama, não aqui: a mensagem enviada pelo próprio
 * corretor pelo celular dele é informação útil para a timeline, mas não pode
 * disparar o agente.
 */
export function parseWebhook(payload: any): WebhookValue {
  const saida: WebhookValue = { messages: [] };
  const evento = payload?.event || payload?.Event;
  if (evento && !String(evento).toLowerCase().startsWith('messages.upsert')) {
    return saida;
  }
  // `data` pode ser um objeto ou uma lista, conforme a versão.
  const bruto = payload?.data ?? payload;
  const itens = Array.isArray(bruto) ? bruto : [bruto];
  for (const item of itens) {
    if (!item?.key) continue;
    // Grupo não vira atendimento: o CRM é um a um, e um grupo movimentado
    // criaria um card por participante.
    if (ehGrupo(item.key.remoteJid)) continue;
    const mensagem = item.message;
    if (!mensagem) continue;
    const tipo = tipoDaMensagem(mensagem);
    const texto = textoDaMensagem(mensagem);
    const midia = midiaDaMensagem(mensagem, item.message?.base64 || item.base64);
    // Mensagem sem texto e sem mídia não tem o que processar (reação,
    // edição, protocolo interno do WhatsApp).
    if (tipo === 'text' && !texto) continue;
    const carimbo = Number(item.messageTimestamp || item.date_time || 0);
    saida.messages.push({
      fromPhone: numeroDoJid(item.key.remoteJid),
      fromName: item.pushName || undefined,
      messageId: item.key.id || '',
      // A Evolution manda segundos; o CRM trabalha em milissegundos.
      timestamp: carimbo > 1e12 ? carimbo : carimbo * 1000 || Date.now(),
      type: tipo,
      text: tipo === 'text' ? texto : undefined,
      caption: tipo !== 'text' ? texto : undefined,
      ...midia,
      fromMe: !!item.key.fromMe,
      raw: item,
    });
  }
  return saida;
}

/**
 * Baixa mídia. Quando o webhook já trouxe base64, `parseWebhook` devolve um
 * `data:` URI e esta função nem precisa ir à rede.
 */
export async function fetchMedia(channel: Channel2, mediaUrl: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  if (mediaUrl.startsWith('data:')) {
    const m = mediaUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return { ok: false, error: 'data_uri_malformado' };
    return { ok: true, bytes: Buffer.from(m[2], 'base64'), mime: m[1] };
  }
  const creds = credsDo(channel);
  try {
    const r = await fetch(mediaUrl, {
      headers: { apikey: creds.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, bytes: buf, mime: r.headers.get('content-type') || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'erro_desconhecido' };
  }
}

export async function estadoDaInstancia(creds: EvolutionCreds): Promise<EstadoInstancia> {
  try {
    const r = await fetch(url(creds, `/instance/connectionState/${encodeURIComponent(creds.instance)}`), {
      headers: headers(creds),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 404) return { existe: false, conectado: false };
    if (!r.ok) return { existe: true, conectado: false, estado: `http_${r.status}` };
    const d = await r.json() as any;
    const estado = d?.instance?.state || d?.state;
    return { existe: true, conectado: estado === 'open', estado };
  } catch {
    return { existe: false, conectado: false, estado: 'inalcancavel' };
  }
}

export async function fetchConnectedPhone(channel: Channel2): Promise<string | null> {
  const creds = credsDo(channel);
  try {
    const r = await fetch(url(creds, `/instance/fetchInstances?instanceName=${encodeURIComponent(creds.instance)}`), {
      headers: headers(creds),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const d = await r.json() as any;
    const lista = Array.isArray(d) ? d : [d];
    const inst = lista.find((x: any) => (x?.instance?.instanceName || x?.name) === creds.instance) || lista[0];
    const jid = inst?.instance?.owner || inst?.ownerJid || inst?.owner;
    const numero = numeroDoJid(jid);
    return numero || null;
  } catch {
    return null;
  }
}

/**
 * Busca a URL da foto de perfil de um número no WhatsApp.
 *
 * `null` cobre dois casos que o CRM não precisa distinguir: o contato não
 * tem foto de perfil, ou não está no WhatsApp. Em ambos, melhor não ter
 * avatar do que quebrar o fluxo de quem chamou.
 */
export async function fetchProfilePicture(channel: Channel2, phone: string): Promise<string | null> {
  const creds = credsDo(channel);
  try {
    const r = await fetch(url(creds, `/chat/fetchProfilePictureUrl/${encodeURIComponent(creds.instance)}`), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify({ number: phone }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d = await r.json() as any;
    return d?.profilePictureUrl || null;
  } catch (err: any) {
    logger.warn('[evolution] fetchProfilePicture falhou:', err?.message);
    return null;
  }
}

/**
 * Cria a instância se ainda não existir e devolve o QR de pareamento.
 *
 * O QR **expira em cerca de 40 segundos** e é reemitido pela Evolution. Por
 * isso a tela precisa buscar de novo em vez de guardar a imagem: um QR salvo
 * e mostrado depois é um QR que não vai ler, e o cliente conclui que o produto
 * está quebrado.
 */
export async function criarOuParear(creds: EvolutionCreds, opcoes: { webhookUrl?: string } = {}): Promise<ResultadoParear> {
  const estado = await estadoDaInstancia(creds);
  // Garante o webhook em TODA chamada, não só na criação.
  //
  // Medido em 10/08/2026: uma instância que já existia ficava sem webhook,
  // porque só o caminho de criação o configurava. Resultado: pareia, conecta,
  // e nenhuma mensagem chega — sem erro em lugar nenhum, porque do ponto de
  // vista da Evolution está tudo certo, ela só não tem para onde avisar.
  //
  // Também conserta sozinho o caso de o endereço público ter mudado, que de
  // outro modo exigiria parear o WhatsApp de novo.
  if (opcoes.webhookUrl && estado.existe) {
    const w = await configurarWebhook(creds, opcoes.webhookUrl);
    if (!w.ok) logger.warn(`[evolution] não consegui garantir o webhook: ${w.erro}`);
  }
  if (estado.conectado) return { ok: true, jaConectado: true };
  try {
    if (!estado.existe) {
      const r = await fetch(url(creds, '/instance/create'), {
        method: 'POST',
        headers: headers(creds),
        body: JSON.stringify({
          instanceName: creds.instance,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
          // Sem bloco `webhook` aqui de propósito — ver o comentário abaixo.
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const d = await r.json().catch(() => ({})) as any;
      if (!r.ok) return { ok: false, erro: d?.message || `http_${r.status}` };
      // O webhook é configurado SEMPRE por `configurarWebhook`, e não pelo
      // corpo do `instance/create`.
      //
      // Medido em 10/08/2026: o bloco `webhook` passado na criação não grava o
      // `base64`. Sem ele, a mídia chega como URL do WhatsApp — criptografada,
      // portanto inútil para nós — e áudio e imagem de lead chegariam
      // quebrados, sem erro nenhum que apontasse para a causa.
      //
      // Um caminho só, verificado, em vez de dois que parecem equivalentes.
      if (opcoes.webhookUrl) {
        const w = await configurarWebhook(creds, opcoes.webhookUrl);
        if (!w.ok) {
          logger.warn(`[evolution] instância criada mas o webhook falhou: ${w.erro}`);
        }
      }
      const qr = d?.qrcode?.base64 || d?.base64;
      if (qr) return { ok: true, qr, codigoDeParear: d?.qrcode?.pairingCode };
    }
    // Instância já existia mas está desconectada: pede um QR novo.
    const r = await fetch(url(creds, `/instance/connect/${encodeURIComponent(creds.instance)}`), {
      headers: headers(creds),
      signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json().catch(() => ({})) as any;
    // 404 aqui significa que a instância sumiu entre a checagem de estado e
    // agora. Acontece de verdade: a exclusão na Evolution é assíncrona, então
    // logo depois de apagar uma instância o `connectionState` ainda responde
    // que ela existe. Refazer a criação resolve, e é melhor do que devolver um
    // erro que o cliente não tem como agir.
    if (r.status === 404) {
      logger.info('[evolution] instância sumiu entre a checagem e o connect; recriando');
      const r2 = await fetch(url(creds, '/instance/create'), {
        method: 'POST',
        headers: headers(creds),
        body: JSON.stringify({
          instanceName: creds.instance,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const d2 = await r2.json().catch(() => ({})) as any;
      if (!r2.ok) return { ok: false, erro: d2?.message || `http_${r2.status}` };
      if (opcoes.webhookUrl) {
        const w = await configurarWebhook(creds, opcoes.webhookUrl);
        if (!w.ok) logger.warn(`[evolution] webhook falhou na recriação: ${w.erro}`);
      }
      const qr2 = d2?.qrcode?.base64 || d2?.base64;
      if (qr2) return { ok: true, qr: qr2, codigoDeParear: d2?.qrcode?.pairingCode };
    }
    if (!r.ok) return { ok: false, erro: d?.message || `http_${r.status}` };
    const qr = d?.base64 || d?.qrcode?.base64;
    // Sem QR e sem conexão não é sucesso.
    //
    // Devolver `ok: true` com o QR vazio — que era o que acontecia aqui —
    // produz exatamente a pior tela do produto: o cliente olha para um quadro
    // em branco, sem erro nenhum, e conclui que está quebrado. Um erro dito em
    // voz alta é melhor do que um sucesso mentiroso.
    if (!qr) {
      return {
        ok: false,
        erro: 'A Evolution não devolveu o QR. Tente de novo em alguns segundos; ' +
          'se persistir, o servidor de WhatsApp pode estar reiniciando.',
      };
    }
    return { ok: true, qr, codigoDeParear: d?.pairingCode };
  } catch (e: any) {
    return { ok: false, erro: e?.message || 'erro_desconhecido' };
  }
}

/** Desconecta o número sem apagar a instância. */
export async function desconectar(creds: EvolutionCreds): Promise<boolean> {
  try {
    const r = await fetch(url(creds, `/instance/logout/${encodeURIComponent(creds.instance)}`), {
      method: 'DELETE',
      headers: headers(creds),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Aponta o webhook da instância para nós.
 *
 * Separado da criação de propósito: o endereço público muda (domínio novo,
 * migração de host), e reapontar não pode exigir parear o WhatsApp de novo —
 * isso custaria uma visita ao celular de cada cliente.
 */
export async function configurarWebhook(creds: EvolutionCreds, webhookUrl: string): Promise<{ ok: boolean; erro?: string }> {
  try {
    const r = await fetch(url(creds, `/webhook/set/${encodeURIComponent(creds.instance)}`), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: true,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, erro: `http_${r.status} ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: e?.message || 'erro_desconhecido' };
  }
}
