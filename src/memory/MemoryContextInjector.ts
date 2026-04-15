/**
 * MemoryContextInjector.ts — Generate memory context for system prompt
 *
 * Queries recent sessions and observations from SQLite and formats
 * them as markdown for injection into the system prompt.
 *
 * Token budget: max ~2000 tokens (~8000 chars).
 * Truncates oldest sessions first.
 */

import { MemoryStore } from './MemoryStore.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const MAX_CHARS = 8000; // ~2000 tokens
const MAX_SESSIONS = 5;
const MAX_OBSERVATIONS = 15;

// ════════════════════════════════════════════════════════════════════════════
// Context Generation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate memory context markdown for injection into system prompt.
 * Returns empty string if no memories exist.
 */
export function generateMemoryContext(tenantId: string = 'default'): string {
  try {
    const store = new MemoryStore(tenantId);

    const summaries = store.getRecentSummaries(MAX_SESSIONS);
    const observations = store.getRecentObservations(MAX_OBSERVATIONS);

    if (summaries.length === 0 && observations.length === 0) return '';

    const parts: string[] = [];
    parts.push('## Memória de Sessões Anteriores\n');

    // ─── Recent Sessions ──────────────────────────────────────────

    if (summaries.length > 0) {
      parts.push('### Sessões Recentes\n');

      for (const summary of summaries) {
        const date = formatDate(summary.created_at_epoch);
        const completed = summary.completed || summary.request || 'Sessão de trabalho';
        const learned = summary.learned ? ` Aprendizado: ${summary.learned}` : '';

        parts.push(`- **${date}** — ${completed.slice(0, 150)}${learned.slice(0, 100)}`);
      }

      parts.push('');
    }

    // ─── Recent Observations ──────────────────────────────────────

    if (observations.length > 0) {
      parts.push('### Observações Relevantes\n');

      // Group by type
      const fileChanges = observations.filter(o => o.type === 'file_change');
      const toolUses = observations.filter(o => o.type === 'tool_use');

      if (fileChanges.length > 0) {
        // Dedupe files
        const files = new Set<string>();
        for (const obs of fileChanges) {
          if (obs.files_touched) {
            try {
              const parsed = JSON.parse(obs.files_touched) as string[];
              parsed.forEach(f => files.add(f));
            } catch {}
          }
        }
        if (files.size > 0) {
          parts.push(`- **Arquivos modificados recentemente**: ${[...files].slice(0, 8).join(', ')}`);
        }
      }

      // Show unique tool observations
      const seenTitles = new Set<string>();
      for (const obs of toolUses) {
        if (!obs.title || seenTitles.has(obs.title)) continue;
        seenTitles.add(obs.title);
        parts.push(`- ${obs.title}${obs.narrative ? ' — ' + obs.narrative.slice(0, 80) : ''}`);
        if (seenTitles.size >= 8) break;
      }

      parts.push('');
    }

    let context = parts.join('\n');

    // Enforce token budget
    while (context.length > MAX_CHARS && parts.length > 3) {
      // Remove from the middle (oldest observations)
      parts.splice(Math.floor(parts.length / 2), 1);
      context = parts.join('\n');
    }

    if (context.length > MAX_CHARS) {
      context = context.slice(0, MAX_CHARS) + '\n...(memória truncada)';
    }

    return context;
  } catch (err) {
    console.warn(`[Memory] Context generation error: ${(err as Error).message}`);
    return '';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${d.getDate()}/${months[d.getMonth()]}`;
}
