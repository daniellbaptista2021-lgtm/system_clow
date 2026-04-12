/**
 * prompt.ts — Summary prompt templates for full compaction
 *
 * Features:
 *   - 9-section summary template (detailed mode)
 *   - Dynamic prompt customization based on conversation content
 *   - Section weighting (emphasize relevant sections)
 *   - Language detection for prompt localization
 *   - Concise and minimal prompt variants for aggressive compaction
 *
 * <analysis> scratchpad is stripped before injection.
 */

import type { ClovMessage } from '../../api/deepseek.js';

// ─── Base Prompt ───────────────────────────────────────────────────────────

export const COMPACT_SYSTEM_PROMPT = `Your task is to create a detailed summary of the conversation so far. This summary will replace the conversation history to free up context. Be thorough — the next agent will only see your summary.

Structure your response in these sections:

1. **Primary Request and Intent**: What the user originally asked for
2. **Key Technical Concepts**: Technologies, patterns, libraries discussed
3. **Files and Code Sections**: Every file read/edited/created with paths and key snippets
4. **Errors and Fixes**: Problems encountered and how they were resolved
5. **Problem Solving**: Approaches tried, what worked, what didn't
6. **All User Messages**: Verbatim list of every user message (critical)
7. **Pending Tasks**: What still needs to be done
8. **Current Work**: Exactly what was being worked on when summary was triggered
9. **Next Step**: The immediate next action to take

Be specific. Include file paths, function names, exact error messages. Do NOT summarize loosely.`;

// ─── Concise Prompt (for aggressive strategy) ──────────────────────────────

const CONCISE_PROMPT = `Summarize this conversation concisely. Focus on:
1. What the user asked for
2. Files modified (with paths)
3. What's been completed
4. What still needs to be done
5. Current state and next step

Keep it under 2000 words. Be precise — include file paths and function names.`;

// ─── Minimal Prompt (for emergency strategy) ───────────────────────────────

const MINIMAL_PROMPT = `Summarize the key points of this conversation in bullet form:
- User's goal
- Files changed (paths only)
- Remaining tasks
- Next action

Maximum 500 words.`;

// ─── Prompt Style Selection ────────────────────────────────────────────────

type PromptStyle = 'detailed' | 'concise' | 'minimal';

function getBasePromptForStyle(style: PromptStyle): string {
  switch (style) {
    case 'detailed': return COMPACT_SYSTEM_PROMPT;
    case 'concise': return CONCISE_PROMPT;
    case 'minimal': return MINIMAL_PROMPT;
  }
}

// ─── Section Weighting ─────────────────────────────────────────────────────

interface SectionWeight {
  section: string;
  weight: number; // 0-10, higher = more important
  reason: string;
}

/**
 * Analyze the conversation to determine which summary sections
 * deserve more emphasis. Returns section weights.
 */
function computeSectionWeights(messages: ClovMessage[]): SectionWeight[] {
  const weights: SectionWeight[] = [];

  let hasToolCalls = false;
  let hasErrors = false;
  let hasFileOperations = false;
  let hasMultipleUserMessages = false;
  let userMessageCount = 0;

  for (const msg of messages) {
    if (msg.role === 'user') userMessageCount++;
    if (msg.role === 'assistant' && msg.tool_calls) {
      hasToolCalls = true;
      for (const tc of msg.tool_calls) {
        if (['Read', 'FileRead', 'Edit', 'FileEdit', 'Write', 'FileWrite'].includes(tc.function.name)) {
          hasFileOperations = true;
        }
      }
    }
    if (msg.content && /\b(error|exception|fail|TypeError|SyntaxError)\b/i.test(msg.content)) {
      hasErrors = true;
    }
  }
  hasMultipleUserMessages = userMessageCount > 3;

  // Always important
  weights.push({ section: 'Primary Request', weight: 10, reason: 'always critical' });
  weights.push({ section: 'Current Work', weight: 9, reason: 'always critical for continuity' });
  weights.push({ section: 'Next Step', weight: 9, reason: 'always critical for continuity' });

  // Conditional weights
  if (hasFileOperations) {
    weights.push({ section: 'Files and Code', weight: 9, reason: 'file operations detected' });
  } else {
    weights.push({ section: 'Files and Code', weight: 4, reason: 'no file operations' });
  }

  if (hasErrors) {
    weights.push({ section: 'Errors and Fixes', weight: 8, reason: 'errors detected' });
  } else {
    weights.push({ section: 'Errors and Fixes', weight: 2, reason: 'no errors' });
  }

  if (hasToolCalls) {
    weights.push({ section: 'Problem Solving', weight: 7, reason: 'tool calls indicate active work' });
  } else {
    weights.push({ section: 'Problem Solving', weight: 3, reason: 'no tool calls' });
  }

  if (hasMultipleUserMessages) {
    weights.push({ section: 'User Messages', weight: 8, reason: 'many user messages — instructions may be scattered' });
  } else {
    weights.push({ section: 'User Messages', weight: 5, reason: 'few user messages' });
  }

  weights.push({ section: 'Pending Tasks', weight: 7, reason: 'always important for continuity' });
  weights.push({ section: 'Key Technical Concepts', weight: 5, reason: 'baseline importance' });

  return weights.sort((a, b) => b.weight - a.weight);
}

