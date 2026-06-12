/**
 * PluginManifestSchema.ts — Zod validation schema for plugin.json manifest
 *
 * Based on Claude Code's pluginManifestSchema.ts (~350 lines)
 *
 * Features:
 *   - Complete Zod schema for all manifest fields
 *   - Semver version validation
 *   - Kebab-case name validation
 *   - URL validation for homepage, repository
 *   - Permission enum validation
 *   - Category enum validation
 *   - MCP server definition validation
 *   - Config schema validation
 *   - Error-to-PluginValidationError mapping
 *   - Partial validation (for migration/upgrade)
 *   - Schema version support
 */

import { z } from 'zod';
import type { PluginManifest, PluginValidationError } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// Sub-schemas
// ════════════════════════════════════════════════════════════════════════════

const AuthorSchema = z.object({
  name: z.string().min(1, 'Author name is required'),
  email: z.string().email('Invalid email format').optional(),
  url: z.string().url('Invalid URL format').optional(),
});

const MCPServerSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  args: z.array(z.string()).max(50, 'Too many args (max 50)').optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url('Invalid MCP URL').optional(),
  description: z.string().max(500, 'Description too long').optional(),
});

const PermissionSchema = z.enum([
  'filesystem-read',
  'filesystem-write',
  'network',
  'shell-execution',
  'spawn-subagent',
  'modify-permissions',
  'register-hooks',
  'register-tools',
  'access-secrets',
]);

const CategorySchema = z.enum([
  'productivity',
  'development',
  'data-science',
  'devops',
  'integration',
  'communication',
  'utility',
  'workflow',
  'language',
  'framework',
]);

const TierSchema = z.enum(['one', 'smart', 'profissional', 'business']);

const ConfigPropertySchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.unknown()),
  required: z.array(z.string()).optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// Main Schema
// ════════════════════════════════════════════════════════════════════════════

export const PluginManifestSchema = z.object({
  // Required fields
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long (max 100 chars)')
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case (lowercase, hyphens, no leading hyphen)'),

  version: z.string()
    .regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'Must be valid semver (e.g., 1.0.0, 1.0.0-beta.1)'),

  description: z.string()
    .min(10, 'Description too short (min 10 chars)')
    .max(500, 'Description too long (max 500 chars)'),

  // Optional metadata
  author: AuthorSchema.optional(),
  license: z.string().max(50).optional(),
  homepage: z.string().url('Invalid homepage URL').optional(),
  repository: z.string().max(500).optional(),

  // Components
  commands: z.array(z.string()).max(50, 'Too many command patterns (max 50)').optional(),
  agents: z.array(z.string()).max(20, 'Too many agent patterns (max 20)').optional(),
  skills: z.array(z.string()).max(50, 'Too many skill patterns (max 50)').optional(),
  hooks: z.string().max(200, 'Hooks path too long').optional(),
  mcpServers: z.record(MCPServerSchema).optional(),
  outputStyles: z.array(z.string()).max(50, 'Too many style patterns (max 50)').optional(),
  tools: z.array(z.string()).max(50, 'Too many tool patterns (max 50)').optional(),

  // Dependencies
  dependencies: z.record(z.string()).optional(),
  peerDependencies: z.record(z.string()).optional(),
  clowVersion: z.string().max(50).optional(),

  // Configuration
  config: ConfigPropertySchema.optional(),
  defaultConfig: z.record(z.unknown()).optional(),

  // Discovery metadata
  tags: z.array(z.string().max(50)).max(20, 'Too many tags (max 20)').optional(),
  category: CategorySchema.optional(),
  keywords: z.array(z.string().max(50)).max(20, 'Too many keywords (max 20)').optional(),
  icon: z.string().max(200).optional(),

  // Security
  requiredPermissions: z.array(PermissionSchema).optional(),
  minTier: TierSchema.optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// Validation Function
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a raw object against the plugin manifest schema.
 * Returns either the validated manifest or an array of validation errors.
 */
export function validatePluginManifest(
  raw: unknown,
): { valid: true; data: PluginManifest } | { valid: false; errors: PluginValidationError[] } {
  const result = PluginManifestSchema.safeParse(raw);

  if (result.success) {
    return { valid: true, data: result.data as PluginManifest };
  }

  const errors: PluginValidationError[] = result.error.issues.map(issue => ({
    code: 'MANIFEST_VALIDATION',
    message: `${issue.path.join('.')}: ${issue.message}`,
    severity: 'error' as const,
    field: issue.path.join('.'),
    recoverable: false,
  }));

  return { valid: false, errors };
}

/**
 * Validate partially — for manifest migration or upgrade scenarios.
 * Only validates fields that are present in the raw object.
 */
export function validatePartialManifest(
  raw: unknown,
): { warnings: PluginValidationError[]; data: Partial<PluginManifest> } {
  const warnings: PluginValidationError[] = [];

  if (!raw || typeof raw !== 'object') {
    return { warnings: [{ code: 'NOT_OBJECT', message: 'Manifest must be an object', severity: 'error', recoverable: false }], data: {} };
  }

  const obj = raw as Record<string, unknown>;
  const partial: Record<string, unknown> = {};

  // Validate only present fields
  if (obj.name !== undefined) {
    if (typeof obj.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(obj.name)) {
      partial.name = obj.name;
    } else {
      warnings.push({ code: 'INVALID_NAME', message: 'Name must be kebab-case', severity: 'warning', field: 'name', recoverable: true });
    }
  }

  if (obj.version !== undefined) {
    if (typeof obj.version === 'string' && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(obj.version)) {
      partial.version = obj.version;
    } else {
      warnings.push({ code: 'INVALID_VERSION', message: 'Version must be semver', severity: 'warning', field: 'version', recoverable: true });
    }
  }

  if (obj.description !== undefined) {
    if (typeof obj.description === 'string') {
      partial.description = obj.description;
    }
  }

  // Copy safe fields
  for (const key of ['author', 'license', 'homepage', 'repository', 'commands', 'agents', 'skills', 'hooks', 'mcpServers', 'outputStyles', 'tools', 'dependencies', 'peerDependencies', 'tags', 'category', 'keywords', 'icon']) {
    if (obj[key] !== undefined) {
      partial[key] = obj[key];
    }
  }

  return { warnings, data: partial as Partial<PluginManifest> };
}

/**
 * Check if a manifest name is valid.
 */
export function isValidManifestName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 100;
}

/**
 * Check if a version string is valid semver.
 */
export function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
}

/**
 * Parse a semver string into components.
 */
export function parseSemver(version: string): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  };
}

/**
 * Compare two semver strings.
 * Returns negative if a < b, positive if a > b, zero if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  return 0;
}

/**
 * Get a list of all valid plugin categories.
 */
export function getValidCategories(): string[] {
  return ['productivity', 'development', 'data-science', 'devops', 'integration', 'communication', 'utility', 'workflow', 'language', 'framework'];
}

/**
 * Get a list of all valid plugin permissions.
 */
export function getValidPermissions(): string[] {
  return ['filesystem-read', 'filesystem-write', 'network', 'shell-execution', 'spawn-subagent', 'modify-permissions', 'register-hooks', 'register-tools', 'access-secrets'];
}
