/**
 * PluginPolicy.ts — Trust model and permission policy
 *
 * Based on Claude Code's pluginPolicy.ts (300 lines)
 *
 * Implements:
 *   - Source-based trust determination (builtin/marketplace = managed, others = untrusted)
 *   - Permission risk classification (dangerous vs safe)
 *   - Trust prompt decision logic
 *   - Permission grant/deny policy
 *   - Tier-based access control
 *   - Component-level permission mapping
 *   - Auto-trust rules for known publishers
 *   - Policy override via admin settings
 *   - Per-tier permission limits
 *   - Auto-deny rules for specific combinations
 *   - Plugin risk classification
 *   - Policy report generation
 */

import type { LoadedPlugin, PluginPermission, PluginSource } from '../types.js';

// ─── Permission Classification ──────────────────────────────────────────────

/** Permissions that can execute arbitrary code or access sensitive data */
const DANGEROUS_PERMISSIONS: PluginPermission[] = [
  'shell-execution',
  'modify-permissions',
  'access-secrets',
  'register-tools',
];

/** Permissions that are generally safe */
const SAFE_PERMISSIONS: PluginPermission[] = [
  'filesystem-read',
  'network',
  'spawn-subagent',
  'register-hooks',
];

/** Permission risk levels */
export type PermissionRisk = 'safe' | 'moderate' | 'dangerous' | 'critical';

/** Permission → risk mapping */
const PERMISSION_RISK: Record<PluginPermission, PermissionRisk> = {
  'filesystem-read': 'safe',
  'network': 'moderate',
  'spawn-subagent': 'moderate',
  'register-hooks': 'moderate',
  'filesystem-write': 'moderate',
  'shell-execution': 'dangerous',
  'register-tools': 'dangerous',
  'modify-permissions': 'critical',
  'access-secrets': 'critical',
};

/** Which permissions each component type requires */
const COMPONENT_PERMISSIONS: Record<string, PluginPermission[]> = {
  commands: [],
  agents: ['spawn-subagent'],
  hooks: ['register-hooks'],
  skills: [],
  mcpServers: ['network'],
  tools: ['register-tools'],
  outputStyles: [],
};

// ─── Source Trust Levels ────────────────────────────────────────────────────

export type SourceTrustLevel = 'managed' | 'semi_trusted' | 'untrusted';

const SOURCE_TRUST: Record<PluginSource['type'], SourceTrustLevel> = {
  builtin: 'managed',
  marketplace: 'managed',
  user: 'semi_trusted',
  project: 'semi_trusted',
  local: 'semi_trusted',
  git: 'untrusted',
  zip: 'untrusted',
};

// ─── Per-Tier Permission Limits ─────────────────────────────────────────────

/**
 * Maximum number of each permission type that may be granted per tier.
 * Permissions exceeding these limits are silently dropped from the grant set.
 */
const TIER_PERMISSION_LIMITS: Record<string, Partial<Record<PluginPermission, number>>> = {
  one: {
    'filesystem-read': 5,
    'filesystem-write': 0,
    'network': 2,
    'shell-execution': 0,
    'spawn-subagent': 1,
    'modify-permissions': 0,
    'register-hooks': 2,
    'register-tools': 1,
    'access-secrets': 0,
  },
  smart: {
    'filesystem-read': 20,
    'filesystem-write': 5,
    'network': 10,
    'shell-execution': 2,
    'spawn-subagent': 5,
    'modify-permissions': 0,
    'register-hooks': 10,
    'register-tools': 5,
    'access-secrets': 1,
  },
  profissional: {
    'filesystem-read': 100,
    'filesystem-write': 50,
    'network': 50,
    'shell-execution': 10,
    'spawn-subagent': 20,
    'modify-permissions': 2,
    'register-hooks': 50,
    'register-tools': 20,
    'access-secrets': 5,
  },
  business: {
    // Business tier has no hard limits — return undefined to skip checks
  },
};

// ─── Auto-Deny Rules ───────────────────────────────────────────────────────

/**
 * Certain permission combinations are automatically denied regardless of
 * trust level. Each rule is a pair of permissions that must not coexist
 * on a single plugin.
 */
