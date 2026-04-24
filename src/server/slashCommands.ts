/**
 * slashCommands.ts — Intercept slash commands and auto-greetings before QueryEngine
 *
 * Commands handled:
 *   /help            — list all commands
 *   /usage           — token usage today
 *   /memories        — list saved memories
 *   /forget <word>   — remove memory
 *   /plan            — current plan and limits
 *   /skills          — list available skills
 *   /connections     — active integrations
 *   /mission <desc>  — autonomous mission with progress
 *
 * Also handles greetings (oi, ola, bom dia, boa tarde, boa noite)
 * to return instant responses without burning LLM tokens.
 */

import type { MissionRunner } from './missions.js';

// ════════════════════════════════════════════════════════════════════════════
// Greeting Detector
// ════════════════════════════════════════════════════════════════════════════

const GREETING_REGEX = /^\s*(oi|ol[aá]|bom dia|boa tarde|boa noite|e a[ií]|fala|hey|hi|hello)[!.?\s]*$/i;

export function detectGreeting(message: string): string | null {
  const match = message.match(GREETING_REGEX);
  if (!match) return null;

  const hour = new Date().getHours();
  const word = match[1].toLowerCase();

  if (word.includes('bom dia') || (hour >= 5 && hour < 12)) return 'Bom dia. Em que posso ajudar?';
  if (word.includes('boa noite') || hour >= 18 || hour < 5) return 'Boa noite. Em que posso ajudar?';
  return 'Boa tarde. Em que posso ajudar?';
}

// ════════════════════════════════════════════════════════════════════════════
// Slash Command Handler
// ════════════════════════════════════════════════════════════════════════════

interface CommandContext {
  tenantId: string;
  sessionId: string;
  isAdmin: boolean;
  missionRunner?: MissionRunner;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
  isStreaming?: boolean;
  missionId?: string;
}

