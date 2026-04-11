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

// ─── Getters ────────────────────────────────────────────────────────────────

export function getSessionId(): string {
  return sessionId;
}

export function getOriginalCwd(): string {
  return originalCwd;
}

export function getCwd(): string {
  return cwd;
}

export function getProjectRoot(): string {
  return projectRoot;
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
}
