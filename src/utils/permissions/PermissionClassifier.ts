/**
 * PermissionClassifier.ts — Auto-approve/deny without prompting
 * Classifies tool calls as safe/dangerous based on tool flags + pattern matching.
 * Only auto-approves when confidence > threshold.
 */

import type { PermissionDecision } from './types.js';
import type { Tool } from '../../tools/Tool.js';

export interface ClassificationResult {
  decision: PermissionDecision;
  confidence: number; // 0-1
  reason: string;
}

export class PermissionClassifier {
  static readonly AUTO_APPROVE_THRESHOLD = 0.9;
  static readonly AUTO_DENY_THRESHOLD = 0.95;

  /**
   * Classify a tool call. Returns decision + confidence.
   * Only actionable if confidence exceeds threshold.
   */
  classify(tool: Tool, input: unknown): ClassificationResult {
    // 1. Tool says read-only → high confidence allow
    if (tool.isReadOnly(input)) {
      return { decision: 'allow', confidence: 0.95, reason: 'Tool is read-only for this input' };
    }

    // 2. Tool says destructive → always ask
    if (tool.isDestructive?.(input)) {
      return { decision: 'ask', confidence: 0.95, reason: 'Tool is destructive for this input' };
    }

    // 3. Use tool's classifier input for pattern matching
    const classifierInput = tool.toAutoClassifierInput?.(input) ?? '';
    if (!classifierInput) {
      return { decision: 'ask', confidence: 0.5, reason: 'Tool does not support auto-classification' };
    }

    // 4. Tool-specific pattern matching
    if (tool.name === 'Bash') return this.classifyBash(classifierInput);
    if (tool.name === 'FileWrite' || tool.name === 'FileEdit') return this.classifyFilePath(classifierInput);

    return { decision: 'ask', confidence: 0.5, reason: 'No specific classifier for this tool' };
  }

  /**
   * Can we auto-approve this result without prompting?
   */
  shouldAutoApprove(result: ClassificationResult): boolean {
    return result.decision === 'allow' && result.confidence >= PermissionClassifier.AUTO_APPROVE_THRESHOLD;
  }

  // ─── Bash Command Classifier ────────────────────────────────────────

  private classifyBash(command: string): ClassificationResult {
    const trimmed = command.trim();
    const hasPipe = /\||&&|\|\||;|`|\$\(/.test(trimmed);

    // Safe read-only commands
    const safePatterns = [
      /^ls(\s|$)/, /^pwd$/, /^cat\s/, /^head\s/, /^tail\s/,
      /^echo\s/, /^date$/, /^whoami$/, /^uname/, /^which\s/,
      /^find\s/, /^grep\s/, /^sort\s/, /^wc\s/, /^tree(\s|$)/,
      /^git\s+(status|log|diff|show|branch|remote|config\s+--get)/,
      /^npm\s+(list|view|search|outdated|ls)/, /^node\s+--version/,
      /^python3?\s+--version/, /^tsc\s+--noEmit/, /^npx\s+tsc/,
    ];

    for (const p of safePatterns) {
      if (p.test(trimmed)) {
        return {
          decision: 'allow',
          confidence: hasPipe ? 0.7 : 0.95,
          reason: `Safe read-only command`,
        };
      }
    }

    // Destructive patterns
    const destructivePatterns = [
      /^\s*rm\s/, /^\s*rmdir\s/, /^\s*shred/, /\bdd\s+if=/,
      /^\s*mkfs/, /^\s*chmod\s+(777|666)/, /^\s*chown\s/,
      /git\s+(reset\s+--hard|clean\s+-f|push\s+--force)/,
      /npm\s+uninstall/, /yarn\s+remove/,
      /:(){.*};:/, // fork bomb
    ];

    for (const p of destructivePatterns) {
      if (p.test(trimmed)) {
        return { decision: 'ask', confidence: 0.98, reason: 'Destructive command pattern' };
      }
    }

    // Network commands
    if (/^(curl|wget|ssh|scp|rsync)\s/.test(trimmed)) {
      return { decision: 'ask', confidence: 0.85, reason: 'Network command' };
    }

    // Build/test commands — medium confidence allow
    if (/^(npm\s+(test|run|start|build)|npx\s|yarn\s|pnpm\s|make\s|cargo\s)/.test(trimmed)) {
      return { decision: 'allow', confidence: 0.8, reason: 'Build/test command' };
    }

    return { decision: 'ask', confidence: 0.6, reason: 'Unclassified command' };
  }

  // ─── File Path Classifier ──────────────────────────────────────────

  private classifyFilePath(pathStr: string): ClassificationResult {
    const sensitive = [
      /\.env$/, /\.env\./, /credentials/, /secrets/,
      /id_rsa/, /\.ssh\//, /\.aws\//, /\.gnupg\//,
      /\.production\./, /\.prod\./, /password/i,
      /^\/etc\//, /^\/var\//, /^\/boot\//, /^\/root\//,
    ];

    for (const p of sensitive) {
      if (p.test(pathStr)) {
        return { decision: 'ask', confidence: 0.99, reason: `Sensitive file path` };
      }
    }

    return { decision: 'ask', confidence: 0.5, reason: 'Standard file path' };
  }
}