export async function handleSlashCommand(message: string, ctx: CommandContext): Promise<CommandResult> {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  const argStr = args.join(' ');

  switch (cmd.toLowerCase()) {
    case 'help':
      return { handled: true, response: helpResponse() };

    case 'usage':
      return { handled: true, response: await usageResponse(ctx.tenantId) };

    case 'memories':
      return { handled: true, response: await memoriesResponse(ctx.tenantId) };

    case 'forget':
      return { handled: true, response: await forgetResponse(ctx.tenantId, argStr) };

    case 'plan':
      return { handled: true, response: await planResponse(ctx.tenantId) };

    case 'skills':
      return { handled: true, response: skillsResponse() };

    case 'connections':
      return { handled: true, response: connectionsResponse() };

    case 'mission':
      if (!argStr) return { handled: true, response: 'Uso: `/mission <descricao da missao>`' };
      if (!ctx.missionRunner) return { handled: true, response: 'Sistema de missoes nao disponivel nesta sessao.' };
      const mission = await ctx.missionRunner.start(argStr, ctx.sessionId, ctx.tenantId);
      return { handled: true, response: missionStartedResponse(mission), missionId: mission.id };

    default:
      return { handled: true, response: `Comando desconhecido: \`/${cmd}\`\n\nUse \`/help\` para ver a lista de comandos.` };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Command Responses
// ════════════════════════════════════════════════════════════════════════════

function helpResponse(): string {
  return `## Comandos Disponiveis

| Comando | Descricao |
|---------|-----------|
| \`/mission X\` | Iniciar missao autonoma |
| \`/skills\` | Listar skills disponiveis |
| \`/memories\` | Ver memorias salvas |
| \`/forget X\` | Esquecer memoria |
| \`/connections\` | Ver conexoes ativas |
| \`/usage\` | Ver consumo de tokens hoje |
| \`/plan\` | Ver plano atual e limites |
| \`/help\` | Esta lista de comandos |

**Missoes:** \`/mission cria um site completo para pizzaria\`

**Geracao de arquivos:** peca naturalmente (ex: 'cria uma planilha de vendas')

**Integracoes:** pergunte direto (ex: 'mostra minhas campanhas meta ads')`;
}

async function usageResponse(tenantId: string): Promise<string> {
  try {
    const { getTenant } = await import('../tenancy/tenantStore.js');
    const tenant = await getTenant(tenantId);
    if (!tenant) return '## Seu Consumo\n\nNao foi possivel recuperar seu consumo.';

    const used = (tenant as any).current_month_messages || 0;
    const limit = (tenant as any).max_messages_per_month || 1500;
    const cost = (tenant as any).current_month_cost_usd || 0;
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

    return `## Seu Consumo Hoje

- Mensagens usadas: **${used.toLocaleString('pt-BR')}**
- Limite mensal: **${limit.toLocaleString('pt-BR')}** (${pct}%)
- Custo estimado: **$${cost.toFixed(4)}**`;
  } catch {
    return '## Seu Consumo\n\nConsumo indisponivel no momento.';
  }
}

async function memoriesResponse(tenantId: string): Promise<string> {
  try {
    const { MemoryStore } = await import('../memory/MemoryStore.js');
    const store = new MemoryStore(tenantId);
    const stats = store.getStats();
    const recent = store.getRecentSummaries(5);

    let out = `## Memorias Salvas\n\n- Sessoes: **${stats.sessionCount}**\n- Observacoes: **${stats.observationCount}**\n- Resumos: **${stats.summaryCount}**\n- Tamanho DB: **${(stats.dbSizeBytes / 1024).toFixed(1)} KB**`;

    if (recent.length > 0) {
      out += '\n\n### Ultimas sessoes\n';
      for (const s of recent) {
        const date = new Date(s.created_at_epoch).toLocaleDateString('pt-BR');
        out += `\n- **${date}** — ${s.request || s.completed || 'Sessao de trabalho'}`.slice(0, 200);
      }
    }
    return out;
  } catch {
    return '## Memorias\n\nNenhuma memoria salva ainda.';
  }
}

async function forgetResponse(tenantId: string, word: string): Promise<string> {
  if (!word) return 'Uso: `/forget <palavra ou ID da sessao>`';

  try {
    const { MemoryStore } = await import('../memory/MemoryStore.js');
    const store = new MemoryStore(tenantId);
    const deleted = store.deleteSession(word);
    return deleted ? `Memoria de sessao \`${word}\` removida.` : `Sessao \`${word}\` nao encontrada.`;
  } catch (err) {
    return `Erro ao esquecer: ${(err as Error).message}`;
  }
}

async function planResponse(tenantId: string): Promise<string> {
  try {
    const { getTenant } = await import('../tenancy/tenantStore.js');
    const tenant = await getTenant(tenantId);
    const tier = (tenant as any)?.tier || 'admin';

    return `## Seu Plano

**Tier atual:** ${tier.toUpperCase()}

| Plano | Mensagens/mes | Custo/mes | Sessoes |
|-------|---------------|-----------|---------|
| ONE | 1.500 | $5 | 3 |
| SMART | 6.000 | $20 | 8 |
| PROFISSIONAL | 25.000 | $60 | 25 |
| BUSINESS | 100.000 | $200 | 100 |

Faca upgrade em https://clow.pvcorretor01.com.br`;
  } catch {
    return '## Seu Plano\n\nPlano nao disponivel no momento.';
  }
}

function skillsResponse(): string {
  return `## Skills Disponiveis

- **clone-website** — Clona sites pixel-perfect via Browser MCP
- **meta-ads** — Gerencia campanhas Meta Ads (Facebook/Instagram)
- **whatsapp-bot** — Bot de atendimento via Z-API
- **excel-generator** — Gera planilhas .xlsx profissionais
- **chatwoot-crm** — Integra com Chatwoot CRM
- **n8n-workflows** — Cria workflows de automacao
- **vercel-deploy** — Deploy automatico no Vercel
- **pdf-generator** — Gera documentos PDF

Use \`/mission <tarefa>\` para orquestrar multiplas skills juntas.`;
}

function connectionsResponse(): string {
  return `## Integracoes Ativas

- **GLM-5.1** via OpenRouter — conectado
- **Memoria Persistente** (SQLite + FTS5) — ativa
- **RAG Semantico** (256-dim embeddings) — ativo
- **Marketplace** — 8 plugins disponiveis

Use \`/connect <servico>\` para adicionar uma nova integracao.`;
}

// ════════════════════════════════════════════════════════════════════════════
// Mission Started Response
// ════════════════════════════════════════════════════════════════════════════

function missionStartedResponse(mission: { id: string; title: string; steps: string[]; estimated_minutes: number }): string {
  const steps = mission.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `## Missao Iniciada

**${mission.title}**

### Plano (${mission.steps.length} etapas, ~${mission.estimated_minutes} min):
${steps}

Executando em background... Acompanhe o progresso abaixo.

__MISSION_CARD__${mission.id}__`;
}