interface AutoDenyRule {
  /** Human-readable label for the rule */
  readonly label: string;
  /** The pair of permissions that trigger the denial */
  readonly permissions: readonly [PluginPermission, PluginPermission];
  /** Optional: only apply this rule to specific source trust levels */
  readonly appliesTo?: readonly SourceTrustLevel[];
}

const AUTO_DENY_RULES: readonly AutoDenyRule[] = [
  {
    label: 'secrets-plus-network',
    permissions: ['access-secrets', 'network'],
    appliesTo: ['untrusted'],
  },
  {
    label: 'shell-plus-secrets',
    permissions: ['shell-execution', 'access-secrets'],
    appliesTo: ['untrusted', 'semi_trusted'],
  },
  {
    label: 'modify-perms-plus-shell',
    permissions: ['modify-permissions', 'shell-execution'],
  },
  {
    label: 'modify-perms-plus-secrets',
    permissions: ['modify-permissions', 'access-secrets'],
  },
];

// ─── Plugin Risk Classification ─────────────────────────────────────────────

/** Overall risk classification for a plugin */
export type PluginRiskClass = 'low' | 'medium' | 'high' | 'critical';

/** Detailed risk classification result */
export interface PluginRiskReport {
  /** Overall risk class */
  riskClass: PluginRiskClass;
  /** Numeric score from 0 (safe) to 100 (extremely dangerous) */
  score: number;
  /** Human-readable explanation of the risk factors */
  factors: string[];
  /** Recommended action */
  recommendation: 'auto-approve' | 'prompt-user' | 'manual-review' | 'deny';
}

/** Result of a full policy report for one or more plugins */
export interface PolicyReport {
  /** ISO-8601 timestamp when the report was generated */
  generatedAt: string;
  /** Total number of plugins evaluated */
  pluginCount: number;
  /** Breakdown by risk class */
  riskBreakdown: Record<PluginRiskClass, number>;
  /** Breakdown by source trust level */
  sourceBreakdown: Record<SourceTrustLevel, number>;
  /** Per-plugin detail rows */
  entries: PolicyReportEntry[];
  /** Detected auto-deny violations */
  autoDenyViolations: string[];
}

/** Single row in a policy report */
export interface PolicyReportEntry {
  pluginName: string;
  version: string;
  sourceTrust: SourceTrustLevel;
  highestRisk: PermissionRisk;
  riskClass: PluginRiskClass;
  grantedPermissions: PluginPermission[];
  deniedPermissions: PluginPermission[];
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// PluginPolicy Class
// ═══════════════════════════════════════════════════════════════════════════

export class PluginPolicy {
  private autoTrustedPublishers: Set<string> = new Set();
  private adminOverrides: Map<string, boolean> = new Map();
  /** Tracks how many grants of each permission have been issued in the current tier */
  private tierGrantCounts: Map<PluginPermission, number> = new Map();
  /** The tier currently active for tier-limit enforcement */
  private activeTier: string | undefined;

  // ─── Source Trust ─────────────────────────────────────────────────

  /** Is this plugin from a managed (official) source? */
  isManaged(plugin: LoadedPlugin): boolean {
    return this.getSourceTrustLevel(plugin) === 'managed';
  }

  /** Get the trust level for a plugin's source. */
  getSourceTrustLevel(plugin: LoadedPlugin): SourceTrustLevel {
    return SOURCE_TRUST[plugin.source.type] ?? 'untrusted';
  }

  // ─── Permission Analysis ──────────────────────────────────────────

  /** Does plugin require any elevated/dangerous permissions? */
  requiresElevated(plugin: LoadedPlugin): boolean {
    return (plugin.manifest.requiredPermissions ?? []).some(p =>
      DANGEROUS_PERMISSIONS.includes(p),
    );
  }

  /** Get the highest risk level among all required permissions. */
  getHighestRisk(plugin: LoadedPlugin): PermissionRisk {
    const perms = plugin.manifest.requiredPermissions ?? [];
    if (perms.length === 0) return 'safe';

    let highest: PermissionRisk = 'safe';
    const riskOrder: Record<PermissionRisk, number> = { safe: 0, moderate: 1, dangerous: 2, critical: 3 };

    for (const perm of perms) {
      const risk = PERMISSION_RISK[perm] ?? 'moderate';
      if (riskOrder[risk] > riskOrder[highest]) highest = risk;
    }

    return highest;
  }

