/**
 * MemoryTool — o agente grava, atualiza, apaga e lista a memória permanente
 * da conta (src/memory/MemoryFacts.ts). Igual à memória do OpenClaw.
 */

import { z } from 'zod';
import { buildTool, type ToolResult } from '../Tool.js';
import { TIPOS_FATO, salvarFato, apagarFato, listarFatos } from '../../memory/MemoryFacts.js';

const MemoryInputSchema = z.object({
  acao: z.enum(['salvar', 'apagar', 'listar']).describe('salvar = grava ou atualiza (mesmo título); apagar = remove pelo título; listar = mostra tudo'),
  tipo: z.enum(TIPOS_FATO).optional().describe('perfil, preferencia, decisao, cliente, conexao, processo ou outro (para salvar)'),
  titulo: z.string().optional().describe('Nome curto e estável do fato, ex.: "Dia de cobrança". Mesmo título atualiza o fato.'),
  conteudo: z.string().optional().describe('O fato em uma ou duas frases, ex.: "Cobra todo dia 10, por Pix".'),
});

type MemoryInput = z.infer<typeof MemoryInputSchema>;

export const MemoryTool = buildTool<MemoryInput>({
  name: 'Memoria',
  aliases: ['Memory', 'MemoryTool'],
  searchHint: 'memoria lembrar anotar preferencia fato',
  description: `Memória permanente desta conta: o que você gravar aqui aparece no começo de TODA conversa futura.
Use "salvar" na hora em que aparecer algo que vale para depois (preferências, decisões, dados do corretor e da corretora, clientes importantes, contas conectadas).
Mesmo título atualiza o fato; "apagar" remove o que deixou de valer. Nunca grave senha, token ou chave.`,
  inputSchema: MemoryInputSchema,
  userFacingName: (i) => (i?.acao === 'salvar' && i.titulo ? `Memoria(${i.titulo})` : 'Memoria'),
  isReadOnly: (i) => i?.acao === 'listar',
  isConcurrencySafe: () => false,
  isDestructive: (i) => i?.acao === 'apagar',
  interruptBehavior: () => 'cancel' as const,
  toAutoClassifierInput: (i) => `${i.acao} ${i.titulo ?? ''}`,
  renderToolUseMessage: (i) =>
    i.acao === 'salvar' ? `Anotar na memória: ${i.titulo}` : i.acao === 'apagar' ? `Apagar da memória: ${i.titulo}` : 'Ver a memória',
  checkPermissions: async () => ({ behavior: 'allow' as const }),

  async call(input, ctx): Promise<ToolResult> {
    try {
      if (input.acao === 'listar') {
        const fatos = listarFatos(ctx.tenantId);
        return {
          output: { fatos },
          outputText: fatos.length ? fatos.map((f) => `[${f.tipo}] ${f.titulo}: ${f.conteudo}`).join('\n') : 'Memória vazia.',
        };
      }
      if (!input.titulo) return { output: { erro: 'sem_titulo' }, outputText: 'Informe o título do fato.', isError: true };
      if (input.acao === 'apagar') {
        const ok = apagarFato(ctx.tenantId, input.titulo);
        return { output: { apagado: ok }, outputText: ok ? `Apagado da memória: ${input.titulo}` : `Não havia fato com o título "${input.titulo}".` };
      }
      if (!input.conteudo) return { output: { erro: 'sem_conteudo' }, outputText: 'Informe o conteúdo do fato.', isError: true };
      const { fato, atualizado } = salvarFato(ctx.tenantId, input.tipo ?? 'outro', input.titulo, input.conteudo);
      return { output: { fato, atualizado }, outputText: `${atualizado ? 'Atualizado' : 'Anotado'} na memória: ${fato.titulo}` };
    } catch (e: any) {
      return { output: { erro: e?.message }, outputText: String(e?.message || e), isError: true };
    }
  },
});
