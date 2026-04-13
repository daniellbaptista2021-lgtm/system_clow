/**
 * bootstrap/state.ts — The Global State Singleton (DAG Leaf Pattern)
 *
 * This is the LEAF of the module dependency graph.
 * Every module can import it, but it imports almost nothing.
 * DO NOT add heavy imports here — this would create circular dependencies.
 *
 * Based on Claude Code's bootstrap/state.ts (1,759 lines)
 * Implements: Identity, Cost Tracking, Turn Metrics, API State, Cache Latches, Feature State
 */

import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnMetrics {
  toolDurationMs: number;
  hookCount: number;
  classifierCount: number;
  toolUseCount: number;
  startTime: number;
}

export interface CostEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
}

interface ExecutionContext {
  sessionId?: string;
  cwd?: string;
  originalCwd?: string;
  projectRoot?: string;
  tenantId?: string;
}

// ─── The State Singleton ────────────────────────────────────────────────────
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// Identity
let sessionId: string = randomUUID();
let originalCwd: string = process.cwd();
let cwd: string = process.cwd();
let projectRoot: string = process.cwd();
let isGitRepo: boolean = false;
let gitBranch: string | undefined;

// Cost Tracking
let totalCostUSD: number = 0;
let totalAPIDurationMs: number = 0;
let totalInputTokens: number = 0;
let totalOutputTokens: number = 0;
const costHistory: CostEntry[] = [];
const modelUsage: Map<string, ModelUsage> = new Map();

// Turn Metrics (reset each query)
let currentTurnMetrics: TurnMetrics = {
  toolDurationMs: 0,
  hookCount: 0,
  classifierCount: 0,
  toolUseCount: 0,
  startTime: Date.now(),
};

// API State
let lastAPIRequestTimestamp: number = 0;
let lastMainRequestId: string | undefined;
let lastApiCompletionTimestamp: number = 0;

// Cache Latches — sticky-on: once true, NEVER goes back to false
// This prevents prompt cache busting from feature toggles during a session
let autoModeHeaderLatched: boolean | null = null;
let fastModeHeaderLatched: boolean | null = null;

// Permission State
let permissionMode: PermissionMode = 'default';
let prePlanPermissionMode: PermissionMode | undefined;
const sessionPermissionRules: Array<{
  type: 'allow' | 'deny' | 'ask';
  toolName: string;
  ruleContent?: string;
}> = [];

// Feature State
const invokedSkills: Set<string> = new Set();
const discoveredSkillNames: Set<string> = new Set();
let customTitle: string | undefined;
let aiTitle: string | undefined;

// Scroll drain suspension
let scrollDraining = false;
const SCROLL_DRAIN_IDLE_MS = 150;
let scrollDrainTimeout: ReturnType<typeof setTimeout> | undefined;

// Abort controller for the current query
let currentAbortController: AbortController | null = null;
const executionContextStorage = new AsyncLocalStorage<ExecutionContext>();

// ─── Getters ────────────────────────────────────────────────────────────────

export function getSessionId(): string {
  return executionContextStorage.getStore()?.sessionId || sessionId;
}

export function getOriginalCwd(): string {
  return executionContextStorage.getStore()?.originalCwd || originalCwd;
}

export function getCwd(): string {
  return executionContextStorage.getStore()?.cwd || cwd;
}

export function getProjectRoot(): string {
  return executionContextStorage.getStore()?.projectRoot || projectRoot;
}

export function getIsGitRepo(): boolean {
  return isGitRepo;
}

export function getGitBranch(): string | undefined {
  return gitBranch;
}

export function getTotalCostUSD(): number {
  return totalCostUSD;
}

export function getTotalAPIDurationMs(): number {
  return totalAPIDurationMs;
}

export function getTotalInputTokens(): number {
  return totalInputTokens;
}

export function getTotalOutputTokens(): number {
  return totalOutputTokens;
}

export function getCostHistory(): ReadonlyArray<CostEntry> {
  return costHistory;
}

export function getModelUsage(): ReadonlyMap<string, ModelUsage> {
  return modelUsage;
}

export function getCurrentTurnMetrics(): Readonly<TurnMetrics> {
  return currentTurnMetrics;
}

export function getLastAPIRequestTimestamp(): number {
  return lastAPIRequestTimestamp;
}

export function getLastMainRequestId(): string | undefined {
  return lastMainRequestId;
}

export function getLastApiCompletionTimestamp(): number {
  return lastApiCompletionTimestamp;
}

export function getPermissionMode(): PermissionMode {
  return permissionMode;
}

export function getPrePlanPermissionMode(): PermissionMode | undefined {
  return prePlanPermissionMode;
}

export function getSessionPermissionRules() {
  return sessionPermissionRules;
}

export function getInvokedSkills(): ReadonlySet<string> {
  return invokedSkills;
}

export function getDiscoveredSkillNames(): ReadonlySet<string> {
  return discoveredSkillNames;
}

export function getCustomTitle(): string | undefined {
  return customTitle;
}

export function getAiTitle(): string | undefined {
  return aiTitle;
}

export function getAutoModeHeaderLatched(): boolean | null {
  return autoModeHeaderLatched;
}

export function getFastModeHeaderLatched(): boolean | null {
  return fastModeHeaderLatched;
}

export function getIsScrollDraining(): boolean {
  return scrollDraining;
}

export function getCurrentAbortController(): AbortController | null {
  return currentAbortController;
}

// ─── Setters ────────────────────────────────────────────────────────────────

export function setSessionId(id: string): void {
  sessionId = id;
}

export function setCwd(newCwd: string, _oldCwd?: string): void {
  cwd = newCwd;
}

export function setOriginalCwd(value: string): void {
  originalCwd = value;
}

export function setProjectRoot(root: string): void {
  projectRoot = root;
}

export function setIsGitRepo(value: boolean): void {
  isGitRepo = value;
}

export function setGitBranch(branch: string | undefined): void {
  gitBranch = branch;
}

export function setPermissionMode(mode: PermissionMode): void {
  permissionMode = mode;
}

export function setPrePlanPermissionMode(mode: PermissionMode | undefined): void {
  prePlanPermissionMode = mode;
}

export function setCustomTitle(title: string): void {
  customTitle = title;
}

export function setAiTitle(title: string): void {
  aiTitle = title;
}

export function setCurrentAbortController(controller: AbortController | null): void {
  currentAbortController = controller;
}

export function runWithExecutionContext<T>(
  context: ExecutionContext,
  fn: () => T,
): T {
  const current = executionContextStorage.getStore() || {};
  return executionContextStorage.run({ ...current, ...context }, fn);
}

// ─── Cost Tracking ──────────────────────────────────────────────────────────