  /** Get risk level for a specific permission. */
  getPermissionRisk(perm: PluginPermission): PermissionRisk {
    return PERMISSION_RISK[perm] ?? 'moderate';
  }

  /** Get human-readable explanation of why a permission is needed. */
  explainPermission(perm: PluginPermission): string {
    const explanations: Record<PluginPermission, string> = {
      'filesystem-read': 'Read files from the workspace',
      'filesystem-write': 'Create and modify files in the workspace',
      'network': 'Make HTTP requests to external services',
      'shell-execution': 'Execute arbitrary shell commands on your machine',
      'spawn-subagent': 'Create sub-agent processes',
      'modify-permissions': 'Change file permissions and access controls',
      'register-hooks': 'Register hooks that intercept tool execution',
      'register-tools': 'Register new tools that the AI can call',
      'access-secrets': 'Read environment variables and credential files',
    };
    return explanations[perm] ?? 'Unknown permission';
  }

  /**
   * Get a detailed, context-aware explanation of a permission including its
   * risk level, what granting it allows, and what happens if it is denied.
   */
  getPermissionExplanation(perm: PluginPermission): {
    description: string;
    risk: PermissionRisk;
    grantImplication: string;
    denyImplication: string;
  } {
    const risk = this.getPermissionRisk(perm);
    const description = this.explainPermission(perm);

    const grantImplications: Record<PluginPermission, string> = {
      'filesystem-read': 'The plugin will be able to read any file within the workspace tree.',
      'filesystem-write': 'The plugin can create, overwrite, or delete files in the workspace.',
      'network': 'The plugin can make outbound HTTP/HTTPS requests to any reachable host.',
      'shell-execution': 'The plugin can run arbitrary commands with the privileges of the current user.',
      'spawn-subagent': 'The plugin can spawn child agent processes that consume additional resources.',
      'modify-permissions': 'The plugin can change POSIX file mode bits and ownership metadata.',
      'register-hooks': 'The plugin can intercept and potentially modify tool invocations.',
      'register-tools': 'The plugin can expose new callable tools to the AI model.',
      'access-secrets': 'The plugin can read API keys, tokens, and other credentials from the environment.',
    };

    const denyImplications: Record<PluginPermission, string> = {
      'filesystem-read': 'The plugin will not be able to read workspace files and may fail if it depends on reading configuration.',
      'filesystem-write': 'The plugin cannot persist any output to disk.',
      'network': 'The plugin cannot reach external APIs or download remote resources.',
      'shell-execution': 'The plugin cannot invoke shell commands; build/test integrations will not work.',
      'spawn-subagent': 'The plugin cannot create child agents; multi-step workflows may be unavailable.',
      'modify-permissions': 'The plugin cannot change file permissions; deployment scripts may fail.',
      'register-hooks': 'The plugin cannot install lifecycle hooks; pre/post execution logic is disabled.',
      'register-tools': 'The plugin cannot register tools; its custom tool surface will be invisible to the AI.',
      'access-secrets': 'The plugin cannot read secrets; authenticated API calls will fail.',
    };

    return {
      description,
      risk,
      grantImplication: grantImplications[perm] ?? 'Unknown grant implication.',
      denyImplication: denyImplications[perm] ?? 'The plugin may not function correctly without this permission.',
    };
  }

  /**
   * Suggest the minimal set of permissions a plugin actually needs based on
   * its declared components, stripping any over-requested permissions.
   */
  getRecommendedPermissions(plugin: LoadedPlugin): {
    recommended: PluginPermission[];
    unnecessary: PluginPermission[];
  } {
    const inferred = new Set(this.inferRequiredPermissions(plugin));
    const declared = plugin.manifest.requiredPermissions ?? [];
    const recommended: PluginPermission[] = [];
    const unnecessary: PluginPermission[] = [];

    for (const perm of declared) {
      if (inferred.has(perm)) {
        recommended.push(perm);
      } else {
        unnecessary.push(perm);
      }
    }

    // Add inferred permissions that were not declared (they should be)
    for (const perm of inferred) {
      if (!declared.includes(perm) && !recommended.includes(perm)) {
        recommended.push(perm);
      }
    }

    return { recommended, unnecessary };
  }

  // ─── Risk Classification ─────────────────────────────────────────

