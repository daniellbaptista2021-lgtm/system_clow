/**
 * types.ts — Skills system vocabulary
 *
 * Based on Claude Code's skill types (~200 lines)
 *
 * Complete type definitions for:
 *   - Skill categories and trigger types
 *   - Skill frontmatter (YAML)
 *   - Parsed skill structure
 *   - Skill references
 *   - Match results
 *   - Injection results
 *   - Context for matching
 *   - Constants
 */

// ════════════════════════════════════════════════════════════════════════════
// Skill Categories
// ════════════════════════════════════════════════════════════════════════════

export type SkillCategory =
  | 'writing'
  | 'coding'
  | 'data'
  | 'design'
  | 'research'
  | 'automation'
  | 'reference'
  | 'workflow'
  | 'integration'
  | 'utility';

// ════════════════════════════════════════════════════════════════════════════
// Trigger Types (8 types)
// ════════════════════════════════════════════════════════════════════════════

export type SkillTriggerType =
  | 'keyword'         // Match keywords in user message
  | 'regex'           // Match regex pattern in user message
  | 'glob'            // Match file path patterns
  | 'tool_use'        // Match specific tool usage
  | 'hook_event'      // Match hook events
  | 'context_match'   // Semantic/fuzzy context matching
  | 'always'          // Always active
  | 'first_message';  // Only on first message

/**
 * A single trigger definition.
 */
export interface SkillTrigger {
  /** Trigger type */
  type: SkillTriggerType;
  /** Patterns for keyword/regex/glob triggers */
  patterns?: string[];
  /** Context string for context_match triggers */
  context?: string;
  /** Tool names for tool_use triggers */
  tools?: string[];
  /** Event names for hook_event triggers */
  events?: string[];
  /** Weight multiplier for scoring (default 1.0) */
  weight?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Skill Frontmatter (parsed from YAML)
// ════════════════════════════════════════════════════════════════════════════

export interface SkillFrontmatter {
  /** Unique skill name (kebab-case) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Skill version (semver) */
  version?: string;
  /** Author name */
  author?: string;
  /** Trigger definitions */
  triggers?: SkillTrigger[];
  /** If true, skill is always injected regardless of triggers */
  always_active?: boolean;
  /** Tags for discovery and filtering */
  tags?: string[];
  /** Skill category */
  category?: SkillCategory;
  /** Tools this skill uses or references */
  uses_tools?: string[];
  /** Reference file paths (relative to skill directory) */
  references?: string[];
  /** Primary language (e.g., 'pt-BR', 'en') */
  language?: string;
  /** Minimum tenant tier required */
  min_tier?: string;
  /** Where this skill was loaded from */
  source?: 'builtin' | 'user' | 'project' | 'plugin';
}

// ════════════════════════════════════════════════════════════════════════════
// Parsed Skill (runtime representation)
// ════════════════════════════════════════════════════════════════════════════

export interface ParsedSkill {
  /** Validated frontmatter */
  frontmatter: SkillFrontmatter;
  /** Skill body content (the actual instructions/prompt) */
  body: string;
  /** Estimated token count for the body */
  bodyTokens: number;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Absolute path to the skill directory */
  directory: string;
  /** Reference files found in the skill directory */
  references: SkillReference[];
}

// ════════════════════════════════════════════════════════════════════════════
// Skill References
// ════════════════════════════════════════════════════════════════════════════

export interface SkillReference {
  /** Reference file name */
  name: string;
  /** Absolute path to the reference file */
  path: string;
  /** Whether the content has been loaded */
  loaded: boolean;
  /** File content (loaded on demand) */
  content?: string;
  /** Estimated token count */
  tokens?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Match Results
// ════════════════════════════════════════════════════════════════════════════

export interface SkillMatchResult {
  /** The matched skill */
  skill: ParsedSkill;
  /** Match score (0.0 - 1.0) */
  score: number;
  /** Which triggers matched */
  matchedTriggers: SkillTrigger[];
  /** Specific terms/patterns that matched */
  matchedTerms: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// Skill Context (input for matching)
// ════════════════════════════════════════════════════════════════════════════

export interface SkillContext {
  /** User's message text */
  userMessage?: string;
  /** Tool being used */
  toolName?: string;
  /** Tool input data */
  toolInput?: unknown;
  /** Current file path being operated on */
  filePath?: string;
  /** Hook event name */
  hookEvent?: string;
  /** Whether this is the first message in the session */
  isFirstMessage?: boolean;
  /** Session ID */
  sessionId: string;
  /** Current working directory */
  cwd: string;
  /** Workspace root */
  workspaceRoot: string;
  /** Detected language */
  language?: string;
  /** Tenant tier */
  tier?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Injection Results
// ════════════════════════════════════════════════════════════════════════════

export interface SkillInjectionResult {
  /** Skills that were injected */
  injectedSkills: ParsedSkill[];
  /** Formatted text to add to system message */
  systemMessageAddition: string;
  /** Total estimated token cost of injection */
  estimatedTokens: number;
  /** All references from injected skills */
  references: SkillReference[];
}

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

/** Expected filename for skill definitions */
export const SKILL_FILE_NAME = 'SKILL.md';

/** Maximum body size for a single skill (in estimated tokens) */
export const MAX_SKILL_BODY_TOKENS = 5_000;

/** Maximum number of skills injected per turn */
export const MAX_SKILLS_PER_TURN = 5;

/** Maximum total injection token budget */
export const MAX_TOTAL_INJECTION_TOKENS = 25_000;

/** Maximum reference file size (bytes) */
export const MAX_REFERENCE_FILE_SIZE = 100_000;

/** Maximum number of references per skill */
export const MAX_REFERENCES_PER_SKILL = 10;

/** Minimum match score to consider a skill matched */
export const MIN_MATCH_SCORE = 0.1;