export function addCost(entry: CostEntry): void {
  totalCostUSD += entry.costUsd;
  totalInputTokens += entry.inputTokens;
  totalOutputTokens += entry.outputTokens;
  costHistory.push(entry);

  const existing = modelUsage.get(entry.model);
  if (existing) {
    existing.inputTokens += entry.inputTokens;
    existing.outputTokens += entry.outputTokens;
  } else {
    modelUsage.set(entry.model, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }
}

export function addAPIDuration(ms: number): void {
  totalAPIDurationMs += ms;
}

export function setLastAPIRequestTimestamp(ts: number): void {
  lastAPIRequestTimestamp = ts;
}

export function setLastMainRequestId(id: string): void {
  lastMainRequestId = id;
}

export function setLastApiCompletionTimestamp(ts: number): void {
  lastApiCompletionTimestamp = ts;
}

// ─── Turn Metrics ───────────────────────────────────────────────────────────

export function resetTurnMetrics(): void {
  currentTurnMetrics = {
    toolDurationMs: 0,
    hookCount: 0,
    classifierCount: 0,
    toolUseCount: 0,
    startTime: Date.now(),
  };
}

export function addToolDuration(ms: number): void {
  currentTurnMetrics.toolDurationMs += ms;
}

export function incrementHookCount(): void {
  currentTurnMetrics.hookCount++;
}

export function incrementClassifierCount(): void {
  currentTurnMetrics.classifierCount++;
}

export function incrementToolUseCount(): void {
  currentTurnMetrics.toolUseCount++;
}

// ─── Cache Latches (sticky-on) ─────────────────────────────────────────────

export function latchAutoModeHeader(): void {
  autoModeHeaderLatched = true;
}

export function latchFastModeHeader(): void {
  fastModeHeaderLatched = true;
}

// ─── Permission Rules ───────────────────────────────────────────────────────

export function addSessionPermissionRule(rule: {
  type: 'allow' | 'deny' | 'ask';
  toolName: string;
  ruleContent?: string;
}): void {
  sessionPermissionRules.push(rule);
}

export function clearSessionPermissionRules(): void {
  sessionPermissionRules.length = 0;
}

// ─── Skills ─────────────────────────────────────────────────────────────────

export function addInvokedSkill(name: string): void {
  invokedSkills.add(name);
}

export function addDiscoveredSkillName(name: string): void {
  discoveredSkillNames.add(name);
}

// ─── Scroll Drain ───────────────────────────────────────────────────────────

export function markScrollActivity(): void {
  scrollDraining = true;
  if (scrollDrainTimeout) clearTimeout(scrollDrainTimeout);
  scrollDrainTimeout = setTimeout(() => {
    scrollDraining = false;
  }, SCROLL_DRAIN_IDLE_MS);
}

// ─── Full Reset (for testing) ───────────────────────────────────────────────

export function resetAllState(): void {
  sessionId = randomUUID();
  originalCwd = process.cwd();
  cwd = process.cwd();
  projectRoot = process.cwd();
  isGitRepo = false;
  gitBranch = undefined;
  totalCostUSD = 0;
  totalAPIDurationMs = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  costHistory.length = 0;
  modelUsage.clear();
  resetTurnMetrics();
  lastAPIRequestTimestamp = 0;
  lastMainRequestId = undefined;
  lastApiCompletionTimestamp = 0;
  autoModeHeaderLatched = null;
  fastModeHeaderLatched = null;
  permissionMode = 'default';
  prePlanPermissionMode = undefined;
  sessionPermissionRules.length = 0;
  invokedSkills.clear();
  discoveredSkillNames.clear();
  customTitle = undefined;
  aiTitle = undefined;
  scrollDraining = false;
  currentAbortController = null;
  turnNumber = 0;
  sessionStartTime = Date.now();
  maxBudgetUsd = undefined;
  model = process.env.CLOW_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  agentDepth = 0;
  parentSessionId = undefined;
  tenantId = undefined;
  tier = 'one';
  planModeActive = false;
  compactCount = 0;
  contextTokens = 0;
  lastCompactTimestamp = 0;
  toolsUsed.clear();
  errorHistory.length = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Extended State — Session Metadata
// ════════════════════════════════════════════════════════════════════════════

// Turn counter
let turnNumber: number = 0;
let sessionStartTime: number = Date.now();
let maxBudgetUsd: number | undefined;
let model: string = process.env.CLOW_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
let agentDepth: number = 0;
let parentSessionId: string | undefined;
let tenantId: string | undefined;
let tier: string = 'one';

// Plan Mode
let planModeActive: boolean = false;

// Context tracking
let compactCount: number = 0;
let contextTokens: number = 0;
let lastCompactTimestamp: number = 0;

// Tool usage tracking
const toolsUsed = new Set<string>();

// Error history
const errorHistory: Array<{ error: string; timestamp: number; context?: string }> = [];

// ─── Extended Getters ──────────────────────────────────────────────────────

export function getTurnNumber(): number { return turnNumber; }
export function getSessionStartTime(): number { return sessionStartTime; }
export function getMaxBudgetUsd(): number | undefined { return maxBudgetUsd; }
export function getModel(): string { return model; }
export function getAgentDepth(): number { return agentDepth; }
export function getParentSessionId(): string | undefined { return parentSessionId; }
export function getTenantId(): string | undefined { return tenantId; }
export function getTier(): string { return tier; }
export function isPlanModeActive(): boolean { return planModeActive; }
export function getCompactCount(): number { return compactCount; }
export function getContextTokens(): number { return contextTokens; }
export function getLastCompactTimestamp(): number { return lastCompactTimestamp; }
export function getToolsUsed(): ReadonlySet<string> { return toolsUsed; }
export function getErrorHistory(): ReadonlyArray<{ error: string; timestamp: number; context?: string }> { return errorHistory; }

// ─── Extended Setters ──────────────────────────────────────────────────────

export function incrementTurn(): number { return ++turnNumber; }
export function setMaxBudgetUsd(budget: number | undefined): void { maxBudgetUsd = budget; }
export function setModel(m: string): void { model = m; }
export function setAgentDepth(depth: number): void { agentDepth = depth; }
export function setParentSessionId(id: string | undefined): void { parentSessionId = id; }
export function setTenantId(id: string | undefined): void { tenantId = id; }
export function setTier(t: string): void { tier = t; }
export function setPlanModeActive(active: boolean): void { planModeActive = active; }
export function setContextTokens(tokens: number): void { contextTokens = tokens; }

export function recordCompaction(): void {
  compactCount++;
  lastCompactTimestamp = Date.now();
}

export function recordToolUsed(toolName: string): void {
  toolsUsed.add(toolName);
}

export function recordError(error: string, context?: string): void {
  errorHistory.push({ error, timestamp: Date.now(), context });
  if (errorHistory.length > 100) errorHistory.shift();
}

// ════════════════════════════════════════════════════════════════════════════
// Computed Properties
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get session duration in milliseconds.
 */
export function getSessionDurationMs(): number {
  return Date.now() - sessionStartTime;
}

/**
 * Check if budget has been exceeded.
 */
export function isBudgetExceeded(): boolean {
  if (!maxBudgetUsd) return false;
  return totalCostUSD >= maxBudgetUsd;
}

/**
 * Get budget remaining in USD.
 */
export function getBudgetRemainingUsd(): number | null {
  if (!maxBudgetUsd) return null;
  return Math.max(0, maxBudgetUsd - totalCostUSD);
}

/**
 * Get budget usage as a percentage (0-100).
 */
export function getBudgetUsagePercent(): number | null {
  if (!maxBudgetUsd || maxBudgetUsd === 0) return null;
  return Math.min(100, (totalCostUSD / maxBudgetUsd) * 100);
}

/**
 * Get average cost per turn.
 */
export function getAvgCostPerTurn(): number {
  return turnNumber > 0 ? totalCostUSD / turnNumber : 0;
}

/**
 * Get average tokens per turn.
 */
export function getAvgTokensPerTurn(): number {
  return turnNumber > 0 ? (totalInputTokens + totalOutputTokens) / turnNumber : 0;
}

/**
 * Get cache hit rate across all models.
 */
export function getCacheHitRate(): number {
  let totalCache = 0;
  let totalInput = 0;
  for (const usage of modelUsage.values()) {
    totalCache += usage.cacheReadTokens;
    totalInput += usage.inputTokens;
  }
  if (totalInput === 0) return 0;
  return totalCache / totalInput;
}

/**
 * Get title (custom > AI-generated > undefined).
 */
export function getTitle(): string | undefined {
  return customTitle ?? aiTitle;
}

// ════════════════════════════════════════════════════════════════════════════
// Snapshot (for serialization / session save)
// ════════════════════════════════════════════════════════════════════════════

export interface StateSnapshot {
  sessionId: string;
  cwd: string;
  projectRoot: string;
  isGitRepo: boolean;
  gitBranch?: string;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnNumber: number;
  model: string;
  permissionMode: PermissionMode;
  agentDepth: number;
  tenantId?: string;
  tier: string;
  planModeActive: boolean;
  compactCount: number;
  contextTokens: number;
  sessionDurationMs: number;
  toolsUsedCount: number;
  title?: string;
}

/**
 * Create a snapshot of current state.
 */
export function snapshot(): StateSnapshot {
  return {
    sessionId,
    cwd,
    projectRoot,
    isGitRepo,
    gitBranch,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    turnNumber,
    model,
    permissionMode,
    agentDepth,
    tenantId,
    tier,
    planModeActive,
    compactCount,
    contextTokens,
    sessionDurationMs: getSessionDurationMs(),
    toolsUsedCount: toolsUsed.size,
    title: getTitle(),
  };
}

/**
 * Create a cost summary string.
 */
export function costSummary(): string {
  const parts: string[] = [];
  parts.push(`$${totalCostUSD.toFixed(4)} USD`);
  parts.push(`${totalInputTokens + totalOutputTokens} tokens`);
  parts.push(`${turnNumber} turns`);
  if (maxBudgetUsd) {
    parts.push(`${getBudgetUsagePercent()?.toFixed(0)}% budget used`);
  }
  const hitRate = getCacheHitRate();
  if (hitRate > 0) {
    parts.push(`${(hitRate * 100).toFixed(0)}% cache hit`);
  }
  return parts.join(' | ');
}

// ════════════════════════════════════════════════════════════════════════════
// Feature Flags
// ════════════════════════════════════════════════════════════════════════════

const featureFlags: Record<string, boolean> = {
  HISTORY_SNIP: true,
  REACTIVE_COMPACT: true,
  TOMBSTONE: true,
  TOOL_RESULT_BUDGET: true,
  AUTO_COMPACT: true,
  MICRO_COMPACT: true,
  SESSION_MEMORY_COMPACT: true,
  SKILL_INJECTION: true,
  HOOK_SYSTEM: true,
  PLUGIN_SYSTEM: true,
  MCP_CLIENT: true,
  AGENT_TOOL: true,
  PLAN_MODE: true,
  PROMPT_CACHE: true,
  MULTI_TENANT: false,
  WHATSAPP_ADAPTER: false,
};

export function getFeatureFlag(flag: string): boolean {
  return featureFlags[flag] ?? false;
}

export function setFeatureFlag(flag: string, value: boolean): void {
  featureFlags[flag] = value;
}

export function getAllFeatureFlags(): Readonly<Record<string, boolean>> {
  return { ...featureFlags };
}

export function getEnabledFeatures(): string[] {
  return Object.entries(featureFlags)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

export function getDisabledFeatures(): string[] {
  return Object.entries(featureFlags)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

// ════════════════════════════════════════════════════════════════════════════
// Environment Detection
// ════════════════════════════════════════════════════════════════════════════

export type RuntimeEnvironment = 'cli' | 'server' | 'test' | 'worker' | 'agent';

let runtimeEnv: RuntimeEnvironment = 'cli';
let isInteractive: boolean = true;
let isTTY: boolean = typeof process.stdout?.isTTY === 'boolean' ? process.stdout.isTTY : false;
let isCI: boolean = !!(process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.GITHUB_ACTIONS);
let isDebug: boolean = process.env.CLOW_DEBUG === '1' || process.env.DEBUG === '1';
let logLevel: 'debug' | 'info' | 'warn' | 'error' = isDebug ? 'debug' : 'info';
let clowVersion: string = '0.1.0';

export function getRuntimeEnvironment(): RuntimeEnvironment { return runtimeEnv; }
export function setRuntimeEnvironment(env: RuntimeEnvironment): void { runtimeEnv = env; }
export function getIsInteractive(): boolean { return isInteractive; }
export function setIsInteractive(value: boolean): void { isInteractive = value; }
export function getIsTTY(): boolean { return isTTY; }
export function getIsCI(): boolean { return isCI; }
export function getIsDebug(): boolean { return isDebug; }
export function setIsDebug(value: boolean): void { isDebug = value; logLevel = value ? 'debug' : 'info'; }
export function getLogLevel(): string { return logLevel; }
export function setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void { logLevel = level; }
export function getClowVersion(): string { return clowVersion; }
export function setClowVersion(version: string): void { clowVersion = version; }

// ════════════════════════════════════════════════════════════════════════════
// Context Window State
// ════════════════════════════════════════════════════════════════════════════

let maxContextTokens: number = 200_000; // Claude Sonnet default
let currentContextUsage: number = 0;
let systemPromptTokens: number = 0;
let dynamicContextTokens: number = 0;
let lastContextCalculation: number = 0;

export function getMaxContextTokens(): number { return maxContextTokens; }
export function setMaxContextTokens(tokens: number): void { maxContextTokens = tokens; }
export function getCurrentContextUsage(): number { return currentContextUsage; }
export function setCurrentContextUsage(tokens: number): void { currentContextUsage = tokens; lastContextCalculation = Date.now(); }
export function getSystemPromptTokens(): number { return systemPromptTokens; }
export function setSystemPromptTokens(tokens: number): void { systemPromptTokens = tokens; }
export function getDynamicContextTokens(): number { return dynamicContextTokens; }
export function setDynamicContextTokens(tokens: number): void { dynamicContextTokens = tokens; }

/**
 * Get remaining context window capacity.
 */
export function getContextRemainingTokens(): number {
  return Math.max(0, maxContextTokens - currentContextUsage);
}

/**
 * Get context usage as percentage (0-100).
 */
export function getContextUsagePercent(): number {
  if (maxContextTokens === 0) return 0;
  return Math.min(100, (currentContextUsage / maxContextTokens) * 100);
}

/**
 * Check if context window is in warning zone.
 */
export function isContextWarning(warningBuffer: number = 20_000): boolean {
  return getContextRemainingTokens() <= warningBuffer;
}

/**
 * Check if context window is critically full.
 */
export function isContextCritical(criticalBuffer: number = 5_000): boolean {
  return getContextRemainingTokens() <= criticalBuffer;
}

// ════════════════════════════════════════════════════════════════════════════
// Multi-Tenant State
// ════════════════════════════════════════════════════════════════════════════

interface TenantState {
  id: string;
  name?: string;
  tier: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  features: string[];
  createdAt: number;
}

let currentTenant: TenantState | null = null;

export function getCurrentTenant(): TenantState | null { return currentTenant; }

export function setCurrentTenant(tenant: TenantState | null): void {
  currentTenant = tenant;
  if (tenant) {
    tenantId = tenant.id;
    tier = tenant.tier;
    if (tenant.maxBudgetUsd) maxBudgetUsd = tenant.maxBudgetUsd;
    // Enable tenant-specific features
    for (const feature of tenant.features) {
      featureFlags[feature] = true;
    }
  }
}

/**
 * Check if current tenant has access to a feature.
 */
export function tenantHasFeature(feature: string): boolean {
  if (!currentTenant) return getFeatureFlag(feature);
  return currentTenant.features.includes(feature) || getFeatureFlag(feature);
}

/**
 * Get tier limits for the current tenant.
 */
export function getTierLimits(): {
  maxTurns: number;
  maxBudgetUsd: number;
  maxPlugins: number;
  maxMcpServers: number;
  maxAgentDepth: number;
} {
  const tierLimits: Record<string, { maxTurns: number; maxBudgetUsd: number; maxPlugins: number; maxMcpServers: number; maxAgentDepth: number }> = {
    one: { maxTurns: 50, maxBudgetUsd: 1.0, maxPlugins: 5, maxMcpServers: 3, maxAgentDepth: 2 },
    smart: { maxTurns: 200, maxBudgetUsd: 5.0, maxPlugins: 20, maxMcpServers: 10, maxAgentDepth: 4 },
    profissional: { maxTurns: 500, maxBudgetUsd: 20.0, maxPlugins: 50, maxMcpServers: 20, maxAgentDepth: 6 },
    business: { maxTurns: 2000, maxBudgetUsd: 100.0, maxPlugins: 200, maxMcpServers: 50, maxAgentDepth: 10 },
  };
  return tierLimits[tier] ?? tierLimits.one;
}

// ════════════════════════════════════════════════════════════════════════════
// Session Lifecycle
// ════════════════════════════════════════════════════════════════════════════

type SessionPhase = 'initializing' | 'idle' | 'ready' | 'querying' | 'compacting' | 'resuming' | 'closing' | 'closed';

let sessionPhase: SessionPhase = 'initializing';
let lastActivityTimestamp: number = Date.now();
let idleTimeoutMs: number = 30 * 60_000; // 30 minutes

export function getSessionPhase(): SessionPhase { return sessionPhase; }
export function setSessionPhase(phase: SessionPhase): void { sessionPhase = phase; lastActivityTimestamp = Date.now(); }

export function getLastActivityTimestamp(): number { return lastActivityTimestamp; }
export function recordActivity(): void { lastActivityTimestamp = Date.now(); }

export function getIdleTimeoutMs(): number { return idleTimeoutMs; }
export function setIdleTimeoutMs(ms: number): void { idleTimeoutMs = ms; }

/**
 * Check if the session has been idle for too long.
 */
export function isSessionIdle(): boolean {
  return Date.now() - lastActivityTimestamp > idleTimeoutMs;
}

/**
 * Get how long the session has been idle (ms).
 */
export function getIdleDurationMs(): number {
  return Date.now() - lastActivityTimestamp;
}

// ════════════════════════════════════════════════════════════════════════════
// Model API Configuration
// ════════════════════════════════════════════════════════════════════════════

interface ModelConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

let modelConfig: ModelConfig = {
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  model: process.env.CLOW_MODEL || 'claude-sonnet-4-6',
  maxOutputTokens: 8192,
  temperature: 0,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
};

export function getModelConfig(): Readonly<ModelConfig> { return { ...modelConfig }; }
export function setModelConfig(config: Partial<ModelConfig>): void { modelConfig = { ...modelConfig, ...config }; }

export function getApiKey(): string {
  return modelConfig.apiKey || process.env.ANTHROPIC_API_KEY || '';
}
export function getMaxOutputTokens(): number { return modelConfig.maxOutputTokens; }
export function getTemperature(): number { return modelConfig.temperature; }

// ════════════════════════════════════════════════════════════════════════════
// Pricing (Claude Sonnet)
// ════════════════════════════════════════════════════════════════════════════

export const PRICING = {
  /** Input token price (cache miss) — $3.00 per 1M tokens */
  inputCacheMissPerToken: 3.0 / 1_000_000,
  /** Input token price (cache hit) — $0.30 per 1M tokens */
  inputCacheHitPerToken: 0.3 / 1_000_000,
  /** Output token price — $15.00 per 1M tokens */
  outputPerToken: 15.0 / 1_000_000,
} as const;

/**
 * Calculate cost for a single API call.
 */
export function calculateCallCost(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number = 0,
): number {
  const cacheMissTokens = Math.max(0, inputTokens - cacheHitTokens);
  const inputCost = (cacheMissTokens * PRICING.inputCacheMissPerToken) +
                    (cacheHitTokens * PRICING.inputCacheHitPerToken);
  const outputCost = outputTokens * PRICING.outputPerToken;
  return inputCost + outputCost;
}

/**
 * Estimate cost for a hypothetical conversation.
 */
export function estimateConversationCost(
  inputTokensPerTurn: number,
  outputTokensPerTurn: number,
  turns: number,
  cacheHitRate: number = 0.8,
): number {
  let total = 0;
  for (let i = 0; i < turns; i++) {
    const hitTokens = i > 0 ? Math.floor(inputTokensPerTurn * cacheHitRate) : 0;
    total += calculateCallCost(inputTokensPerTurn, outputTokensPerTurn, hitTokens);
  }
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// Extended Snapshot (full state dump)
// ════════════════════════════════════════════════════════════════════════════

export interface FullStateSnapshot extends StateSnapshot {
  runtimeEnvironment: RuntimeEnvironment;
  isInteractive: boolean;
  isCI: boolean;
  isDebug: boolean;
  clowVersion: string;
  maxContextTokens: number;
  currentContextUsage: number;
  contextUsagePercent: number;
  sessionPhase: SessionPhase;
  idleDurationMs: number;
  featureFlags: Record<string, boolean>;
  tenantId?: string;
  tenantTier: string;
  toolsUsed: string[];
  errorCount: number;
  costPerTurn: number;
  cacheHitRate: number;
}

/**
 * Create a full state dump (for diagnostics).
 */
export function fullSnapshot(): FullStateSnapshot {
  const base = snapshot();
  return {
    ...base,
    runtimeEnvironment: runtimeEnv,
    isInteractive,
    isCI,
    isDebug,
    clowVersion,
    maxContextTokens,
    currentContextUsage,
    contextUsagePercent: getContextUsagePercent(),
    sessionPhase,
    idleDurationMs: getIdleDurationMs(),
    featureFlags: { ...featureFlags },
    tenantTier: tier,
    toolsUsed: [...toolsUsed],
    errorCount: errorHistory.length,
    costPerTurn: getAvgCostPerTurn(),
    cacheHitRate: getCacheHitRate(),
  };
}

// ═══════════════════════════════════════════════════════════════════════��════
// Performance Tracking
// ══════════════════════════════════════════════════════════════════════��═════

interface PerformanceEntry {
  operation: string;
  durationMs: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const performanceLog: PerformanceEntry[] = [];
const MAX_PERF_ENTRIES = 500;

/**
 * Record a performance measurement.
 */
export function recordPerformance(operation: string, durationMs: number, metadata?: Record<string, unknown>): void {
  performanceLog.push({ operation, durationMs, timestamp: Date.now(), metadata });
  if (performanceLog.length > MAX_PERF_ENTRIES) performanceLog.shift();
}

/**
 * Get average duration for an operation.
 */
export function getAvgPerformance(operation: string): number {
  const entries = performanceLog.filter(e => e.operation === operation);
  if (entries.length === 0) return 0;
  return entries.reduce((sum, e) => sum + e.durationMs, 0) / entries.length;
}

/**
 * Get P95 duration for an operation.
 */
export function getP95Performance(operation: string): number {
  const entries = performanceLog.filter(e => e.operation === operation).map(e => e.durationMs).sort((a, b) => a - b);
  if (entries.length === 0) return 0;
  return entries[Math.floor(entries.length * 0.95)] ?? entries[entries.length - 1];
}

/**
 * Get all performance entries for an operation.
 */
export function getPerformanceLog(operation?: string): PerformanceEntry[] {
  if (operation) return performanceLog.filter(e => e.operation === operation);
  return [...performanceLog];
}

/**
 * Get unique operation names.
 */
export function getTrackedOperations(): string[] {
  return [...new Set(performanceLog.map(e => e.operation))];
}

// ════════════════════════════════════════════════════════════════════════════
// System Health
// ════════════════════════════════════════════════════════════════════════════

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memoryUsageMb: number;
  contextUsagePercent: number;
  errorRate: number;
  budgetStatus: 'ok' | 'warning' | 'critical' | 'exceeded' | 'unlimited';
  activePhase: SessionPhase;
  warnings: string[];
}

/**
 * Get system health status.
 */
export function getSystemHealth(): SystemHealth {
  const warnings: string[] = [];
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Check memory
  const memMb = process.memoryUsage().heapUsed / (1024 * 1024);
  if (memMb > 500) { warnings.push(`High memory: ${memMb.toFixed(0)}MB`); status = 'degraded'; }
  if (memMb > 1000) status = 'unhealthy';

  // Check context
  const ctxPct = getContextUsagePercent();
  if (ctxPct > 90) { warnings.push(`Context near limit: ${ctxPct.toFixed(0)}%`); status = 'degraded'; }
  if (ctxPct > 98) status = 'unhealthy';

  // Check error rate
  const recentErrors = errorHistory.filter(e => Date.now() - e.timestamp < 5 * 60_000).length;
  if (recentErrors > 5) { warnings.push(`High error rate: ${recentErrors} in 5min`); status = 'degraded'; }
  if (recentErrors > 20) status = 'unhealthy';

  // Check budget
  let budgetStatus: SystemHealth['budgetStatus'] = 'unlimited';
  if (maxBudgetUsd) {
    const pct = getBudgetUsagePercent()!;
    if (pct >= 100) budgetStatus = 'exceeded';
    else if (pct >= 95) { budgetStatus = 'critical'; warnings.push('Budget nearly exhausted'); }
    else if (pct >= 80) budgetStatus = 'warning';
    else budgetStatus = 'ok';
  }

  // Check idle
  if (isSessionIdle()) {
    warnings.push(`Session idle for ${Math.round(getIdleDurationMs() / 60_000)}min`);
  }

  return {
    status,
    uptime: getSessionDurationMs(),
    memoryUsageMb: Math.round(memMb),
    contextUsagePercent: ctxPct,
    errorRate: recentErrors,
    budgetStatus,
    activePhase: sessionPhase,
    warnings,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Event Emitter (lightweight)
// ════════════════════════════════════════════════════════════════════════════

type StateEventType = 'phase_changed' | 'budget_warning' | 'context_warning' | 'error' | 'compact' | 'turn_complete';

interface StateEvent {
  type: StateEventType;
  data: Record<string, unknown>;
  timestamp: number;
}

type StateEventHandler = (event: StateEvent) => void;

const stateEventHandlers: StateEventHandler[] = [];

export function onStateEvent(handler: StateEventHandler): () => void {
  stateEventHandlers.push(handler);
  return () => {
    const idx = stateEventHandlers.indexOf(handler);
    if (idx !== -1) stateEventHandlers.splice(idx, 1);
  };
}

export function emitStateEvent(type: StateEventType, data: Record<string, unknown> = {}): void {
  const event: StateEvent = { type, data, timestamp: Date.now() };
  for (const handler of stateEventHandlers) {
    try { handler(event); } catch { /* ignore */ }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Status Line (for UI display)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a compact status line for terminal display.
 */
export function getStatusLine(): string {
  const parts: string[] = [];

  // Cost
  parts.push(`$${totalCostUSD.toFixed(3)}`);

  // Tokens
  const totalTk = totalInputTokens + totalOutputTokens;
  if (totalTk > 1_000_000) parts.push(`${(totalTk / 1_000_000).toFixed(1)}M tok`);
  else if (totalTk > 1_000) parts.push(`${(totalTk / 1_000).toFixed(0)}K tok`);
  else parts.push(`${totalTk} tok`);

  // Cache
  const hitRate = getCacheHitRate();
  if (hitRate > 0) parts.push(`${(hitRate * 100).toFixed(0)}% cache`);

  // Context
  const ctxPct = getContextUsagePercent();
  if (ctxPct > 0) parts.push(`${ctxPct.toFixed(0)}% ctx`);

  // Turn
  parts.push(`T${turnNumber}`);

  // Phase
  if (sessionPhase !== 'ready' && sessionPhase !== 'idle') {
    parts.push(sessionPhase);
  }

  return parts.join(' | ');
}

/**
 * Generate a detailed status block for /cost command.
 */
export function getDetailedStatus(): string {
  const lines: string[] = [];

  lines.push('═══ System Clow Status ═══');
  lines.push(`Session: ${sessionId.slice(0, 8)} | ${model}`);
  lines.push(`Phase: ${sessionPhase} | Turn: ${turnNumber}`);
  lines.push(`Duration: ${Math.round(getSessionDurationMs() / 1000)}s`);
  lines.push('');

  // Cost
  lines.push('── Cost ──');
  lines.push(`Total: $${totalCostUSD.toFixed(4)} USD`);
  lines.push(`Input: ${totalInputTokens.toLocaleString()} tokens`);
  lines.push(`Output: ${totalOutputTokens.toLocaleString()} tokens`);
  lines.push(`Avg/turn: $${getAvgCostPerTurn().toFixed(4)}`);
  if (maxBudgetUsd) {
    lines.push(`Budget: $${maxBudgetUsd.toFixed(2)} (${getBudgetUsagePercent()?.toFixed(0)}% used)`);
  }
  lines.push('');

  // Cache
  const hitRate = getCacheHitRate();
  lines.push('── Cache ──');
  lines.push(`Hit Rate: ${(hitRate * 100).toFixed(1)}%`);
  const savings = totalInputTokens * hitRate * PRICING.inputCacheMissPerToken * 0.9;
  lines.push(`Est. Savings: $${savings.toFixed(4)}`);
  lines.push('');

  // Context
  lines.push('── Context ──');
  lines.push(`Usage: ${currentContextUsage.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens`);
  lines.push(`${getContextUsagePercent().toFixed(1)}% used | ${getContextRemainingTokens().toLocaleString()} remaining`);
  lines.push(`Compactions: ${compactCount}`);

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Workspace State
// ════════════════════════════════════════════════════════════════════════════

/** Tracked files in the workspace */
const workspaceFiles = new Map<string, { lastModified: number; size: number; tracked: boolean }>();

/** Workspace configuration */
let workspaceConfig: Record<string, unknown> = {};

/** Whether .CLAUDE.md / CLAUDE.md instructions were loaded */
let instructionsLoaded = false;
let instructionsPath: string | undefined;
let instructionsContent: string | undefined;

export function getWorkspaceFiles(): ReadonlyMap<string, { lastModified: number; size: number; tracked: boolean }> {
  return workspaceFiles;
}

export function trackWorkspaceFile(filePath: string, size: number): void {
  workspaceFiles.set(filePath, { lastModified: Date.now(), size, tracked: true });
}

export function untrackWorkspaceFile(filePath: string): void {
  workspaceFiles.delete(filePath);
}

export function getTrackedFileCount(): number {
  return workspaceFiles.size;
}

export function getWorkspaceConfig(): Record<string, unknown> {
  return { ...workspaceConfig };
}

export function setWorkspaceConfig(config: Record<string, unknown>): void {
  workspaceConfig = { ...config };
}

export function mergeWorkspaceConfig(partial: Record<string, unknown>): void {
  workspaceConfig = { ...workspaceConfig, ...partial };
}

export function isInstructionsLoaded(): boolean { return instructionsLoaded; }
export function getInstructionsPath(): string | undefined { return instructionsPath; }
export function getInstructionsContent(): string | undefined { return instructionsContent; }

export function setInstructionsLoaded(loaded: boolean, filePath?: string, content?: string): void {
  instructionsLoaded = loaded;
  instructionsPath = filePath;
  instructionsContent = content;
}

// ════════════════════════════════════════════════════════════════════════════
// MCP Server State
// ════════════════════════════════════════════════════════════════════════════

interface McpServerState {
  name: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  transport: 'stdio' | 'http';
  toolCount: number;
  startedAt?: number;
  lastError?: string;
  pid?: number;
}

const mcpServers = new Map<string, McpServerState>();

export function registerMcpServer(name: string, state: McpServerState): void {
  mcpServers.set(name, state);
}

export function getMcpServer(name: string): McpServerState | undefined {
  return mcpServers.get(name);
}

export function getMcpServers(): ReadonlyMap<string, McpServerState> {
  return mcpServers;
}

export function getMcpServerCount(): number {
  return mcpServers.size;
}

export function getRunningMcpServers(): McpServerState[] {
  return [...mcpServers.values()].filter(s => s.status === 'running');
}

export function removeMcpServer(name: string): void {
  mcpServers.delete(name);
}

// ════════════════════════════════════════════════════════════════════════════
// Plugin State
// ════════════════════════════════════════════════════════════════════════════

let pluginSystemInitialized = false;
let loadedPluginCount = 0;
let pluginLoadDurationMs = 0;
const pluginNames = new Set<string>();

export function isPluginSystemInitialized(): boolean { return pluginSystemInitialized; }
export function setPluginSystemInitialized(initialized: boolean): void { pluginSystemInitialized = initialized; }
export function getLoadedPluginCount(): number { return loadedPluginCount; }
export function setLoadedPluginCount(count: number): void { loadedPluginCount = count; }
export function getPluginLoadDurationMs(): number { return pluginLoadDurationMs; }
export function setPluginLoadDurationMs(ms: number): void { pluginLoadDurationMs = ms; }
export function addPluginName(name: string): void { pluginNames.add(name); }
export function getPluginNames(): ReadonlySet<string> { return pluginNames; }
export function hasPlugin(name: string): boolean { return pluginNames.has(name); }

// ════════════════════════════════════════════════════════════════════════════
// Agent State (for sub-agents)
// ════════════════════════════════════════════════════════════════════════════

interface AgentState {
  id: string;
  parentId?: string;
  type: string;
  depth: number;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  taskDescription?: string;
}

const activeAgents = new Map<string, AgentState>();
let totalAgentsSpawned = 0;

export function registerAgent(agent: AgentState): void {
  activeAgents.set(agent.id, agent);
  totalAgentsSpawned++;
}

export function completeAgent(id: string, status: 'completed' | 'failed' = 'completed'): void {
  const agent = activeAgents.get(id);
  if (agent) {
    agent.status = status;
    activeAgents.delete(id);
  }
}

export function getActiveAgents(): AgentState[] {
  return [...activeAgents.values()];
}

export function getActiveAgentCount(): number {
  return activeAgents.size;
}

export function getTotalAgentsSpawned(): number {
  return totalAgentsSpawned;
}

export function getMaxAgentDepth(): number {
  let max = 0;
  for (const agent of activeAgents.values()) {
    if (agent.depth > max) max = agent.depth;
  }
  return max;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook State
// ════════════════════════════════════════════════════════════════════════════

let hookSystemInitialized = false;
let registeredHookCount = 0;
let hookFiringCount = 0;
let hookBlockCount = 0;

export function isHookSystemInitialized(): boolean { return hookSystemInitialized; }
export function setHookSystemInitialized(initialized: boolean): void { hookSystemInitialized = initialized; }
export function getRegisteredHookCount(): number { return registeredHookCount; }
export function setRegisteredHookCount(count: number): void { registeredHookCount = count; }
export function incrementHookFiring(): void { hookFiringCount++; }
export function getHookFiringCount(): number { return hookFiringCount; }
export function incrementHookBlock(): void { hookBlockCount++; }
export function getHookBlockCount(): number { return hookBlockCount; }

// ════════════════════════════════════════════════════════════════════════════
// Initialization Timing
// ════════════════════════════════════════════════════════════════════════════

interface InitTimings {
  total: number;
  configLoad: number;
  pluginDiscovery: number;
  hookSetup: number;
  skillDiscovery: number;
  mcpStartup: number;
  contextAssembly: number;
}

let initTimings: Partial<InitTimings> = {};

export function setInitTiming(key: keyof InitTimings, durationMs: number): void {
  initTimings[key] = durationMs;
}

export function getInitTimings(): Partial<InitTimings> {
  return { ...initTimings };
}

export function getInitTotalMs(): number {
  return initTimings.total ?? 0;
}

/**
 * Format init timings for display.
 */
export function formatInitTimings(): string {
  const entries = Object.entries(initTimings)
    .filter(([, v]) => v !== undefined && v > 0)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));

  if (entries.length === 0) return 'No timing data';

  return entries.map(([k, v]) => `${k}: ${v}ms`).join(', ');
}

// ════════════════════════════════════════════════════════════════════════════
// Full System Reset (testing only)
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// Session History (for /resume)
// ════════════════════════════════════════════════════════════════════════════

interface RecentSession {
  id: string;
  workspaceRoot: string;
  startedAt: number;
  lastActivityAt: number;
  turnCount: number;
  costUsd: number;
  model: string;
  title?: string;
}

const recentSessions: RecentSession[] = [];
const MAX_RECENT_SESSIONS = 50;

export function addRecentSession(session: RecentSession): void {
  // Remove existing entry for same ID
  const idx = recentSessions.findIndex(s => s.id === session.id);
  if (idx !== -1) recentSessions.splice(idx, 1);

  recentSessions.unshift(session);
  while (recentSessions.length > MAX_RECENT_SESSIONS) recentSessions.pop();
}

export function getRecentSessions(limit: number = 10): RecentSession[] {
  return recentSessions.slice(0, limit);
}

export function getRecentSessionsForWorkspace(workspaceRoot: string, limit: number = 5): RecentSession[] {
  return recentSessions.filter(s => s.workspaceRoot === workspaceRoot).slice(0, limit);
}

export function getLastSessionId(): string | undefined {
  return recentSessions[0]?.id;
}

export function clearRecentSessions(): void {
  recentSessions.length = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Environment Variables
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all CLOW_* environment variables.
 */
export function getClowEnvVars(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLOW_') && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Get the effective API key (from env or config).
 */
export function getEffectiveApiKey(): string {
  return modelConfig.apiKey || process.env.ANTHROPIC_API_KEY || '';
}

/**
 * Check if an API key is configured.
 */
export function hasApiKey(): boolean {
  return getEffectiveApiKey().length > 0;
}

/**
 * Mask an API key for safe display (show first 4 and last 4 chars).
 */
export function maskApiKey(key?: string): string {
  const k = key ?? getEffectiveApiKey();
  if (k.length <= 8) return '***';
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Platform Info
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get platform information for diagnostics.
 */
export function getPlatformInfo(): {
  os: string;
  arch: string;
  nodeVersion: string;
  pid: number;
  memoryMb: number;
  cpuCount: number;
  cwd: string;
  homeDir: string;
  isWSL: boolean;
} {
  const os = require('os');
  return {
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    nodeVersion: process.version,
    pid: process.pid,
    memoryMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
    cpuCount: os.cpus().length,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    isWSL: process.platform === 'linux' && (process.env.WSL_DISTRO_NAME ?? '').length > 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Full System Reset (testing only)
// ════════════════════════════════════════════════════════════════════════════

export function resetExtendedState(): void {
  workspaceFiles.clear();
  workspaceConfig = {};
  instructionsLoaded = false;
  instructionsPath = undefined;
  instructionsContent = undefined;
  mcpServers.clear();
  pluginSystemInitialized = false;
  loadedPluginCount = 0;
  pluginLoadDurationMs = 0;
  pluginNames.clear();
  activeAgents.clear();
  totalAgentsSpawned = 0;
  hookSystemInitialized = false;
  registeredHookCount = 0;
  hookFiringCount = 0;
  hookBlockCount = 0;
  initTimings = {};
  performanceLog.length = 0;
  stateEventHandlers.length = 0;
  featureFlags.MULTI_TENANT = false;
  featureFlags.WHATSAPP_ADAPTER = false;
  currentTenant = null;
  notificationHandlers.length = 0;
  notificationHistory.length = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Notification System
// ════════════════════════════════════════════════════════════════════════════

/** Notification severity levels */
export type NotificationSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Notification categories */
export type NotificationCategory =
  | 'budget_warning'
  | 'budget_exceeded'
  | 'context_warning'
  | 'context_critical'
  | 'error'
  | 'tool_failure'
  | 'permission_denied'
  | 'session_event'
  | 'performance'
  | 'custom';

/** A notification event */
export interface Notification {
  id: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
  acknowledged: boolean;
}

/** Notification handler callback */
export type NotificationHandler = (notification: Notification) => void;

const notificationHandlers: NotificationHandler[] = [];
const notificationHistory: Notification[] = [];
const MAX_NOTIFICATION_HISTORY = 200;

/**
 * Register a notification handler.
 * Handlers are called whenever a notification is fired.
 *
 * @param handler - Callback to invoke on notification
 * @returns An unsubscribe function
 */
export function registerNotificationHandler(handler: NotificationHandler): () => void {
  notificationHandlers.push(handler);
  return () => {
    const idx = notificationHandlers.indexOf(handler);
    if (idx !== -1) notificationHandlers.splice(idx, 1);
  };
}

/**
 * Fire a notification to all registered handlers.
 * The notification is also stored in history.
 *
 * @param category - Notification category
 * @param severity - Notification severity
 * @param message - Human-readable message
 * @param data - Optional structured data
 */
export function fireNotification(
  category: NotificationCategory,
  severity: NotificationSeverity,
  message: string,
  data?: Record<string, unknown>,
): Notification {
  const notification: Notification = {
    id: randomUUID(),
    category,
    severity,
    message,
    timestamp: Date.now(),
    data,
    acknowledged: false,
  };

  notificationHistory.push(notification);
  if (notificationHistory.length > MAX_NOTIFICATION_HISTORY) {
    notificationHistory.splice(0, notificationHistory.length - MAX_NOTIFICATION_HISTORY);
  }

  for (const handler of notificationHandlers) {
    try {
      handler(notification);
    } catch {
      // Don't let handler errors propagate
    }
  }

  return notification;
}

/**
 * Get notification history, optionally filtered.
 *
 * @param filter - Optional filter criteria
 * @returns Array of notifications matching the filter
 */
export function getNotificationHistory(filter?: {
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  since?: number;
  limit?: number;
}): Notification[] {
  let results = [...notificationHistory];

  if (filter?.category) {
    results = results.filter(n => n.category === filter.category);
  }
  if (filter?.severity) {
    results = results.filter(n => n.severity === filter.severity);
  }
  if (filter?.since) {
    results = results.filter(n => n.timestamp >= filter.since!);
  }
  if (filter?.limit) {
    results = results.slice(-filter.limit);
  }

  return results;
}

/**
 * Get count of unacknowledged notifications by severity.
 */
export function getUnacknowledgedCounts(): Record<NotificationSeverity, number> {
  const counts: Record<NotificationSeverity, number> = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const n of notificationHistory) {
    if (!n.acknowledged) counts[n.severity]++;
  }
  return counts;
}

/**
 * Acknowledge a notification by ID.
 */
export function acknowledgeNotification(id: string): boolean {
  const n = notificationHistory.find(n => n.id === id);
  if (!n) return false;
  n.acknowledged = true;
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// Debug Dump (Complete State as JSON for Bug Reports)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a complete debug dump of the global state.
 * Useful for bug reports and diagnostics. Sensitive data is redacted.
 *
 * @returns JSON-serializable object with all state information
 */
export function generateDebugDump(): Record<string, unknown> {
  return {
    _meta: {
      generatedAt: new Date().toISOString(),
      sessionId,
      uptime: Date.now() - currentTurnMetrics.startTime,
    },
    identity: {
      sessionId,
      cwd,
      originalCwd,
      projectRoot,
      isGitRepo,
      gitBranch,
    },
    cost: {
      totalCostUSD,
      totalAPIDurationMs,
      totalInputTokens,
      totalOutputTokens,
      costHistoryLength: costHistory.length,
      lastCostEntry: costHistory.length > 0 ? costHistory[costHistory.length - 1] : null,
      modelUsage: Object.fromEntries(modelUsage),
    },
    turnMetrics: { ...currentTurnMetrics },
    api: {
      lastAPIRequestTimestamp,
      lastMainRequestId,
      lastApiCompletionTimestamp,
    },
    permissions: {
      permissionMode,
      prePlanPermissionMode,
      sessionPermissionRuleCount: sessionPermissionRules.length,
    },
    features: {
      invokedSkills: [...invokedSkills],
      discoveredSkillNames: [...discoveredSkillNames],
      customTitle,
      aiTitle,
    },
    latches: {
      autoModeHeaderLatched,
      fastModeHeaderLatched,
    },
    notifications: {
      handlerCount: notificationHandlers.length,
      historyCount: notificationHistory.length,
      unacknowledged: getUnacknowledgedCounts(),
    },
  };
}

/**
 * Generate a minimal debug dump suitable for log output.
 * Contains only the most important state fields.
 */
export function generateMinimalDebugDump(): string {
  const dump = {
    session: sessionId.slice(0, 8),
    cwd,
    cost: `$${totalCostUSD.toFixed(4)}`,
    tokens: `${totalInputTokens}in/${totalOutputTokens}out`,
    mode: permissionMode,
    skills: invokedSkills.size,
    git: isGitRepo ? gitBranch ?? 'detached' : 'none',
  };
  return JSON.stringify(dump);
}

// ════════════════════════════════════════════════════════════════════════════
// Session Comparison (Diff Two Snapshots)
// ════════════════════════════════════════════════════════════════════════════

/** A snapshot of session state at a point in time */
export interface SessionSnapshot {
  snapshotId: string;
  timestamp: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  permissionMode: PermissionMode;
  invokedSkillCount: number;
  costHistoryLength: number;
  sessionPermissionRuleCount: number;
}

/**
 * Take a snapshot of the current session state.
 * Snapshots can be compared later to see what changed.
 *
 * @returns A frozen copy of key state fields
 */
export function takeSessionSnapshot(): SessionSnapshot {
  return {
    snapshotId: randomUUID(),
    timestamp: Date.now(),
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    permissionMode,
    invokedSkillCount: invokedSkills.size,
    costHistoryLength: costHistory.length,
    sessionPermissionRuleCount: sessionPermissionRules.length,
  };
}

/** Differences between two session snapshots */
export interface SessionDiff {
  /** Time elapsed between snapshots in milliseconds */
  elapsedMs: number;
  /** Cost added between snapshots */
  costDelta: number;
  /** Input tokens added between snapshots */
  inputTokensDelta: number;
  /** Output tokens added between snapshots */
  outputTokensDelta: number;
  /** Whether permission mode changed */
  permissionModeChanged: boolean;
  /** Number of new skills invoked */
  newSkillsInvoked: number;
  /** Number of new cost entries */
  newCostEntries: number;
  /** Number of new permission rules */
  newPermissionRules: number;
}

/**
 * Compare two session snapshots and return the differences.
 *
 * @param before - Earlier snapshot
 * @param after - Later snapshot
 * @returns Object describing what changed between snapshots
 */
export function compareSessionSnapshots(before: SessionSnapshot, after: SessionSnapshot): SessionDiff {
  return {
    elapsedMs: after.timestamp - before.timestamp,
    costDelta: after.totalCostUSD - before.totalCostUSD,
    inputTokensDelta: after.totalInputTokens - before.totalInputTokens,
    outputTokensDelta: after.totalOutputTokens - before.totalOutputTokens,
    permissionModeChanged: after.permissionMode !== before.permissionMode,
    newSkillsInvoked: after.invokedSkillCount - before.invokedSkillCount,
    newCostEntries: after.costHistoryLength - before.costHistoryLength,
    newPermissionRules: after.sessionPermissionRuleCount - before.sessionPermissionRuleCount,
  };
}
