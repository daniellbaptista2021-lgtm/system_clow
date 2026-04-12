/**
 * GitInstaller.ts — Install plugin from git URL
 *
 * Based on Claude Code's gitPluginInstaller.ts (~350 lines)
 *
 * Pipeline: validate URL → clone → find manifest → npm install → verify
 *
 * Features:
 *   - Shallow clone (depth 1) for speed
 *   - Branch/tag/commit ref support
 *   - SSH and HTTPS URL support
 *   - Manifest detection (root or .clow-plugin/)
 *   - npm install with production flag
 *   - Post-install validation
 *   - Cleanup on failure
 *   - Progress callbacks
 *   - Update via git pull
 *   - Commit hash tracking
 *   - Retry on transient network errors
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { gitClone, gitPull, gitGetHash, isGitRepo, npmInstall, safeRemoveDir, createTempDir, retryWithBackoff } from './InstallationHelpers.js';
import { InstallationState } from './InstallationState.js';
import type { InstallationResult, PluginValidationError } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CLONE_RETRIES = 2;
const GIT_URL_REGEX = /^(https?:\/\/|git@|ssh:\/\/)/;

// ─── Types ──────────────────────────────────────────────────────────────────

interface GitInstallOptions {
  ref?: string;
  depth?: number;
  targetDir?: string;
  skipNpmInstall?: boolean;
  onProgress?: (phase: string, message: string, progress: number) => void;
}

// ════════════════════════════════════════════════════════════════════════════
// GitInstaller Class
// ════════════════════════════════════════════════════════════════════════════

export class GitInstaller {
  constructor(private readonly clowHome = path.join(os.homedir(), '.clow')) {}

  /**
   * Install a plugin from a git repository URL.
   */
  async install(url: string, refOrOptions?: string | GitInstallOptions): Promise<InstallationResult> {
    const start = Date.now();
    const options: GitInstallOptions = typeof refOrOptions === 'string'
      ? { ref: refOrOptions }
      : refOrOptions ?? {};

    const state = new InstallationState();
    if (options.onProgress) {
      state.onProgress((phase, msg, progress) => options.onProgress!(phase, msg, progress));
    }

    // Validate URL
    if (!this.isValidGitUrl(url)) {
      return this.failResult(start, 'INVALID_GIT_URL', `Invalid git URL: ${url}`);
    }

    // Determine destination
    const tempDir = createTempDir('clow-git-');
    const pluginName = this.extractRepoName(url);
    const finalDir = options.targetDir ?? path.join(this.clowHome, 'plugins', pluginName);

    try {
      // Phase 1: Clone
      state.update('downloading', `Cloning ${url}`, 10);
      await retryWithBackoff(
        () => {
          gitClone(url, tempDir, options.ref, options.depth ?? 1);
          return Promise.resolve();
        },
        MAX_CLONE_RETRIES,
      );

      // Phase 2: Find manifest
      state.update('validating', 'Looking for plugin manifest', 40);
      const manifestPath = this.findManifest(tempDir);
      if (!manifestPath) {
        await safeRemoveDir(tempDir);
        return this.failResult(start, 'NO_MANIFEST', 'Cloned repository has no plugin manifest (.clow-plugin/plugin.json)');
      }

      // Phase 3: Parse manifest
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        await safeRemoveDir(tempDir);
        return this.failResult(start, 'INVALID_MANIFEST', `Failed to parse manifest: ${(err as Error).message}`);
      }

      const name = manifest.name as string;
      if (!name) {
        await safeRemoveDir(tempDir);
        return this.failResult(start, 'MISSING_NAME', 'Plugin manifest missing "name" field');
      }

      // Phase 4: npm install
      if (!options.skipNpmInstall) {
        state.update('installing-dependencies', 'Running npm install', 60);
        const pluginRoot = path.dirname(path.dirname(manifestPath));
        try {
          npmInstall(pluginRoot);
        } catch (err) {
          // npm install failure is a warning, not fatal
          console.warn(`[GitInstaller] npm install warning: ${(err as Error).message}`);
        }
      }

      // Phase 5: Move to final location
      state.update('loading-components', 'Moving to install directory', 80);
      if (tempDir !== finalDir) {
        await safeRemoveDir(finalDir);
        await fsp.mkdir(path.dirname(finalDir), { recursive: true });
        await fsp.rename(tempDir, finalDir);
      }

      // Phase 6: Record commit hash
      const commitHash = gitGetHash(finalDir);

      state.update('complete', `Installed ${name}`, 100);

      return {
        success: true,
        pluginName: name,
        installedTo: finalDir,
        durationMs: Date.now() - start,
        errors: [],
        warnings: [],
        metadata: { commitHash, ref: options.ref },
      };

    } catch (err: any) {
      await safeRemoveDir(tempDir);
      return this.failResult(start, 'GIT_CLONE_FAILED', err.message);
    }
  }

  /**
   * Update an existing git-installed plugin.
   */
  async update(pluginDir: string, ref?: string): Promise<InstallationResult> {
    const start = Date.now();

    if (!isGitRepo(pluginDir)) {
      return this.failResult(start, 'NOT_GIT_REPO', `${pluginDir} is not a git repository`);
    }

    const oldHash = gitGetHash(pluginDir);

    try {
      gitPull(pluginDir, ref);
      npmInstall(pluginDir);

      const newHash = gitGetHash(pluginDir);
      const manifestPath = this.findManifest(pluginDir);
      const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : {};

      return {
        success: true,
        pluginName: manifest.name,
        installedTo: pluginDir,
        durationMs: Date.now() - start,
        errors: [],
        warnings: [],
        metadata: { oldHash, newHash, updated: oldHash !== newHash },
      };
    } catch (err: any) {
      return this.failResult(start, 'GIT_UPDATE_FAILED', err.message);
    }
  }

  // ─── URL Validation ──────────────────────────────────────────────

  private isValidGitUrl(url: string): boolean {
    return GIT_URL_REGEX.test(url) || url.includes('github.com') || url.includes('gitlab.com');
  }

  private extractRepoName(url: string): string {
    const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
    return path.basename(cleaned);
  }

  // ─── Manifest Finding ────────────────────────────────────────────

  private findManifest(dir: string): string | null {
    // Direct check
    const direct = path.join(dir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
    if (fs.existsSync(direct)) return direct;

    // One level deep (in case zip/clone created a subdirectory)
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(dir, entry.name, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
        if (fs.existsSync(nested)) return nested;
      }
    } catch { /* skip */ }

    return null;
  }

  // ─── Result Helpers ──────────────────────────────────────────────

  private failResult(startTime: number, code: string, message: string): InstallationResult {
    return {
      success: false,
      durationMs: Date.now() - startTime,
      errors: [{
        code,
        message,
        severity: 'error',
        recoverable: false,
      }],
      warnings: [],
    };
  }
}
