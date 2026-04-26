/**
 * types.ts — Complete Plugin System type vocabulary
 *
 * Based on Claude Code's plugin type definitions
 * Every type used across the 44-file plugin system is defined here.
 *
 * Sections:
 *   1. Plugin Manifest (.clow-plugin/plugin.json)
 *   2. Loaded Plugin (runtime state after loading)
 *   3. Plugin Components (commands, agents, skills, hooks, MCP, tools, styles)
 *   4. Plugin Source (where plugin came from)
 *   5. Plugin Trust & Security
 *   6. Installation types
 *   7. Marketplace types
 *   8. Dependency resolution types
 *   9. Cache types
 *   10. Event types (lifecycle events)
 *   11. Constants
 */

import type { ConfiguredHook } from '../hooks/types.js';

// ════════════════════════════════════════════════════════════════════════════
// 1. Plugin Manifest (.clow-plugin/plugin.json)
// ════════════════════════════════════════════════════════════════════════════

export interface PluginManifest {
  /** Unique identifier (kebab-case, e.g., "my-awesome-plugin") */
  name: string;
  /** Semver version (e.g., "1.2.3", "1.0.0-beta.1") */
  version: string;
  /** Short description (10-500 chars) */
  description: string;
  /** Author information */
  author?: PluginAuthor;
  /** License identifier (e.g., "MIT", "Apache-2.0") */
  license?: string;
  /** Homepage URL */
  homepage?: string;
  /** Repository URL or path */
  repository?: string;

  // ── Components ────────────────────────────────────────────────────
  /** Glob patterns for command markdown files: ["commands/*.md"] */
  commands?: string[];
  /** Glob patterns for agent definition files: ["agents/*.md"] */
  agents?: string[];
  /** Glob patterns for skill directories */
  skills?: string[];
  /** Path to hooks.json file */
  hooks?: string;
  /** MCP server definitions keyed by server name */
  mcpServers?: Record<string, MCPServerDef>;
  /** Glob patterns for output style files */
  outputStyles?: string[];
  /** Glob patterns for custom tool files (opt-in, sandboxed) */
  tools?: string[];

  // ── Dependencies ──────────────────────────────────────────────────
  /** Direct dependencies: { "plugin-name": "^1.0.0" } */
  dependencies?: Record<string, string>;
  /** Peer dependencies (must be installed separately) */
  peerDependencies?: Record<string, string>;
  /** Minimum Clow version required */
  clowVersion?: string;

  // ── Configuration ─────────────────────────────────────────────────
  /** JSON Schema for user-configurable options */
  config?: PluginConfigSchema;
  /** Default values for config options */
  defaultConfig?: Record<string, unknown>;

  // ── Metadata ──────────────────────────────────────────────────────
  /** Tags for search and organization (max 20) */
  tags?: string[];
  /** Primary category */
  category?: PluginCategory;
  /** Additional search keywords (max 20) */
  keywords?: string[];
  /** Path to icon file (PNG, SVG) */
  icon?: string;

