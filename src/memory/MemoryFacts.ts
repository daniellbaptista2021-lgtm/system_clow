/**
 * MemoryFacts.ts — memória permanente da conta (pedido do Daniel, 31/10/2026).
 *
 * Igual à memória do OpenClaw: o próprio agente grava um fato no momento em
 * que ele aparece ("prefere cobrar dia 10 por Pix", "conta de anúncios é a
 * act_123", "não mandar mensagem no domingo") e a lista inteira entra no
 * começo de toda conversa. Um banco por conta (getMemoryDb), nada vaza entre
 * corretores.
 *
 * Senha, token e chave NUNCA viram fato: ficariam em texto puro e voltariam
 * no prompt de toda conversa.
 */

import { getMemoryDb } from './MemoryDatabase.js';

export const TIPOS_FATO = ['perfil', 'preferencia', 'decisao', 'cliente', 'conexao', 'processo', 'outro'] as const;
export type TipoFato = (typeof TIPOS_FATO)[number];

export interface Fato {
  id: number;
  tipo: TipoFato;
  titulo: string;
  conteudo: string;
  criado_em: number;
  atualizado_em: number;
}

/** Teto por fato: memória é anotação curta, não documento. */
export const MAX_CONTEUDO = 1500;

// Padrões de segredo: token da Meta (EAA...), chaves de API (sk-, AKIA...),
// tokens longos sem espaço e qualquer "senha: ..." escrito por extenso.
const SEGREDO = [
  /\bEAA[A-Za-z0-9]{30,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:senha|password|passwd|token|api[_ -]?key|secret)\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z0-9_\-]{48,}\b/,
];

export function pareceSegredo(texto: string): boolean {
  return SEGREDO.some((r) => r.test(texto));
}

function tenantObrigatorio(tenantId: string | undefined): string {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error('memoria_tenant_missing: sem conta na sessão, a memória não é gravada nem lida.');
  }
  return tenantId;
}

/** Grava ou atualiza (mesmo título = mesmo fato). */
export function salvarFato(tenantId: string | undefined, tipo: TipoFato, titulo: string, conteudo: string): { fato: Fato; atualizado: boolean } {
  const t = tenantObrigatorio(tenantId);
  const tituloLimpo = titulo.trim().slice(0, 120);
  const conteudoLimpo = conteudo.trim();
  if (!tituloLimpo || !conteudoLimpo) throw new Error('memoria_vazia: título e conteúdo são obrigatórios.');
  if (conteudoLimpo.length > MAX_CONTEUDO) throw new Error(`memoria_grande: resuma em até ${MAX_CONTEUDO} caracteres.`);
  if (pareceSegredo(tituloLimpo) || pareceSegredo(conteudoLimpo)) {
    throw new Error('memoria_segredo: senha, token ou chave não são guardados na memória. Guarde só o fato (ex.: "Meta conectada, conta act_123").');
  }
  const db = getMemoryDb(t);
  const agora = Date.now();
  const antes = db.prepare('SELECT id FROM memory_facts WHERE titulo = ?').get(tituloLimpo) as { id: number } | undefined;
  db.prepare(
    `INSERT INTO memory_facts (tipo, titulo, conteudo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(titulo) DO UPDATE SET tipo = excluded.tipo, conteudo = excluded.conteudo, atualizado_em = excluded.atualizado_em`,
  ).run(tipo, tituloLimpo, conteudoLimpo, agora, agora);
  const fato = db.prepare('SELECT * FROM memory_facts WHERE titulo = ?').get(tituloLimpo) as Fato;
  return { fato, atualizado: !!antes };
}

export function apagarFato(tenantId: string | undefined, titulo: string): boolean {
  const t = tenantObrigatorio(tenantId);
  return getMemoryDb(t).prepare('DELETE FROM memory_facts WHERE titulo = ?').run(titulo.trim()).changes > 0;
}

export function listarFatos(tenantId: string | undefined): Fato[] {
  const t = tenantObrigatorio(tenantId);
  return getMemoryDb(t).prepare('SELECT * FROM memory_facts ORDER BY tipo, atualizado_em DESC').all() as Fato[];
}

const NOME_TIPO: Record<TipoFato, string> = {
  perfil: 'Sobre o corretor e a corretora',
  preferencia: 'Preferências',
  decisao: 'Decisões tomadas',
  cliente: 'Clientes e leads importantes',
  conexao: 'Conexões e contas',
  processo: 'Como ele trabalha',
  outro: 'Outros',
};

/** Bloco que entra no começo de toda conversa: todos os fatos, agrupados. */
export function fatosParaPrompt(tenantId: string | undefined): string {
  let fatos: Fato[];
  try {
    fatos = listarFatos(tenantId);
  } catch {
    return '';
  }
  const partes = ['## Memória permanente desta conta', 'Tudo o que você já anotou sobre este corretor. Vale para esta conversa: use sem perguntar de novo.'];
  if (!fatos.length) {
    partes.push('', '(Ainda vazia. Comece a anotar com a ferramenta Memoria.)');
    return partes.join('\n');
  }
  for (const tipo of TIPOS_FATO) {
    const doTipo = fatos.filter((f) => f.tipo === tipo);
    if (!doTipo.length) continue;
    partes.push('', `### ${NOME_TIPO[tipo]}`);
    for (const f of doTipo) partes.push(`- **${f.titulo}**: ${f.conteudo}`);
  }
  return partes.join('\n');
}

/** Como o agente deve usar a memória — vai junto com os fatos. */
export const INSTRUCOES_MEMORIA = `## Como usar a sua memória (ferramenta Memoria)
Você tem memória permanente, igual à de um funcionário que anota tudo. Ela não se perde quando a conversa fecha.
- **Grave na hora**, sem pedir licença, sempre que aparecer algo que vale para as próximas conversas: nome e jeito do corretor, ramos que ele vende, preferências (dia e forma de cobrança, horário de atendimento, tom das mensagens), decisões ("campanhas sempre pausadas"), clientes e leads importantes, contas conectadas ("Meta conectada, conta act_123"), o que deu certo e o que deu errado.
- Quando ele disser "lembra disso", "anota", "a partir de agora", "sempre", "nunca": grave na mesma resposta.
- **Mesmo assunto = mesmo título**: atualize o fato em vez de criar outro. Se algo deixou de valer, apague.
- **Nunca grave senha, token ou chave.** Grave só o fato ("Meta conectada, conta act_123"), nunca o token.
- Antes de perguntar algo ao corretor, veja se a resposta já está na memória acima.`;
