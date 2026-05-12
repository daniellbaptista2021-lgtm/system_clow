/**
 * builtInSkills.ts — Built-in skills bundled with System Clow
 *
 * Based on Claude Code's built-in skills (~200 lines)
 *
 * These skills are always available, regardless of plugins or user config.
 * They provide baseline capabilities for common coding tasks.
 *
 * Built-in skills:
 *   1. systematic-debugging — Structured bug investigation
 *   2. commit-conventions — Conventional commit messages
 *   3. test-driven — TDD workflow
 *   4. code-review — Code review best practices
 *   5. refactoring — Safe refactoring patterns
 *   6. documentation — Documentation writing
 *   7. error-handling — Proper error handling patterns
 */

import type { ParsedSkill, SkillTrigger, SkillCategory } from './types.js';

// ─── Builtin Definitions ────────────────────────────────────────────────────

interface BuiltinDef {
  name: string;
  description: string;
  category: SkillCategory;
  triggers: SkillTrigger[];
  body: string;
  tags?: string[];
  uses_tools?: string[];
}

const BUILTINS: BuiltinDef[] = [
  {
    name: 'systematic-debugging',
    description: 'Apply systematic debugging when investigating bugs',
    category: 'coding',
    tags: ['debug', 'bug', 'fix'],
    triggers: [{
      type: 'keyword',
      patterns: ['debug', 'bug', 'fix error', 'not working', 'broken', 'crash', 'fails', 'exception'],
    }],
    body: `When debugging an issue, follow this systematic approach:

1. **Reproduce**: Confirm the bug exists and is reproducible
2. **Isolate**: Narrow down to the smallest reproduction case
3. **Hypothesize**: Form a theory about the root cause based on evidence
4. **Test**: Verify your hypothesis with targeted debugging
5. **Fix**: Make the minimal change to fix the root cause
6. **Verify**: Confirm the fix works and doesn't cause regressions

Rules:
- Never guess — always have evidence before making changes
- Read error messages carefully — they usually tell you exactly what's wrong
- Check recent changes first (git diff/log)
- Use the debugger, don't just add print statements
- Fix the root cause, not the symptom`,
  },

  {
    name: 'commit-conventions',
    description: 'Follow conventional commits for git messages',
    category: 'coding',
    tags: ['git', 'commit', 'versioning'],
    triggers: [{
      type: 'keyword',
      patterns: ['commit', 'git commit', 'commit message'],
    }],
    body: `Follow Conventional Commits format:

\`<type>(<scope>): <description>\`

Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

Rules:
- Use imperative mood ("add" not "added")
- Lowercase first letter
- No period at the end
- Max 72 characters for subject line
- Body explains "why" not "what"
- Reference issues: "Closes #123"`,
  },

  {
    name: 'test-driven',
    description: 'Write tests before or alongside implementation',
    category: 'coding',
    tags: ['test', 'tdd', 'testing'],
    triggers: [{
      type: 'keyword',
      patterns: ['test', 'tdd', 'unit test', 'testing', 'test coverage'],
    }],
    body: `Red-Green-Refactor cycle:

1. **Red**: Write a failing test that describes the desired behavior
2. **Green**: Write the minimum code to make the test pass
3. **Refactor**: Clean up while keeping tests green

Test naming: \`should <expected behavior> when <condition>\`

Guidelines:
- Test behavior, not implementation
- One assertion per test (when possible)
- Use descriptive test names
- Arrange-Act-Assert pattern
- Mock external dependencies, not internal logic`,
  },

  {
    name: 'code-review',
    description: 'Systematic code review checklist',
    category: 'coding',
    tags: ['review', 'quality'],
    triggers: [{
      type: 'keyword',
      patterns: ['review', 'code review', 'PR review', 'pull request'],
    }],
    body: `Code review checklist:

1. **Correctness**: Does the code do what it's supposed to?
2. **Security**: Any injection, auth bypass, data exposure?
3. **Performance**: N+1 queries, unnecessary loops, missing indexes?
4. **Readability**: Clear names, appropriate comments, consistent style?
5. **Error handling**: All error paths covered? Graceful degradation?
6. **Testing**: Tests for happy path AND edge cases?
7. **Architecture**: Follows existing patterns? Appropriate abstractions?`,
  },

  {
    name: 'refactoring',
    description: 'Safe refactoring patterns and techniques',
    category: 'coding',
    tags: ['refactor', 'clean-code'],
    triggers: [{
      type: 'keyword',
      patterns: ['refactor', 'refactoring', 'clean up', 'restructure', 'reorganize'],
    }],
    body: `Safe refactoring approach:

1. **Tests first**: Ensure existing tests pass before refactoring
2. **Small steps**: One refactoring at a time, commit between steps
3. **Preserve behavior**: The code should do exactly the same thing
4. **Common patterns**:
   - Extract Method: long function → smaller named functions
   - Extract Variable: complex expression → named variable
   - Inline: unnecessary indirection → direct code
   - Rename: unclear name → descriptive name
   - Move: misplaced code → appropriate module
5. **Verify**: Run tests after each step`,
  },

  {
    name: 'error-handling',
    description: 'Proper error handling patterns',
    category: 'coding',
    tags: ['error', 'exception', 'handling'],
    triggers: [{
      type: 'keyword',
      patterns: ['error handling', 'exception', 'try catch', 'error recovery'],
    }],
    body: `Error handling principles:

1. **Fail fast**: Detect errors early, don't let them propagate silently
2. **Be specific**: Catch specific errors, not generic catch-all
3. **Provide context**: Error messages should tell you what, where, and why
4. **Recover gracefully**: Clean up resources, rollback partial changes
5. **Log appropriately**: Error for unexpected, warn for recoverable, info for context
6. **Don't swallow**: Empty catch blocks hide bugs — at minimum, log the error
7. **User-facing**: Show helpful messages, hide implementation details`,
  },

  {
    name: 'documentation',
    description: 'Write clear and useful documentation',
    category: 'writing',
    tags: ['docs', 'documentation', 'readme'],
    triggers: [{
      type: 'keyword',
      patterns: ['document', 'documentation', 'readme', 'jsdoc', 'comment'],
    }],
    body: `Documentation guidelines:

1. **Why, not what**: Code shows "what", comments explain "why"
2. **Keep it current**: Outdated docs are worse than no docs
3. **Examples**: Include usage examples — they're worth more than descriptions
4. **Structure**: README → Getting Started → API Reference → Contributing
5. **JSDoc**: Document public APIs with @param, @returns, @throws, @example
6. **Avoid obvious**: Don't document self-explanatory code`,
  },
];

// ════════════════════════════════════════════════════════════════════════════
// Export
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all built-in skills as ParsedSkill objects.
 */
export function getBuiltinSkills(): ParsedSkill[] {
  return BUILTINS.map(def => ({
    frontmatter: {
      name: def.name,
      description: def.description,
      category: def.category,
      triggers: def.triggers,
      tags: def.tags,
      uses_tools: def.uses_tools,
      source: 'builtin' as const,
    },
    body: def.body,
    bodyTokens: Math.ceil(def.body.length / 4),
    filePath: `<builtin>/${def.name}/SKILL.md`,
    directory: `<builtin>/${def.name}`,
    references: [],
  }));
}

/**
 * Get names of all built-in skills.
 */
export function getBuiltinSkillNames(): string[] {
  return BUILTINS.map(d => d.name);
}

/**
 * Check if a skill name is a built-in.
 */
export function isBuiltinSkill(name: string): boolean {
  return BUILTINS.some(d => d.name === name);
}
