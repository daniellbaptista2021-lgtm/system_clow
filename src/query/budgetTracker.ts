/**
 * budgetTracker.ts — USD / turns / tokens enforcement
 *
 * Based on Claude Code's budgetTracker.ts (~200 lines)
 *
 * Checked before each turn and during streaming.
 * Enforces multiple limits simultaneously:
 *   - Max USD cost
 *   - Max number of turns
 *   - Max tokens per turn
 *
 * Features:
 *   - Pre-turn budget check
 *   - Mid-turn token check
 *   - Cost recording with model tracking
 *   - Budget warnings at thresholds
 *   - Budget remaining calculation
 *   - Per-model cost breakdown
 *   - Statistics
 */

import type { TokenUsage, ResultSubtype } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const WARNING_THRESHOLD_PERCENT = 80; // Warn when 80% of budget used
const CRITICAL_THRESHOLD_PERCENT = 95;

// ─── Types ──────────────────────────────────────────────────────────────────

type BudgetWarningLevel = 'none' | 'warning' | 'critical' | 'exceeded';

interface BudgetStats {
  totalCostUsd: number;
  turnCount: number;
  tokensThisTurn: number;
  maxBudgetUsd?: number;
  maxTurns?: number;
  maxTokensPerTurn?: number;
  budgetUsedPercent?: number;
  warningLevel: BudgetWarningLevel;
  costPerTurn: number;
}

interface ModelCostEntry {
  model: string;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

// ════════════════════════════════════════════════════════════════════════════
// BudgetTracker Class
// ════════════════════════════════════════════════════════════════════════════

export class BudgetTracker {
  private totalCostUsd: number = 0;
  private turnCount: number = 0;
  private tokensThisTurn: number = 0;
  private modelCosts = new Map<string, ModelCostEntry>();
  private costHistory: Array<{ turnNumber: number; costUsd: number; model: string; timestamp: number }> = [];

  constructor(
    private readonly maxTurns?: number,
    private readonly maxBudgetUsd?: number,
    private readonly maxTokensPerTurn?: number,
  ) {}

  /**
   * Check BEFORE attempting next API call.
   * Returns null if OK, or a ResultSubtype if limit exceeded.
   */
  checkBeforeTurn(): ResultSubtype | null {
    if (this.maxBudgetUsd !== undefined && this.totalCostUsd >= this.maxBudgetUsd) {
      return 'error_max_budget_usd';
    }
    if (this.maxTurns !== undefined && this.turnCount >= this.maxTurns) {
      return 'error_max_turns';
    }
    return null;
  }

  /**
   * Check token budget DURING turn.
   * Returns null if OK, or ResultSubtype if limit exceeded.
   */
  checkTokensDuringTurn(): ResultSubtype | null {
    if (this.maxTokensPerTurn !== undefined && this.tokensThisTurn >= this.maxTokensPerTurn) {
      return 'error_max_tokens';
    }
    return null;
  }

  /**
   * Record a completed turn with its cost.
   */
  recordTurn(costUsd: number, model?: string): void {
    this.turnCount++;
    this.totalCostUsd += costUsd;
    this.tokensThisTurn = 0;

    if (model) {
      const existing = this.modelCosts.get(model);
      if (existing) {
        existing.costUsd += costUsd;
        existing.turns++;
      } else {
        this.modelCosts.set(model, { model, costUsd, turns: 1, inputTokens: 0, outputTokens: 0 });
      }
    }

    this.costHistory.push({
      turnNumber: this.turnCount,
      costUsd,
      model: model ?? 'unknown',
      timestamp: Date.now(),
    });
  }

  /**
   * Record tokens used during current turn.
   */
  recordTokens(tokens: number): void {
    this.tokensThisTurn += tokens;
  }

  /**
   * Add cost without incrementing turn count (e.g., compaction cost).
   */
  addCost(costUsd: number): void {
    this.totalCostUsd += costUsd;
  }

  /**
   * Reset turn token counter.
   */
  resetTurnTokens(): void {
    this.tokensThisTurn = 0;
  }

  // ─── Warning Level ───────────────────────────────────────────────

  /**
   * Get current budget warning level.
   */
  getWarningLevel(): BudgetWarningLevel {
    if (!this.maxBudgetUsd) return 'none';
    const pct = (this.totalCostUsd / this.maxBudgetUsd) * 100;
    if (pct >= 100) return 'exceeded';
    if (pct >= CRITICAL_THRESHOLD_PERCENT) return 'critical';
    if (pct >= WARNING_THRESHOLD_PERCENT) return 'warning';
    return 'none';
  }

  // ─── Getters ─────────────────────────────────────────────────────

  getTotalCost(): number { return this.totalCostUsd; }
  getTurnCount(): number { return this.turnCount; }
  getTokensThisTurn(): number { return this.tokensThisTurn; }

  getRemainingBudget(): number | undefined {
    return this.maxBudgetUsd !== undefined
      ? Math.max(0, this.maxBudgetUsd - this.totalCostUsd)
      : undefined;
  }

  getBudgetUsedPercent(): number | undefined {
    if (!this.maxBudgetUsd) return undefined;
    return Math.min(100, (this.totalCostUsd / this.maxBudgetUsd) * 100);
  }

  getCostPerTurn(): number {
    return this.turnCount > 0 ? this.totalCostUsd / this.turnCount : 0;
  }

  getModelCosts(): ModelCostEntry[] {
    return [...this.modelCosts.values()];
  }

  /**
   * Get full budget statistics.
   */
  getStats(): BudgetStats {
    return {
      totalCostUsd: this.totalCostUsd,
      turnCount: this.turnCount,
      tokensThisTurn: this.tokensThisTurn,
      maxBudgetUsd: this.maxBudgetUsd,
      maxTurns: this.maxTurns,
      maxTokensPerTurn: this.maxTokensPerTurn,
      budgetUsedPercent: this.getBudgetUsedPercent(),
      warningLevel: this.getWarningLevel(),
      costPerTurn: this.getCostPerTurn(),
    };
  }

  /**
   * Get cost history for charting.
   */
  getCostHistory(): ReadonlyArray<{ turnNumber: number; costUsd: number; model: string; timestamp: number }> {
    return this.costHistory;
  }
}
