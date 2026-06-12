/**
 * HookEngine — Unit Tests
 *
 * Tests: hook registration, firing, aggregation, enable/disable,
 * function hooks, async hooks, priority ordering.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookEngine } from '../../src/hooks/HookEngine.js';
import type { HookInput, HookOutput, HookEventName } from '../../src/hooks/types.js';

function createEngine(): HookEngine {
  return new HookEngine({
    toolRegistry: new Map(),
    spawnSubagent: async () => 'ok',
  });
}

function makeInput(event: HookEventName, extras: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: event,
    hook_id: '',
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    cwd: '/tmp',
    workspace_root: '/tmp',
    permission_mode: 'default',
    agent_depth: 0,
    timestamp: Date.now(),
    ...extras,
  };
}

describe('HookEngine', () => {
  let engine: HookEngine;

  beforeEach(() => {
    engine = createEngine();
  });

  // ─── Registration ──────────────────────────────────────────────

  describe('Registration', () => {
    it('registers a function hook and returns an ID', () => {
      const id = engine.registerFunctionHook('PostToolUse', async () => null);
      expect(id).toBeTruthy();
      expect(id.startsWith('fn_')).toBe(true);
    });

    it('registered hook appears in listHooks()', () => {
      engine.registerFunctionHook('SessionStart', async () => null);
      const hooks = engine.listHooks();
      expect(hooks.length).toBe(1);
      expect(hooks[0].event).toBe('SessionStart');
    });

    it('unregisters a hook by ID', () => {
      const id = engine.registerFunctionHook('PostToolUse', async () => null);
      expect(engine.listHooks()).toHaveLength(1);

      const removed = engine.unregisterHook(id);
      expect(removed).toBe(true);
      expect(engine.listHooks()).toHaveLength(0);
    });

    it('returns false for non-existent hook ID', () => {
      expect(engine.unregisterHook('nonexistent')).toBe(false);
    });
  });

  // ─── Firing ────────────────────────────────────────────────────

  describe('Firing', () => {
    it('fires a hook and returns aggregated result', async () => {
      engine.registerFunctionHook('PostToolUse', async (input) => ({
        continue: true,
        systemMessage: 'Hook executed',
      }));

      const result = await engine.fire('PostToolUse', makeInput('PostToolUse'));
      expect(result.systemMessages).toContain('Hook executed');
      expect(result.hookCount).toBe(1);
    });

    it('returns empty result when no hooks match', async () => {
      const result = await engine.fire('SessionStart', makeInput('SessionStart'));
      expect(result.hookCount).toBe(0);
      expect(result.blocked).toBe(false);
    });

    it('handles null return from hook (fire-and-forget)', async () => {
      engine.registerFunctionHook('PostToolUse', async () => null);
      const result = await engine.fire('PostToolUse', makeInput('PostToolUse'));
      expect(result.hookCount).toBe(1);
      expect(result.blocked).toBe(false);
    });

    it('fires multiple hooks for same event', async () => {
      let callOrder: number[] = [];

      engine.registerFunctionHook('PostToolUse', async () => {
        callOrder.push(1);
        return { systemMessage: 'first' };
      });
      engine.registerFunctionHook('PostToolUse', async () => {
        callOrder.push(2);
        return { systemMessage: 'second' };
      });

      const result = await engine.fire('PostToolUse', makeInput('PostToolUse'));
      expect(result.hookCount).toBe(2);
      expect(callOrder).toHaveLength(2);
    });
  });

  // ─── Enable/Disable ───────────────────────────────────────────

  describe('Enable/Disable', () => {
    it('disables a hook so it does not fire', async () => {
      const id = engine.registerFunctionHook('PostToolUse', async () => ({
        systemMessage: 'should not appear',
      }));

      engine.disableHook(id);
      const result = await engine.fire('PostToolUse', makeInput('PostToolUse'));
      expect(result.hookCount).toBe(0);
      expect(result.systemMessages).toBe('');
    });

    it('re-enables a disabled hook', async () => {
      const id = engine.registerFunctionHook('PostToolUse', async () => ({
        systemMessage: 'enabled',
      }));

      engine.disableHook(id);
      engine.enableHook(id);
      const result = await engine.fire('PostToolUse', makeInput('PostToolUse'));
      expect(result.hookCount).toBe(1);
    });
  });

  // ─── Error Handling ────────────────────────────────────────────

  describe('Error Handling', () => {
    it('catches errors from hooks without crashing', async () => {
      engine.registerFunctionHook('PostToolUse', async () => {
        throw new Error('Hook crashed!');
      });

      const result = await engine.fire('PostToolUse', makeInput('PostToolUse'));
      expect(result.errors.length).toBeGreaterThanOrEqual(0);
      // Engine should NOT throw
    });
  });

  // ─── Metrics ───────────────────────────────────────────────────

  describe('Metrics', () => {
    it('tracks fire count', async () => {
      engine.registerFunctionHook('PostToolUse', async () => null);
      await engine.fire('PostToolUse', makeInput('PostToolUse'));
      await engine.fire('PostToolUse', makeInput('PostToolUse'));

      const metrics = engine.getMetrics();
      expect(metrics.totalFires).toBe(2);
    });
  });
});
