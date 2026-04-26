/**
 * Tool Result Cache — Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolResultCache } from '../../src/tools/toolResultCache.js';

describe('ToolResultCache', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = new ToolResultCache(5000); // 5s TTL for testing
  });

  it('caches Read results', () => {
    cache.set('Read', { file_path: '/tmp/test.ts' }, { output: 'content' });
    const result = cache.get('Read', { file_path: '/tmp/test.ts' });
    expect(result).toEqual({ output: 'content' });
  });

  it('caches Glob results', () => {
    cache.set('Glob', { pattern: '**/*.ts' }, { output: ['a.ts', 'b.ts'] });
    expect(cache.get('Glob', { pattern: '**/*.ts' })).toBeTruthy();
  });

  it('caches Grep results', () => {
    cache.set('Grep', { pattern: 'TODO', path: '/src' }, { output: 'matches' });
    expect(cache.get('Grep', { pattern: 'TODO', path: '/src' })).toBeTruthy();
  });

  it('does NOT cache Write/Edit/Bash', () => {
    cache.set('Write', { file_path: '/tmp/x' }, { output: 'ok' });
    cache.set('Edit', { file_path: '/tmp/x' }, { output: 'ok' });
    cache.set('Bash', { command: 'ls' }, { output: 'ok' });
    expect(cache.get('Write', { file_path: '/tmp/x' })).toBeUndefined();
    expect(cache.get('Edit', { file_path: '/tmp/x' })).toBeUndefined();
    expect(cache.get('Bash', { command: 'ls' })).toBeUndefined();
  });

  it('invalidates cache on Write', () => {
    cache.set('Read', { file_path: '/tmp/test.ts' }, { output: 'old' });
    cache.invalidate('Write', { file_path: '/tmp/test.ts' });
    expect(cache.get('Read', { file_path: '/tmp/test.ts' })).toBeUndefined();
  });

  it('clears entire cache on Bash', () => {
    cache.set('Read', { file_path: '/a.ts' }, { output: 'a' });
    cache.set('Read', { file_path: '/b.ts' }, { output: 'b' });
    cache.invalidate('Bash', { command: 'rm -rf /tmp/test' });
    expect(cache.get('Read', { file_path: '/a.ts' })).toBeUndefined();
    expect(cache.get('Read', { file_path: '/b.ts' })).toBeUndefined();
  });

  it('returns miss for uncached keys', () => {
    expect(cache.get('Read', { file_path: '/nonexistent' })).toBeUndefined();
  });

  it('tracks hit/miss stats', () => {
    cache.set('Read', { file_path: '/x' }, { output: 'x' });
    cache.get('Read', { file_path: '/x' }); // hit
    cache.get('Read', { file_path: '/y' }); // miss
    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe('50%');
  });
});
