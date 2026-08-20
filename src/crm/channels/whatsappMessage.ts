/**
 * Normalizador único de mensagens do WhatsApp.
 *
 * O objeto `message` da Evolution é uma união de dezenas de formatos, e cada
 * versão do WhatsApp acrescenta os seus. Antes deste arquivo, o parser da
 * Evolution conhecia sete deles e mandava todo o resto para `text` com texto
 * vazio — o que produzia, na tela, um balão com horário e nada dentro.
 *
 * Toda a tradução "formato do WhatsApp -> vocabulário do CRM" acontece aqui.
 * Quem chama recebe sempre a mesma forma e não precisa saber que
 * `ptvMessage` é um vídeo redondo ou que `lottieStickerMessage` é figurinha.
 *
 * Os tipos abaixo foram levantados dos 30.076 registros reais da instância em
 * produção, não de documentação: `SELECT "messageType", COUNT(*) FROM
 * "Message" GROUP BY 1`. Os wrappers (`ephemeralMessage`, `viewOnceMessage`)
 * não apareceram nessa amostra, mas são tratados porque chegam sem aviso
 * quando alguém liga mensagem temporária na conversa.
 */
import type { MediaType } from '../types.js';

/** Envelopes que carregam a mensagem real num nível abaixo. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'protocolMessage.editedMessage',
] as const;

/**
 * Tira os envelopes até chegar na mensagem de verdade.
 *
 * O limite de profundidade não é paranoia gratuita: o conteúdo vem de fora,
 * e um payload malformado com auto-referência trancaria o laço para sempre
 * dentro do handler do webhook.
 */
export function desembrulhar(message: any, profundidade = 0): any {
  if (!message || typeof message !== 'object' || profundidade > 5) return message;
  for (const w of WRAPPERS) {
    const alvo = w.includes('.')
      ? w.split('.').reduce((o: any, k) => o?.[k], message)
      : message[w];
    if (alvo?.message) return desembrulhar(alvo.message, profundidade + 1);
  }
  return message;
}

/** Formato -> tipo do CRM. A ordem não importa: a busca é por chave presente. */
const TIPOS: Record<string, MediaType> = {
  conversation: 'text',
  extendedTextMessage: 'text',

  imageMessage: 'image',
  stickerMessage: 'image',
  lottieStickerMessage: 'image',
  albumMessage: 'image',

  audioMessage: 'audio',
  pttMessage: 'audio',

  videoMessage: 'video',
  ptvMessage: 'video', // "push to video": o vídeo redondo curto

  documentMessage: 'document',

  locationMessage: 'location',
  liveLocationMessage: 'location',

  contactMessage: 'interactive',
  contactsArrayMessage: 'interactive',
  templateMessage: 'interactive',
  templateButtonReplyMessage: 'interactive',
  interactiveMessage: 'interactive',
  interactiveResponseMessage: 'interactive',
  buttonsMessage: 'interactive',
  buttonsResponseMessage: 'interactive',
  listMessage: 'interactive',
  listResponseMessage: 'interactive',
  pollCreationMessage: 'interactive',
  pollCreationMessageV2: 'interactive',
  pollCreationMessageV3: 'interactive',
  pollUpdateMessage: 'interactive',
  reactionMessage: 'interactive',
  secretEncryptedMessage: 'interactive',
};

/** Blocos que carregam binário — usados para achar mimetype e nome do arquivo. */
const BLOCOS_DE_MIDIA = [
  'imageMessage', 'audioMessage', 'pttMessage', 'videoMessage', 'ptvMessage',
  'documentMessage', 'stickerMessage', 'lottieStickerMessage',
];

/**
 * Chaves que não são conteúdo: vêm junto em quase toda mensagem e não podem
 * decidir o tipo, senão qualquer mensagem viraria "interativa".
 */
const RUIDO = new Set([
  'messageContextInfo', 'senderKeyDistributionMessage', 'deviceSentMessage',
  'base64', 'protocolMessage', 'associatedChildMessage', 'placeholderMessage',
]);

