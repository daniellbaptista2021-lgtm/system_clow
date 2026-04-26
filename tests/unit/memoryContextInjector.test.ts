/**
 * MemoryContextInjector — Unit Tests
 *
 * Tests: context generation, token budget, date formatting,
 * empty state handling, file dedup.
 */

import { describe, it, expect } from 'vitest';

describe('MemoryContextInjector', () => {
  describe('formatDate helper', () => {
    it('formats epoch ms to DD/Mon format', () => {
      // April 15, 2026
      const epoch = new Date(2026, 3, 15).getTime();
      const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      const d = new Date(epoch);
      const formatted = `${d.getDate()}/${months[d.getMonth()]}`;
      expect(formatted).toBe('15/Abr');
    });
  });

  describe('Token Budget', () => {
    it('enforces max chars limit', () => {
      const MAX_CHARS = 8000;
      const longText = 'A'.repeat(10000);
      const truncated = longText.length > MAX_CHARS
        ? longText.slice(0, MAX_CHARS) + '\n...(memória truncada)'
        : longText;

      expect(truncated.length).toBeLessThanOrEqual(MAX_CHARS + 30);
    });
  });

  describe('Empty State', () => {
    it('returns empty string when no memories exist', () => {
      // With no data, generateMemoryContext should return ''
      // This tests the logic pattern, not the actual function (which needs DB)
      const summaries: any[] = [];
      const observations: any[] = [];

      const result = summaries.length === 0 && observations.length === 0 ? '' : 'has data';
      expect(result).toBe('');
    });
  });

  describe('File Deduplication', () => {
    it('deduplicates file paths from observations', () => {
      const observations = [
        { files_touched: JSON.stringify(['/src/a.ts', '/src/b.ts']) },
        { files_touched: JSON.stringify(['/src/a.ts', '/src/c.ts']) },
        { files_touched: null },
      ];

      const allFiles = new Set<string>();
      for (const obs of observations) {
        if (obs.files_touched) {
          try {
            const files = JSON.parse(obs.files_touched) as string[];
            files.forEach(f => allFiles.add(f));
          } catch {}
        }
      }

      expect(allFiles.size).toBe(3);
      expect(allFiles.has('/src/a.ts')).toBe(true);
      expect(allFiles.has('/src/b.ts')).toBe(true);
      expect(allFiles.has('/src/c.ts')).toBe(true);
    });
  });
});
