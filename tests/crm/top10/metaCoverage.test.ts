/**
 * TOP 10 #10 — Meta-test (Ondas 33-34)
 * Valida que os 10 suites da TOP 10 estao presentes e que o vitest pode descobri-los.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = join(__dirname, '..', 'top10');
const EXPECTED_SUITES = [
  'analytics.test.ts',         // #1
  'reports.test.ts',            // #2
  'proposals.test.ts',          // #3
  'leadScoring.test.ts',        // #4
  'savedViews.test.ts',         // #5
  'outboundWebhooks.test.ts',   // #6
  'forms.test.ts',              // #7
  'tasks.test.ts',              // #8
  'softDeleteAudit.test.ts',    // #9
  'metaCoverage.test.ts',       // #10 (this file)
];

describe('TOP 10 #10 — Meta-coverage', () => {
  it('all 10 TOP features have a test suite present', () => {
    const missing: string[] = [];
    for (const name of EXPECTED_SUITES) {
      if (!existsSync(join(TESTS_DIR, name))) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('TOP 10 coverage is 100%', () => {
    const total = EXPECTED_SUITES.length;
    const present = EXPECTED_SUITES.filter((n) => existsSync(join(TESTS_DIR, n))).length;
    expect(present / total).toBe(1.0);
  });

  it('each expected file has size > 500 bytes', () => {
    const { statSync } = require('fs');
    for (const name of EXPECTED_SUITES) {
      const full = join(TESTS_DIR, name);
      if (existsSync(full)) {
        const size = statSync(full).size;
        expect(size, name).toBeGreaterThan(500);
      }
    }
  });
});
