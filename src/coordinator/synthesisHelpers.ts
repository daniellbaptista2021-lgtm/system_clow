/**
 * synthesisHelpers.ts — Extract and format findings from N worker results
 *
 * The coordinator NEVER delegates synthesis to workers.
 * This module provides utilities for the coordinator to:
 *   - Extract key findings from worker outputs
 *   - Identify blockers and errors
 *   - Format synthesis context for the next phase
 *   - Summarize parallel research results
 */

import type { WorkerSpawnResult, SynthesisInput, SynthesisOutput } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// SynthesisHelpers Class
// ════════════════════════════════════════════════════════════════════════════

export class SynthesisHelpers {
  /**
   * Extract structured findings from N worker results.
   * Separates completed/failed and extracts bullet points.
   */
  static extractFindings(workers: WorkerSpawnResult[]): {
    completed: WorkerSpawnResult[];
    failed: WorkerSpawnResult[];
    keyFindings: string[];
    blockers: string[];
    totalCostUsd: number;
    totalTokens: number;
    totalDurationMs: number;
  } {
    const completed = workers.filter(w => w.status === 'completed');
    const failed = workers.filter(w => w.status === 'failed' || w.status === 'killed');

    const keyFindings: string[] = [];
    const blockers: string[] = [];
    let totalCostUsd = 0;
    let totalTokens = 0;
    let totalDurationMs = 0;

    for (const worker of completed) {
      if (!worker.result) continue;
      const findings = SynthesisHelpers.extractKeyFindings(worker.result);
      keyFindings.push(...findings.map(f => `[${worker.workerId}] ${f}`));
      totalCostUsd += worker.costUsd ?? 0;
      totalTokens += worker.tokensUsed ?? 0;
      totalDurationMs += worker.durationMs ?? 0;
    }

    for (const worker of failed) {
      if (worker.result) {
        blockers.push(`[${worker.workerId}] ${SynthesisHelpers.summarizeError(worker.result)}`);
      }
      totalCostUsd += worker.costUsd ?? 0;
      totalTokens += worker.tokensUsed ?? 0;
      totalDurationMs += worker.durationMs ?? 0;
    }

    return { completed, failed, keyFindings, blockers, totalCostUsd, totalTokens, totalDurationMs };
  }

  /**
   * Format synthesis input as a structured context message.
   * The coordinator uses this to reason about what to do next.
   */
  static formatSynthesisContext(input: SynthesisInput): string {
    const lines: string[] = [];
    lines.push(`# Synthesis Context: ${input.phase} phase`);
    lines.push('');
    lines.push(`Original request: ${input.originalUserRequest}`);
    lines.push('');

    const findings = SynthesisHelpers.extractFindings(input.workers);

    lines.push(`## Workers: ${findings.completed.length} completed, ${findings.failed.length} failed`);
    lines.push(`Cost: $${findings.totalCostUsd.toFixed(4)} | Tokens: ${findings.totalTokens} | Duration: ${findings.totalDurationMs}ms`);
    lines.push('');

    if (findings.keyFindings.length > 0) {
      lines.push('## Key Findings');
      for (const f of findings.keyFindings) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }

    if (findings.blockers.length > 0) {
      lines.push('## Blockers');
      for (const b of findings.blockers) {
        lines.push(`- ${b}`);
      }
      lines.push('');
    }

    lines.push('## Full Worker Outputs');
    for (const w of findings.completed) {
      lines.push(`### ${w.workerId} (${w.workerType ?? 'unknown'}) — ${w.durationMs ?? 0}ms`);
      lines.push(w.result ?? '(no output)');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate a synthesis output from worker results.
   * This is a structured version of the synthesis for programmatic use.
   */
  static synthesize(input: SynthesisInput): SynthesisOutput {
    const findings = SynthesisHelpers.extractFindings(input.workers);

    const nextSteps: string[] = [];

    if (input.phase === 'research') {
      if (findings.completed.length > 0) {
        nextSteps.push('Proceed to implementation phase');
      }
      if (findings.failed.length > 0) {
        nextSteps.push('Re-investigate failed areas with different approach');
      }
    } else if (input.phase === 'implementation') {
      if (findings.completed.length > 0 && findings.failed.length === 0) {
        nextSteps.push('Proceed to verification phase');
      } else {
        nextSteps.push('Fix failed implementations before verifying');
      }
    } else if (input.phase === 'verification') {
      if (findings.blockers.length === 0) {
        nextSteps.push('All verified — task complete');
      } else {
        nextSteps.push('Fix verification failures and re-verify');
      }
    }

    return {
      summary: `${input.phase}: ${findings.completed.length}/${input.workers.length} workers succeeded`,
      keyFindings: findings.keyFindings,
      nextSteps,
      blockers: findings.blockers,
    };
  }

  // ─── Internal Helpers ────────────────────────────────────────────

  /**
   * Extract bullet points and numbered items from worker output.
   * Heuristic-based: looks for lines starting with -, *, •, or numbered.
   */
  private static extractKeyFindings(text: string): string[] {
    const findings: string[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Bullet points: - item, * item, • item
      const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
      if (bulletMatch) {
        const content = bulletMatch[1];
        if (content.length > 10 && content.length < 300) {
          findings.push(content);
        }
        continue;
      }

      // Numbered items: 1. item, 1) item
      const numberMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
      if (numberMatch) {
        const content = numberMatch[1];
        if (content.length > 10 && content.length < 300) {
          findings.push(content);
        }
      }
    }

    // If no bullet/number findings, take first 3 substantive sentences
    if (findings.length === 0) {
      const sentences = text
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 20)
        .slice(0, 3);
      findings.push(...sentences);
    }

    return findings.slice(0, 10); // Cap at 10 findings
  }

  /**
   * Summarize an error message to a single line.
   */
  private static summarizeError(text: string): string {
    // Try to find an explicit error line
    const errorMatch = text.match(/(?:error|failed|exception|TypeError|SyntaxError):\s*(.+)/i);
    if (errorMatch) return errorMatch[1].trim().slice(0, 200);

    // Fallback: first line
    const firstLine = text.split('\n').find(l => l.trim().length > 0);
    return (firstLine ?? text).trim().slice(0, 200);
  }
}
