/**
 * TeamWorktree.ts — Git worktree management for team members
 *
 * Each team member can work in their own git worktree to avoid
 * conflicts on the same branch. Uses `git worktree` commands.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const WORKTREE_DIR = '.clow-worktrees';

// ════════════════════════════════════════════════════════════════════════════
// Create
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a new git worktree for a branch.
 *
 * The worktree is placed at <workspaceRoot>/.clow-worktrees/<branchName>.
 * If the branch does not exist, it is created from HEAD.
 *
 * @param workspaceRoot - The root of the git repository
 * @param branchName - The branch name for the worktree
 * @returns The absolute path to the new worktree
 */
export function createWorktree(
  workspaceRoot: string,
  branchName: string
): string {
  // Validate we're in a git repo
  assertGitRepo(workspaceRoot);

  // Sanitize branch name for filesystem use
  const safeBranch = branchName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const worktreeDir = path.join(workspaceRoot, WORKTREE_DIR);
  const worktreePath = path.join(worktreeDir, safeBranch);

  // If worktree already exists, return it
  if (fs.existsSync(worktreePath)) {
    return worktreePath;
  }

  // Ensure parent directory exists
  fs.mkdirSync(worktreeDir, { recursive: true });

  // Check if branch already exists
  const branchExists = doesBranchExist(workspaceRoot, branchName);

  try {
    if (branchExists) {
      // Attach to existing branch
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: workspaceRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else {
      // Create new branch from HEAD
      execSync(
        `git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
        {
          cwd: workspaceRoot,
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create worktree for branch "${branchName}": ${message}`
    );
  }

  return worktreePath;
}

// ════════════════════════════════════════════════════════════════════════════
// Remove
// ════════════════════════════════════════════════════════════════════════════

/**
 * Remove a git worktree.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @returns true if the worktree was removed, false if it didn't exist
 */
export function removeWorktree(worktreePath: string): boolean {
  if (!fs.existsSync(worktreePath)) {
    return false;
  }

  // Find the main repo root by traversing up or using git
  try {
    // First try to remove cleanly
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    // If git command fails, try to clean up manually
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });

      // Also prune worktree references
      const parentDir = path.dirname(worktreePath);
      if (fs.existsSync(parentDir)) {
        try {
          execSync('git worktree prune', {
            cwd: parentDir,
            stdio: 'pipe',
            encoding: 'utf-8',
          });
        } catch {
          // Prune failure is non-critical
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// List
// ════════════════════════════════════════════════════════════════════════════

/**
 * List all worktrees for a git repository.
 *
 * @param workspaceRoot - The root of the git repository
 * @returns Array of worktree absolute paths
 */
export function listWorktrees(workspaceRoot: string): string[] {
  assertGitRepo(workspaceRoot);

  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: workspaceRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    const paths: string[] = [];
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        paths.push(line.slice('worktree '.length).trim());
      }
    }
    return paths;
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a directory is inside a git worktree (not the main repo).
 *
 * A worktree has a .git file (not directory) pointing to the main repo.
 *
 * @param dir - Directory to check
 * @returns true if the directory is inside a worktree
 */
export function isInsideWorktree(dir: string): boolean {
  try {
    const gitPath = path.join(dir, '.git');

    // In a worktree, .git is a file, not a directory
    if (fs.existsSync(gitPath)) {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        return content.startsWith('gitdir:');
      }
    }

    // Check parent directories
    const parent = path.dirname(dir);
    if (parent !== dir) {
      return isInsideWorktree(parent);
    }

    return false;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Assert that a directory is a git repository.
 */
function assertGitRepo(dir: string): void {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: dir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch {
    throw new Error(`"${dir}" is not a git repository`);
  }
}

/**
 * Check if a branch exists in the repository.
 */
function doesBranchExist(workspaceRoot: string, branchName: string): boolean {
  try {
    execSync(`git rev-parse --verify "${branchName}"`, {
      cwd: workspaceRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}
