/**
 * memory/index.ts — Bootstrap entry point for the persistent memory system
 *
 * Initializes the SQLite database and registers 3 hook handlers:
 *   - SessionStart: inject past memory context
 *   - PostToolUse: record observations
 *   - SessionEnd: generate and store session summary
 */

import type { HookEngine } from '../hooks/HookEngine.js';
import { getMemoryDb } from './MemoryDatabase.js';
import {
  handleSessionStart,
  handlePostToolUse,
  handleSessionEnd,
} from './hooks/MemoryHookHandlers.js';

// Track initialization per tenant
const initialized = new Set<string>();

/**
 * Initialize the persistent memory system for a tenant.
 * Safe to call multiple times — only initializes once per tenant.
 */
export async function initMemorySystem(
  hookEngine: HookEngine,
  tenantId: string = 'default',
): Promise<void> {
  if (initialized.has(tenantId)) return;

  try {
    // Ensure database exists and schema is up to date
    getMemoryDb(tenantId);

    // Register hook handlers (only once globally, not per tenant)
    if (initialized.size === 0) {
      hookEngine.registerFunctionHook('SessionStart', handleSessionStart, { priority: -10 });
      hookEngine.registerFunctionHook('PostToolUse', handlePostToolUse, { priority: -10 });
      hookEngine.registerFunctionHook('SessionEnd', handleSessionEnd, { priority: -10 });
    }

    initialized.add(tenantId);
    console.log(`[Memory] Initialized persistent memory for tenant: ${tenantId}`);
  } catch (err) {
    console.warn(`[Memory] Failed to initialize: ${(err as Error).message}`);
    // Non-fatal — system works without memory
  }
}

// Re-exports
export { MemoryStore } from './MemoryStore.js';
export { getMemoryDb, closeAllMemoryDbs } from './MemoryDatabase.js';
export { generateMemoryContext } from './MemoryContextInjector.js';
export { buildMemoryRoutes } from './memoryRoutes.js';