// ─── Language Detection ────────────────────────────────────────────────────

type DetectedLanguage = 'en' | 'zh' | 'ja' | 'ko' | 'es' | 'other';

/**
 * Simple heuristic language detection based on character distribution
 * in user messages. Used to add a note to the prompt about output language.
 */
function detectConversationLanguage(messages: ClovMessage[]): DetectedLanguage {
  // Collect all user message text
  let userText = '';
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      userText += msg.content + ' ';
    }
  }

  if (userText.length < 20) return 'en';

  // Character range checks
  const cjkChars = (userText.match(/[\u4e00-\u9fff]/g) || []).length;
  const hiraganaKatakana = (userText.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (userText.match(/[\uac00-\ud7af]/g) || []).length;
  const spanishChars = (userText.match(/[áéíóúñ¿¡]/gi) || []).length;
  const totalChars = userText.length;

  // Thresholds (>10% of text is in that script)
  if (hiraganaKatakana > totalChars * 0.05) return 'ja';
  if (hangul > totalChars * 0.1) return 'ko';
  if (cjkChars > totalChars * 0.1) return 'zh';
  if (spanishChars > totalChars * 0.02) return 'es';

  return 'en';
}

/**
 * Get a language instruction to append to the prompt, if the conversation
 * is not in English. This ensures the summary is in the same language
 * as the user's messages.
 */
function getLanguageInstruction(lang: DetectedLanguage): string {
  switch (lang) {
    case 'zh': return '\n\nIMPORTANT: The user communicates in Chinese. Write your summary in Chinese (Simplified).';
    case 'ja': return '\n\nIMPORTANT: The user communicates in Japanese. Write your summary in Japanese.';
    case 'ko': return '\n\nIMPORTANT: The user communicates in Korean. Write your summary in Korean.';
    case 'es': return '\n\nIMPORTANT: The user communicates in Spanish. Write your summary in Spanish.';
    default: return '';
  }
}

// ─── Dynamic Prompt Builder ────────────────────────────────────────────────

/**
 * Build a customized summary prompt based on conversation content.
 *
 * Analyzes the conversation to:
 *   1. Select the right base prompt (detailed/concise/minimal)
 *   2. Add emphasis notes for high-weight sections
 *   3. Detect language and add localization instruction
 */
export function buildDynamicPrompt(
  messages: ClovMessage[],
  style: PromptStyle = 'detailed',
): string {
  const base = getBasePromptForStyle(style);
  const parts: string[] = [base];

  // Only add dynamic sections for detailed mode
  if (style === 'detailed') {
    const weights = computeSectionWeights(messages);

    // Find sections that deserve extra emphasis (weight >= 8)
    const highPriority = weights.filter((w) => w.weight >= 8);
    if (highPriority.length > 0) {
      const emphasisNote = highPriority
        .map((w) => `- "${w.section}" (${w.reason})`)
        .join('\n');
      parts.push(`\nPay extra attention to these sections:\n${emphasisNote}`);
    }
  }

  // Language detection and instruction
  const lang = detectConversationLanguage(messages);
  const langInstruction = getLanguageInstruction(lang);
  if (langInstruction) {
    parts.push(langInstruction);
  }

  return parts.join('\n');
}

// ─── Format Summary Output ─────────────────────────────────────────────────

/** Strip <analysis> scratchpad, keep only <summary> or full text. */
export function formatCompactSummary(raw: string): string {
  // Try to extract <summary> block
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) return summaryMatch[1].trim();

  // Strip <analysis> blocks (scratchpad)
  let cleaned = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');

  // Strip <thinking> blocks (some models use this)
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

  return cleaned.trim();
}