  /**
   * Classify the overall risk of a plugin by combining permission risk,
   * source trust, component surface area, and auto-deny violations.
   */
  classifyPluginRisk(plugin: LoadedPlugin): PluginRiskReport {
    const factors: string[] = [];
    let score = 0;

    // Factor 1: source trust
    const sourceTrust = this.getSourceTrustLevel(plugin);
    if (sourceTrust === 'untrusted') {
      score += 30;
      factors.push('Plugin originates from an untrusted source.');
    } else if (sourceTrust === 'semi_trusted') {
      score += 10;
      factors.push('Plugin originates from a semi-trusted source.');
    }

    // Factor 2: highest permission risk
    const highestRisk = this.getHighestRisk(plugin);
    const riskScoreMap: Record<PermissionRisk, number> = { safe: 0, moderate: 10, dangerous: 25, critical: 40 };
    score += riskScoreMap[highestRisk];
    if (highestRisk === 'dangerous' || highestRisk === 'critical') {
      factors.push(`Requests ${highestRisk}-level permissions.`);
    }

    // Factor 3: number of permissions requested
    const permCount = (plugin.manifest.requiredPermissions ?? []).length;
    if (permCount > 5) {
      score += 10;
      factors.push(`Requests ${permCount} permissions (broad surface area).`);
    } else if (permCount > 3) {
      score += 5;
      factors.push(`Requests ${permCount} permissions.`);
    }

    // Factor 4: auto-deny violations
    const violations = this.getAutoDenyViolations(plugin);
    if (violations.length > 0) {
      score += 20;
      for (const v of violations) {
        factors.push(`Auto-deny rule triggered: ${v}.`);
      }
    }

    // Factor 5: over-requested permissions
    const { unnecessary } = this.getRecommendedPermissions(plugin);
    if (unnecessary.length > 0) {
      score += unnecessary.length * 5;
      factors.push(`${unnecessary.length} permission(s) appear unnecessary based on declared components.`);
    }

    // Clamp score
    score = Math.min(100, Math.max(0, score));

    // Derive risk class
    let riskClass: PluginRiskClass;
    if (score <= 15) riskClass = 'low';
    else if (score <= 40) riskClass = 'medium';
    else if (score <= 70) riskClass = 'high';
    else riskClass = 'critical';

    // Derive recommendation
    let recommendation: PluginRiskReport['recommendation'];
    if (riskClass === 'low') recommendation = 'auto-approve';
    else if (riskClass === 'medium') recommendation = 'prompt-user';
    else if (riskClass === 'high') recommendation = 'manual-review';
    else recommendation = 'deny';

    if (factors.length === 0) {
      factors.push('No notable risk factors detected.');
    }

    return { riskClass, score, factors, recommendation };
  }

  // ─── Auto-Deny Rules ─────────────────────────────────────────────

  /**
   * Return descriptions of any auto-deny rules that a plugin violates.
   * If the returned array is non-empty the plugin should be denied.
   */
  getAutoDenyViolations(plugin: LoadedPlugin): string[] {
    const perms = new Set(plugin.manifest.requiredPermissions ?? []);
    const trust = this.getSourceTrustLevel(plugin);
    const violations: string[] = [];

    for (const rule of AUTO_DENY_RULES) {
      // Check trust-level applicability
      if (rule.appliesTo && !rule.appliesTo.includes(trust)) continue;

      const [a, b] = rule.permissions;
      if (perms.has(a) && perms.has(b)) {
        violations.push(`${rule.label}: combining ${a} and ${b} is not allowed`);
      }
    }

    return violations;
  }

  // ─── Trust Decision ───────────────────────────────────────────────

  /** Should this plugin prompt for trust before loading? */
  shouldPromptTrust(plugin: LoadedPlugin): boolean {
    // Admin override
    const override = this.adminOverrides.get(plugin.manifest.name);
    if (override !== undefined) return !override;

    // Managed sources never prompt
    if (this.isManaged(plugin)) return false;

    // Already trusted
    if (plugin.trustState === 'trusted') return false;

    // Auto-trusted publisher
    if (plugin.manifest.author?.name && this.autoTrustedPublishers.has(plugin.manifest.author.name)) {
      return false;
    }

    // Blocked plugins always prompt (or rather, always deny)
    if (plugin.trustState === 'blocked') return true;

    return true;
  }

