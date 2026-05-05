/**
 * SkillContextProvider.ts — Build SkillContext from current state
 *
 * Based on Claude Code's skillContextProvider.ts (~150 lines)
 *
 * Creates context objects for skill matching from:
 *   - User messages (message-triggered matching)
 *   - Tool usage (tool-triggered matching)
 *   - File operations (glob-triggered matching)
 *
 * Features:
 *   - Language detection (pt-BR, en, es)
 *   - File extension extraction
 *   - Context normalization
 *   - Multi-source context building
 */

import type { SkillContext } from './types.js';

// ─── Language Patterns ──────────────────────────────────────────────────────

const PT_WORDS = /\b(você|voce|que|para|com|não|nao|isso|meu|minha|fazer|como|quero|preciso|ajuda|obrigado|por favor|então|entao)\b/gi;
const EN_WORDS = /\b(you|the|with|that|this|from|have|been|what|how|please|help|want|need|make|create)\b/gi;
const ES_WORDS = /\b(usted|como|para|con|esto|hacer|quiero|necesito|ayuda|gracias|por favor)\b/gi;

// ════════════════════════════════════════════════════════════════════════════
// SkillContextProvider Class
// ════════════════════════════════════════════════════════════════════════════

export class SkillContextProvider {
  /**
   * Build context from a user message.
   */
  buildFromMessage(params: {
    message: string;
    sessionId: string;
    cwd: string;
    workspaceRoot: string;
    isFirstMessage: boolean;
    tier?: string;
  }): SkillContext {
    return {
      userMessage: params.message,
      sessionId: params.sessionId,
      cwd: params.cwd,
      workspaceRoot: params.workspaceRoot,
      isFirstMessage: params.isFirstMessage,
      tier: params.tier,
      language: this.detectLanguage(params.message),
    };
  }

  /**
   * Build context from a tool use event.
   */
  buildFromToolUse(params: {
    toolName: string;
    toolInput: unknown;
    sessionId: string;
    cwd: string;
    workspaceRoot: string;
    tier?: string;
  }): SkillContext {
    const input = params.toolInput as Record<string, unknown> | undefined;
    const filePath = (input?.path ?? input?.file_path ?? input?.filePath) as string | undefined;

    return {
      toolName: params.toolName,
      toolInput: params.toolInput,
      filePath,
      sessionId: params.sessionId,
      cwd: params.cwd,
      workspaceRoot: params.workspaceRoot,
      isFirstMessage: false,
      tier: params.tier,
    };
  }

  /**
   * Build context from a hook event.
   */
  buildFromHookEvent(params: {
    hookEvent: string;
    sessionId: string;
    cwd: string;
    workspaceRoot: string;
    filePath?: string;
    tier?: string;
  }): SkillContext {
    return {
      hookEvent: params.hookEvent,
      filePath: params.filePath,
      sessionId: params.sessionId,
      cwd: params.cwd,
      workspaceRoot: params.workspaceRoot,
      isFirstMessage: false,
      tier: params.tier,
    };
  }

  /**
   * Detect primary language of a message.
   * Returns ISO language code.
   */
  private detectLanguage(message: string): string {
    const ptCount = (message.match(PT_WORDS) ?? []).length;
    const enCount = (message.match(EN_WORDS) ?? []).length;
    const esCount = (message.match(ES_WORDS) ?? []).length;

    const max = Math.max(ptCount, enCount, esCount);
    if (max === 0) return 'en'; // default

    if (ptCount === max) return 'pt';
    if (esCount === max) return 'es';
    return 'en';
  }
}