export interface MensagemNormalizada {
  /** Tipo no vocabulário do CRM. */
  tipo: MediaType;
  /** Texto digitado pela pessoa: corpo da mensagem ou legenda da mídia. */
  texto?: string;
  /**
   * O que mostrar quando não há texto nem mídia para renderizar. Descreve o
   * que a mensagem era — nunca substitui conteúdo que exista.
   */
  rotulo: string;
  /** Bloco com o binário, quando houver. */
  bloco?: any;
  /** Chave que identificou o formato — útil no log de diagnóstico. */
  formato: string;
  /** true quando nenhum formato conhecido casou. */
  desconhecido: boolean;
}

/** Texto visível de cada formato, na ordem em que o WhatsApp os preenche. */
function extrairTexto(m: any): string | undefined {
  const t =
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.ptvMessage?.caption ||
    m?.documentMessage?.caption ||
    m?.audioMessage?.caption ||
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.templateButtonReplyMessage?.selectedDisplayText ||
    m?.listResponseMessage?.title ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m?.interactiveResponseMessage?.body?.text ||
    m?.buttonsMessage?.contentText ||
    m?.listMessage?.description ||
    m?.templateMessage?.hydratedTemplate?.hydratedContentText ||
    m?.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
    m?.pollCreationMessage?.name ||
    m?.pollCreationMessageV2?.name ||
    m?.pollCreationMessageV3?.name ||
    undefined;
  return typeof t === 'string' && t.trim() ? t : undefined;
}

/** Descrição curta para quando não há texto nem mídia renderizável. */
function montarRotulo(tipo: MediaType, formato: string, m: any): string {
  switch (formato) {
    case 'stickerMessage':
    case 'lottieStickerMessage':
      return '[sticker]';
    case 'contactMessage':
      return `👤 ${m?.contactMessage?.displayName || 'Contato'}`;
    case 'contactsArrayMessage':
      return '👤 Contatos';
    case 'reactionMessage':
      return m?.reactionMessage?.text ? `Reagiu com ${m.reactionMessage.text}` : 'Reação';
    case 'secretEncryptedMessage':
      return '[mensagem protegida]';
    case 'ptvMessage':
      return '🎥 Vídeo';
    case 'documentMessage': {
      const nome = m?.documentMessage?.fileName;
      return nome ? `📄 ${nome}` : '📄 Documento';
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return '📊 Enquete';
    case 'pollUpdateMessage':
      return '📊 Voto em enquete';
  }
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

/**
 * Ponto único de normalização. Recebe o `message` cru da Evolution — com ou
 * sem envelope — e devolve sempre a mesma forma.
 */
export function normalizarMensagemWhatsApp(messageBruto: any): MensagemNormalizada {
  const m = desembrulhar(messageBruto);

  let formato = '';
  let tipo: MediaType = 'text';
  if (m && typeof m === 'object') {
    for (const chave of Object.keys(m)) {
      if (RUIDO.has(chave)) continue;
      if (TIPOS[chave]) { formato = chave; tipo = TIPOS[chave]; break; }
    }
  }

  const texto = extrairTexto(m);
  const desconhecido = !formato && !texto;

  let bloco: any;
  for (const b of BLOCOS_DE_MIDIA) {
    if (m?.[b]) { bloco = m[b]; break; }
  }

  return {
    tipo,
    texto,
    rotulo: montarRotulo(tipo, formato, m),
    bloco,
    formato: formato || (texto ? 'conversation' : 'desconhecido'),
    desconhecido,
  };
}

/**
 * Lista as chaves de conteúdo do payload, para o log de diagnóstico. Filtra o
 * ruído e nunca inclui `base64`, que carregaria o binário inteiro para dentro
 * do log.
 */
export function chavesDeConteudo(messageBruto: any): string[] {
  const m = desembrulhar(messageBruto);
  if (!m || typeof m !== 'object') return [];
  return Object.keys(m).filter((k) => k !== 'base64' && k !== 'messageContextInfo');
}
