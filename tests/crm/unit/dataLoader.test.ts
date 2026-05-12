/**
 * DataLoader — Unit Tests (batching + dedup)
 */
import { describe, it, expect } from 'vitest';
import { DataLoader } from '../../../src/crm/dataLoader.js';

describe('DataLoader — batches calls in single tick', () => {
  it('batches multiple load() into 1 batchFn call', async () => {
    let batchCalls = 0;
    const loader = new DataLoader<string, string>(async (keys) => {
      batchCalls++;
      const m = new Map<string, string>();
      for (const k of keys) m.set(k, 'value_' + k);
      return m;
    });

    const results = await Promise.all([loader.load('a'), loader.load('b'), loader.load('c')]);
    expect(results).toEqual(['value_a', 'value_b', 'value_c']);
    expect(batchCalls).toBe(1);
  });

  it('dedupes same key', async () => {
    const seenKeys: string[][] = [];
    const loader = new DataLoader<string, string>(async (keys) => {
      seenKeys.push([...keys]);
      return new Map(keys.map(k => [k, k.toUpperCase()]));
    });

    const results = await Promise.all([loader.load('x'), loader.load('x'), loader.load('y')]);
    expect(results).toEqual(['X', 'X', 'Y']);
    expect(seenKeys[0]).toHaveLength(2); // only x + y sent to batch
  });

  it('caches within instance lifetime', async () => {
    let fetches = 0;
    const loader = new DataLoader<string, number>(async (keys) => {
      fetches += keys.length;
      return new Map(keys.map(k => [k, parseInt(k)]));
    });

    await loader.load('1');
    await loader.load('2');
    await loader.load('1'); // cached
    await loader.load('1'); // cached
    expect(fetches).toBe(2);
  });

  it('returns null for missing keys', async () => {
    const loader = new DataLoader<string, string>(async (keys) => {
      const m = new Map<string, string>();
      m.set('exists', 'yes');
      return m;
    });
    expect(await loader.load('exists')).toBe('yes');
    expect(await loader.load('missing')).toBeNull();
  });
});