  // ── Security ──────────────────────────────────────────────────────
  /** Permissions required by this plugin */
  requiredPermissions?: PluginPermission[];
  /** Minimum tier for multi-tenant deployments */
  minTier?: string;
}

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface MCPServerDef {
  /** Command to start the server */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables (supports ${VAR} expansion) */
  env?: Record<string, string>;
  /** URL for HTTP MCP servers (alternative to command) */
  url?: string;
  /** Human-readable description */
  description?: string;
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export type PluginCategory =
  | 'productivity'
  | 'development'
  | 'data-science'
  | 'devops'
  | 'integration'
  | 'communication'
  | 'utility'
  | 'workflow'
  | 'language'
  | 'framework';

export type PluginPermission =
  | 'filesystem-read'
  | 'filesystem-write'
  | 'network'
  | 'shell-execution'
  | 'spawn-subagent'
  | 'modify-permissions'
  | 'register-hooks'
  | 'register-tools'
  | 'access-secrets';

// ════════════════════════════════════════════════════════════════════════════
// 2. Loaded Plugin (runtime state)
// ════════════════════════════════════════════════════════════════════════════

export interface LoadedPlugin {
  /** Validated manifest */
  manifest: PluginManifest;
  /** Absolute path to plugin root directory */
  rootDir: string;
  /** Where the plugin was installed (may differ from rootDir for symlinks) */
  installPath: string;
  /** Where this plugin came from */
  source: PluginSource;
  /** When the plugin was installed (ms since epoch) */
  installedAt: number;
  /** Whether the plugin is currently active */
  enabled: boolean;

  // ── Loaded Components ─────────────────────────────────────────────
  loadedCommands: PluginCommand[];
  loadedAgents: PluginAgentDef[];
  loadedSkills: string[];
  loadedHooks: ConfiguredHook[];
  loadedMcpServers: string[];
  loadedTools: string[];
  loadedOutputStyles: string[];

  // ── Runtime State ─────────────────────────────────────────────────
  /** User-provided configuration overrides */
  config?: Record<string, unknown>;
  /** Trust state for security */
  trustState: PluginTrustState;

  // ── Validation Results ────────────────────────────────────────────
  /** Errors found during validation (may include non-critical errors) */
  validationErrors: PluginValidationError[];
  /** Warnings found during validation */
  validationWarnings: PluginValidationError[];
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Plugin Components
// ════════════════════════════════════════════════════════════════════════════

export interface PluginCommand {
  /** Command name (derived from filename, kebab-case) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Absolute path to the command's markdown file */
  filePath: string;
  /** Name of the plugin this command belongs to */
  pluginName: string;
  /** Parsed YAML frontmatter */
  frontmatter: PluginCommandFrontmatter;
  /** Markdown body (the actual prompt/instructions) */
  body: string;
}

export interface PluginCommandFrontmatter {
  description: string;
  /** Tools this command is allowed to use */
  allowedTools?: string[];
  /** Override model for this command */
  model?: string;
  /** Alternative names for the command */
  aliases?: string[];
  /** Structured argument definitions */
  arguments?: PluginCommandArgument[];
  /** Category for grouping in /help */
  category?: string;
  /** If true, command is hidden from /help listing */
  hidden?: boolean;
  /** If true, requires user confirmation before executing */
  requiresConfirmation?: boolean;
  /** Execution timeout in ms */
  timeoutMs?: number;
}

export interface PluginCommandArgument {
  name: string;
  type: string;  // 'string', 'number', 'boolean', 'file'
  description?: string;
  required?: boolean;
  default?: unknown;
  choices?: string[];  // for enum-like args
}

export interface PluginAgentDef {
  /** Agent name (derived from filename) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Absolute path to the agent's markdown file */
  filePath: string;
  /** Name of the plugin this agent belongs to */
  pluginName: string;
  /** System prompt for the agent (the markdown body) */
  systemPrompt: string;
  /** Tools this agent is allowed to use */
  allowedTools?: string[];
  /** Override model for this agent */
  model?: string;
  /** Category for grouping */
  category?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Plugin Source
// ════════════════════════════════════════════════════════════════════════════

export type PluginSource =
  | { type: 'builtin' }
  | { type: 'user'; path: string }
  | { type: 'project'; path: string }
  | { type: 'marketplace'; marketplaceId: string; pluginId: string }
  | { type: 'git'; url: string; ref?: string }
  | { type: 'local'; path: string }
  | { type: 'zip'; url: string };

/** Priority order for source merging (higher = wins on conflict) */
export const SOURCE_PRIORITY: Record<string, number> = {
  project: 4,
  user: 3,
  marketplace: 2,
  builtin: 1,
  git: 2,
  local: 3,
  zip: 2,
};

// ════════════════════════════════════════════════════════════════════════════
// 5. Plugin Trust & Security
// ════════════════════════════════════════════════════════════════════════════

export type PluginTrustState =
  | 'trusted'        // Explicitly trusted by user or managed
  | 'untrusted'      // Not yet reviewed
  | 'pending_review'  // Awaiting user decision
  | 'blocked';       // Blocked by remote blocklist

export interface PluginTrustRecord {
  pluginName: string;
  trusted: boolean;
  trustedAt?: number;
  trustedBy?: string;
  version?: string;
  contentHash?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Validation
// ════════════════════════════════════════════════════════════════════════════

export interface PluginValidationError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable message */
  message: string;
  /** Severity level */
  severity: 'error' | 'warning';
  /** Which manifest field caused the error */
  field?: string;
  /** Which file caused the error */
  filePath?: string;
  /** Can the plugin still load despite this error? */
  recoverable: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Installation
// ════════════════════════════════════════════════════════════════════════════

export interface InstallationRequest {
  /** Where to install from */
  source: PluginSource;
  /** Override default target directory */
  targetDir?: string;
  /** Overwrite if plugin already exists */
  force?: boolean;
  /** Skip dependency resolution */
  skipDependencies?: boolean;
  /** Skip validation (dangerous) */
  skipValidation?: boolean;
  /** User-provided config to apply after install */
  config?: Record<string, unknown>;
}

export interface InstallationResult {
  success: boolean;
  pluginName?: string;
  installedTo?: string;
  /** Plugins that were installed as dependencies */
  installedDependencies?: string[];
  durationMs: number;
  errors: PluginValidationError[];
  warnings: PluginValidationError[];
  /** Optional metadata (commit hash, content hash, etc.) */
  metadata?: Record<string, unknown>;
}

export interface InstallationProgress {
  phase: InstallationPhase;
  pluginName?: string;
  message: string;
  progress?: number;  // 0-1
  bytesDownloaded?: number;
  totalBytes?: number;
}

export type InstallationPhase =
  | 'resolving'
  | 'resolving-dependencies'
  | 'downloading'
  | 'extracting'
  | 'validating'
  | 'installing-dependencies'
  | 'loading-components'
  | 'registering'
  | 'complete'
  | 'failed';

// ════════════════════════════════════════════════════════════════════════════
// 8. Marketplace
// ════════════════════════════════════════════════════════════════════════════

export interface MarketplaceCatalog {
  marketplaceId: string;
  name: string;
  url: string;
  lastFetchedAt: number;
  plugins: MarketplaceCatalogEntry[];
}

export interface MarketplaceCatalogEntry {
  /** Unique identifier in marketplace */
  pluginId: string;
  /** Plugin name (matches manifest.name) */
  name: string;
  /** Plugin version */
  version: string;
  /** Short description */
  description: string;
  /** Author info */
  author: PluginAuthor;
  /** Category */
  category: PluginCategory;
  /** Tags */
  tags: string[];
  /** URL to download the plugin zip */
  downloadUrl: string;
  /** URL to manifest JSON (for pre-install inspection) */
  manifestUrl?: string;
  /** URL to icon */
  iconUrl?: string;
  /** Number of installs */
  installCount?: number;
  /** Average rating (1-5) */
  rating?: number;
  /** Is this plugin blocked by maintainers? */
  blocked?: boolean;
  /** Is this plugin flagged for review? */
  flagged?: boolean;
  /** When first published */
  publishedAt: number;
  /** Last update time */
  updatedAt: number;
  /** Embedded manifest (optional, for offline resolution) */
  manifest?: PluginManifest;
}

export interface MarketplaceSearchOptions {
  query?: string;
  category?: PluginCategory;
  tags?: string[];
  minRating?: number;
  sortBy?: 'popular' | 'recent' | 'name' | 'rating';
  limit?: number;
  offset?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 9. Dependency Resolution
// ════════════════════════════════════════════════════════════════════════════

export interface DependencyResolutionResult {
  success: boolean;
  /** Plugins that need to be installed, in install order */
  toInstall: ResolvedDependency[];
  /** Conflicts that prevent resolution */
  conflicts: DependencyConflict[];
}

export interface ResolvedDependency {
  pluginName: string;
  version: string;
  downloadUrl: string;
  /** Depth in dependency tree (0 = direct, 1 = dep of dep, etc) */
  depth: number;
}

export interface DependencyConflict {
  type: 'not_found' | 'version_mismatch' | 'cycle';
  pluginName: string;
  constraint: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 10. Plugin Lifecycle Events
// ════════════════════════════════════════════════════════════════════════════

export type PluginLifecycleEvent =
  | 'discovered'
  | 'validated'
  | 'loaded'
  | 'enabled'
  | 'disabled'
  | 'uninstalled'
  | 'updated'
  | 'error';

export interface PluginLifecycleRecord {
  pluginName: string;
  event: PluginLifecycleEvent;
  timestamp: number;
  details?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 11. Constants
// ════════════════════════════════════════════════════════════════════════════

/** Directory inside plugin root that contains the manifest */
export const PLUGIN_MANIFEST_DIR = '.clow-plugin';
/** Manifest filename */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
/** Max length for plugin name */
export const MAX_PLUGIN_NAME_LENGTH = 100;
/** Max depth for dependency resolution */
export const MAX_DEPENDENCY_DEPTH = 10;
/** Cache TTL for downloaded zips */
export const ZIP_CACHE_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days
/** Cache TTL for marketplace catalog */
export const MARKETPLACE_CACHE_TTL_MS = 4 * 60 * 60_000; // 4 hours
/** Max number of plugins per source */
export const MAX_PLUGINS_PER_SOURCE = 200;
/** Max total plugins loaded */
export const MAX_TOTAL_PLUGINS = 500;
/** Max manifest file size (1MB) */
export const MAX_MANIFEST_FILE_SIZE = 1024 * 1024;
/** Max environment variables per MCP server */
export const MAX_ENV_VARS = 50;
/** Max args per MCP server */
export const MAX_MCP_ARGS = 50;
/** Default marketplace ID */
export const DEFAULT_MARKETPLACE_ID = 'official';

// ════════════════════════════════════════════════════════════════════════════
// 12. Plugin Loading Progress
// ════════════════════════════════════════════════════════════════════════════

export type LoadingPhase =
  | 'reading_manifest'
  | 'validating_manifest'
  | 'loading_commands'
  | 'loading_agents'
  | 'loading_skills'
  | 'loading_hooks'
  | 'loading_mcp_servers'
  | 'loading_tools'
  | 'loading_output_styles'
  | 'applying_config'
  | 'complete'
  | 'error';

export interface LoadingProgress {
  pluginName: string;
  phase: LoadingPhase;
  message: string;
  progress: number; // 0-100
  timestamp: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 13. Plugin System Events
// ════════════════════════════════════════════════════════════════════════════

export type PluginSystemEvent =
  | { type: 'plugin_discovered'; pluginName: string; source: string }
  | { type: 'plugin_loaded'; pluginName: string; componentCount: number }
  | { type: 'plugin_enabled'; pluginName: string }
  | { type: 'plugin_disabled'; pluginName: string }
  | { type: 'plugin_uninstalled'; pluginName: string }
  | { type: 'plugin_updated'; pluginName: string; oldVersion: string; newVersion: string }
  | { type: 'plugin_error'; pluginName: string; error: string }
  | { type: 'plugin_blocked'; pluginName: string; reason: string }
  | { type: 'marketplace_check_complete'; updatesAvailable: number; newlyBlocked: number }
  | { type: 'install_started'; source: string }
  | { type: 'install_completed'; pluginName: string; durationMs: number }
  | { type: 'install_failed'; error: string };

export type PluginSystemEventHandler = (event: PluginSystemEvent) => void;

// ════════════════════════════════════════════════════════════════════════════
// 14. Plugin Statistics
// ════════════════════════════════════════════════════════════════════════════

export interface PluginSystemStats {
  /** Total plugins registered */
  totalPlugins: number;
  /** Enabled plugins */
  enabledPlugins: number;
  /** Plugins with errors */
  pluginsWithErrors: number;
  /** Total commands across all plugins */
  totalCommands: number;
  /** Total agents */
  totalAgents: number;
  /** Total hooks */
  totalHooks: number;
  /** Total MCP servers */
  totalMcpServers: number;
  /** Total skills */
  totalSkills: number;
  /** Total tools */
  totalTools: number;
  /** Total output styles */
  totalOutputStyles: number;
  /** Plugins by source */
  bySource: Record<string, number>;
  /** Plugins by category */
  byCategory: Record<string, number>;
  /** Total validation errors */
  totalValidationErrors: number;
  /** Total validation warnings */
  totalValidationWarnings: number;
  /** System initialization time */
  initDurationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 15. Marketplace Error Types
// ════════════════════════════════════════════════════════════════════════════

export type MarketplaceErrorType =
  | 'network'
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'invalid_response'
  | 'too_large'
  | 'timeout'
  | 'blocked'
  | 'unknown';

export interface MarketplaceError {
  type: MarketplaceErrorType;
  message: string;
  statusCode?: number;
  retryable: boolean;
  timestamp: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 16. Plugin Health Check
// ════════════════════════════════════════════════════════════════════════════

export interface PluginHealthStatus {
  pluginName: string;
  healthy: boolean;
  checks: PluginHealthCheck[];
  lastCheckedAt: number;
}

export interface PluginHealthCheck {
  name: string;
  passed: boolean;
  message?: string;
  durationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 17. Plugin Output Style
// ════════════════════════════════════════════════════════════════════════════

export interface PluginOutputStyle {
  name: string;
  description: string;
  format: string;
  body: string;
  pluginName: string;
  priority: number;
  language?: string;
  hidden: boolean;
}