  /** Should this plugin be auto-blocked (not just prompted)? */
  shouldAutoBlock(plugin: LoadedPlugin): boolean {
    if (plugin.trustState === 'blocked') return true;

    // Critical permissions from untrusted source = auto-block
    const risk = this.getHighestRisk(plugin);
    const trust = this.getSourceTrustLevel(plugin);

    if (risk === 'critical' && trust === 'untrusted') return true;

    // Auto-deny rule violations = auto-block
    if (this.getAutoDenyViolations(plugin).length > 0) return true;

    return false;
  }

  // ─── Permission Grants ────────────────────────────────────────────

  /** Get default granted permissions based on source trust level. */
  getDefaultGrants(plugin: LoadedPlugin): PluginPermission[] {
    const trust = this.getSourceTrustLevel(plugin);

    switch (trust) {
      case 'managed':
        // Managed plugins get all their requested permissions
        return plugin.manifest.requiredPermissions ?? [];

      case 'semi_trusted':
        // Semi-trusted get safe + moderate permissions
        return (plugin.manifest.requiredPermissions ?? []).filter(p => {
          const risk = PERMISSION_RISK[p];
          return risk === 'safe' || risk === 'moderate';
        });

      case 'untrusted':
        // Untrusted get only safe permissions
        return (plugin.manifest.requiredPermissions ?? []).filter(p =>
          PERMISSION_RISK[p] === 'safe',
        );
    }
  }

  /** Check if a plugin has a specific permission granted. */
  hasPermission(plugin: LoadedPlugin, perm: PluginPermission): boolean {
    const grants = this.getDefaultGrants(plugin);
    return grants.includes(perm);
  }

  // ─── Tier Access ──────────────────────────────────────────────────

  /** Check if plugin is accessible for the given tier. */
  isAccessibleForTier(plugin: LoadedPlugin, currentTier?: string): boolean {
    if (!plugin.manifest.minTier) return true;
    if (!currentTier) return false;

    const tierOrder: Record<string, number> = { one: 1, smart: 2, profissional: 3, business: 4 };
    return (tierOrder[currentTier] ?? 0) >= (tierOrder[plugin.manifest.minTier] ?? 0);
  }

  /**
   * Set the active tier for permission-limit enforcement.
   * This resets the grant counters.
   */
  setActiveTier(tier: string): void {
    this.activeTier = tier;
    this.tierGrantCounts.clear();
  }

  /**
   * Check whether granting a permission would exceed the per-tier limit.
   * Returns `true` if the grant is within budget, `false` otherwise.
   */
  isTierGrantAllowed(perm: PluginPermission): boolean {
    if (!this.activeTier) return true;

    const limits = TIER_PERMISSION_LIMITS[this.activeTier];
    if (!limits) return true; // unknown tier = no limits

    const max = limits[perm];
    if (max === undefined) return true; // no limit for this perm on this tier

    const current = this.tierGrantCounts.get(perm) ?? 0;
    return current < max;
  }

  /**
   * Record that a permission grant was consumed for tier-limit tracking.
   */
  recordTierGrant(perm: PluginPermission): void {
    const current = this.tierGrantCounts.get(perm) ?? 0;
    this.tierGrantCounts.set(perm, current + 1);
  }

  /**
   * Return the remaining quota for each permission under the active tier.
   * Returns `undefined` for permissions that have no limit.
   */
  getTierRemainingQuota(): Map<PluginPermission, number | undefined> {
    const result = new Map<PluginPermission, number | undefined>();
    const allPerms = Object.keys(PERMISSION_RISK) as PluginPermission[];

    for (const perm of allPerms) {
      if (!this.activeTier) {
        result.set(perm, undefined);
        continue;
      }
      const limits = TIER_PERMISSION_LIMITS[this.activeTier];
      if (!limits) {
        result.set(perm, undefined);
        continue;
      }
      const max = limits[perm];
      if (max === undefined) {
        result.set(perm, undefined);
      } else {
        const used = this.tierGrantCounts.get(perm) ?? 0;
        result.set(perm, Math.max(0, max - used));
      }
    }

    return result;
  }

  // ─── Component Permission Inference ───────────────────────────────

