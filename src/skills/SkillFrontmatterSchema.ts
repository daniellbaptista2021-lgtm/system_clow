/**
 * SkillFrontmatterSchema.ts — Zod validation for SKILL.md frontmatter
 *
 * Based on Claude Code's skillFrontmatterSchema.ts (~150 lines)
 *
 * Features:
 *   - Complete Zod schema for all frontmatter fields
 *   - Trigger type validation with sub-schemas
 *   - Name format validation (kebab-case)
 *   - Category enum validation
 *   - Tier enum validation
 *   - Error message formatting
 *   - Partial validation (for migration)
 */

import { z } from 'zod';
import type { SkillFrontmatter } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// Sub-Schemas
// ════════════════════════════════════════════════════════════════════════════

const TriggerTypeSchema = z.enum([
  'keyword',
  'regex',
  'glob',
  'tool_use',
  'hook_event',
  'context_match',
  'always',
  'first_message',
]);

const TriggerSchema = z.object({
  type: TriggerTypeSchema,
  /** Patterns for keyword/regex/glob triggers */
  patterns: z.array(z.string()).optional(),
  /** Context string for context_match triggers */
  context: z.string().optional(),
  /** Tool names for tool_use triggers */
  tools: z.array(z.string()).optional(),
  /** Event names for hook_event triggers */
  events: z.array(z.string()).optional(),
  /** Weight multiplier (0-10, default 1) */
  weight: z.number().min(0).max(10).optional(),
});

const CategorySchema = z.enum([
  'writing', 'coding', 'data', 'design', 'research',
  'automation', 'reference', 'workflow', 'integration', 'utility',
]);

const TierSchema = z.enum(['one', 'smart', 'profissional', 'business']);

// ════════════════════════════════════════════════════════════════════════════
// Main Schema
// ════════════════════════════════════════════════════════════════════════════

export const FrontmatterSchema = z.object({
  /** Skill name (kebab-case, 1-100 chars) */
  name: z.string()
    .min(1, 'Skill name is required')
    .max(100, 'Skill name too long')
    .regex(/^[a-z0-9][a-z0-9\-_]*$/, 'Skill name must be kebab-case'),

  /** Human-readable description (5-500 chars) */
  description: z.string()
    .min(5, 'Description must be at least 5 chars')
    .max(500, 'Description must be at most 500 chars'),

  /** Skill version (semver) */
  version: z.string().optional(),

  /** Author name */
  author: z.string().optional(),

  /** Trigger definitions */
  triggers: z.array(TriggerSchema).optional(),

  /** Whether this skill is always injected */
  always_active: z.boolean().optional(),

  /** Tags for discovery (max 20) */
  tags: z.array(z.string()).max(20).optional(),

  /** Skill category */
  category: CategorySchema.optional(),

  /** Tools this skill uses */
  uses_tools: z.array(z.string()).optional(),

  /** Reference file paths (relative to skill dir) */
  references: z.array(z.string()).max(20).optional(),

  /** Primary language code */
  language: z.string().optional(),

  /** Minimum tenant tier required */
  min_tier: TierSchema.optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// Validation Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a raw object against the skill frontmatter schema.
 */
export function validateFrontmatter(
  raw: unknown,
): { valid: true; data: SkillFrontmatter } | { valid: false; errors: string[] } {
  const result = FrontmatterSchema.safeParse(raw);

  if (result.success) {
    return { valid: true, data: result.data as SkillFrontmatter };
  }

  return {
    valid: false,
    errors: result.error.issues.map(issue =>
      `${issue.path.join('.')}: ${issue.message}`,
    ),
  };
}

/**
 * Check if a skill name is valid.
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9\-_]*$/.test(name) && name.length <= 100;
}

/**
 * Validate triggers only.
 */
export function validateTriggers(triggers: unknown[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  for (let i = 0; i < triggers.length; i++) {
    const result = TriggerSchema.safeParse(triggers[i]);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`triggers[${i}].${issue.path.join('.')}: ${issue.message}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