  /** Infer required permissions from declared components. */
  inferRequiredPermissions(plugin: LoadedPlugin): PluginPermission[] {
    const inferred = new Set<PluginPermission>();
    const manifest = plugin.manifest;

    if (manifest.hooks) {
      for (const perm of COMPONENT_PERMISSIONS.hooks) inferred.add(perm);
    }
    if (manifest.agents?.length) {
      for (const perm of COMPONENT_PERMISSIONS.agents) inferred.add(perm);
    }
    if (manifest.tools?.length) {
      for (const perm of COMPONENT_PERMISSIONS.tools) inferred.add(perm);
    }
    if (manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0) {
      for (const perm of COMPONENT_PERMISSIONS.mcpServers) inferred.add(perm);
    }

    return [...inferred];
  }

  /** Check if declared permissions match inferred permissions. */
  validatePermissionDeclarations(plugin: LoadedPlugin): string[] {
    const inferred = this.inferRequiredPermissions(plugin);
    const declared = new Set(plugin.manifest.requiredPermissions ?? []);
    const missing: string[] = [];

    for (const perm of inferred) {
      if (!declared.has(perm)) {
        missing.push(`Plugin uses ${perm} (via components) but does not declare it`);
      }
    }

    return missing;
  }

  // ─── Admin Configuration ──────────────────────────────────────────

  /** Add a publisher to auto-trust list. */
  addTrustedPublisher(publisherName: string): void {
    this.autoTrustedPublishers.add(publisherName);
  }

  /** Remove a publisher from auto-trust list. */
  removeTrustedPublisher(publisherName: string): void {
    this.autoTrustedPublishers.delete(publisherName);
  }

  /** Set admin override for a specific plugin. */
  setAdminOverride(pluginName: string, trusted: boolean): void {
    this.adminOverrides.set(pluginName, trusted);
  }

  /** Clear admin override for a plugin. */
  clearAdminOverride(pluginName: string): void {
    this.adminOverrides.delete(pluginName);
  }

  // ─── Reporting ────────────────────────────────────────────────────

  /**
   * Generate a comprehensive policy report for a set of plugins.
   * Useful for security audits and administrative reviews.
   */
  generatePolicyReport(plugins: LoadedPlugin[]): PolicyReport {
    const riskBreakdown: Record<PluginRiskClass, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const sourceBreakdown: Record<SourceTrustLevel, number> = { managed: 0, semi_trusted: 0, untrusted: 0 };
    const entries: PolicyReportEntry[] = [];
    const allViolations: string[] = [];

    for (const plugin of plugins) {
      const sourceTrust = this.getSourceTrustLevel(plugin);
      const highestRisk = this.getHighestRisk(plugin);
      const { riskClass } = this.classifyPluginRisk(plugin);
      const granted = this.getDefaultGrants(plugin);
      const requested = plugin.manifest.requiredPermissions ?? [];
      const denied = requested.filter(p => !granted.includes(p));
      const warnings = this.validatePermissionDeclarations(plugin);
      const violations = this.getAutoDenyViolations(plugin);

      riskBreakdown[riskClass]++;
      sourceBreakdown[sourceTrust]++;
      allViolations.push(...violations);

      entries.push({
        pluginName: plugin.manifest.name,
        version: plugin.manifest.version,
        sourceTrust,
        highestRisk,
        riskClass,
        grantedPermissions: granted,
        deniedPermissions: denied,
        warnings: [...warnings, ...violations],
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      pluginCount: plugins.length,
      riskBreakdown,
      sourceBreakdown,
      entries,
      autoDenyViolations: allViolations,
    };
  }

  /** Get a summary of the policy for a plugin. */
  summarize(plugin: LoadedPlugin): string {
    const source = this.getSourceTrustLevel(plugin);
    const risk = this.getHighestRisk(plugin);
    const prompt = this.shouldPromptTrust(plugin);
    const block = this.shouldAutoBlock(plugin);
    const grants = this.getDefaultGrants(plugin);

    return [
      `${plugin.manifest.name}@${plugin.manifest.version}`,
      `source: ${source}`,
      `risk: ${risk}`,
      `prompt: ${prompt}`,
      `blocked: ${block}`,
      `grants: [${grants.join(', ')}]`,
    ].join(' | ');
  }
}
