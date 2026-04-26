/**
 * LocalInstaller.ts — Install plugin from local filesystem path
 *
 * Based on Claude Code's localPluginInstaller.ts (~250 lines)
 *
 * Supports two modes:
 *   - Copy: copies files to plugin directory (default)
 *   - Symlink: creates symlink for development (with --link flag)
 *
 * Features:
 *   - Manifest validation before install
 *   - Directory copy with exclusions (node_modules, .git)
 *   - Symlink mode for development workflow
 *   - Overwrite protection (unless force=true)
 *   - Post-copy npm install
 *   - Size calculation
 *   - Rollback on failure
 *   - Validation pipeline before install
 *   - Pre-install hooks
 *   - Post-install verification
 *   - Install rollback with cleanup
 *   - Disk space check
 *   - Progress reporting
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { InstallationResult, PluginValidationError } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';
import { copyDir, npmInstall, safeRemoveDir, getDirectorySize, formatBytes } from './InstallationHelpers.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_PLUGIN_SIZE_MB = 200;
const COPY_EXCLUDE = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

/** Minimum free disk space required (in bytes) before an install is attempted. */
const MIN_FREE_DISK_BYTES = 100 * 1024 * 1024; // 100 MB

// ─── Types ──────────────────────────────────────────────────────────────────

interface LocalInstallOptions {
  targetDir?: string;
  symlink?: boolean;
  force?: boolean;
  skipNpmInstall?: boolean;
  /** If true, skip the post-install verification step. */
  skipVerification?: boolean;
  /** If true, skip the disk-space check. */
  skipDiskCheck?: boolean;
  /** Optional progress callback invoked during key installation stages. */
  onProgress?: (stage: string, detail: string) => void;
}

/** Hook that runs before the copy/symlink step. Return `false` to abort. */
type PreInstallHook = (sourcePath: string, manifest: Record<string, unknown>) => Promise<boolean>;

/** Hook that runs after a successful install. */
type PostInstallHook = (destPath: string, manifest: Record<string, unknown>) => Promise<void>;

// ════════════════════════════════════════════════════════════════════════════
// LocalInstaller Class
// ════════════════════════════════════════════════════════════════════════════

export class LocalInstaller {
  /** Registered pre-install hooks executed in order. */
  private preInstallHooks: PreInstallHook[] = [];
  /** Registered post-install hooks executed in order. */
  private postInstallHooks: PostInstallHook[] = [];

  constructor(private readonly clowHome = path.join(os.homedir(), '.clow')) {}

  // ─── Hook Registration ──────────────────────────────────────────

  /**
   * Register a hook that is invoked **before** the installation copy/symlink
   * step.  If any hook returns `false` the install is aborted.
   */
  addPreInstallHook(hook: PreInstallHook): void {
    this.preInstallHooks.push(hook);
  }

  /**
   * Register a hook that is invoked **after** a successful install.
   */
  addPostInstallHook(hook: PostInstallHook): void {
    this.postInstallHooks.push(hook);
  }

  // ─── Main Install ───────────────────────────────────────────────

  /**
   * Install a plugin from a local filesystem path.
   */
  async install(sourcePath: string, targetDirOrOptions?: string | LocalInstallOptions): Promise<InstallationResult> {
    const start = Date.now();
    const options: LocalInstallOptions = typeof targetDirOrOptions === 'string'
      ? { targetDir: targetDirOrOptions }
      : targetDirOrOptions ?? {};

    const progress = options.onProgress ?? (() => {});
    const resolved = path.resolve(sourcePath);

    // ── Phase 1: Validate source exists ────────────────────────────
    progress('validating', 'Checking source path');
    if (!fs.existsSync(resolved)) {
      return this.failResult(start, 'SOURCE_NOT_FOUND', `Source path does not exist: ${resolved}`);
    }

    // ── Phase 2: Validate manifest exists ──────────────────────────
    const manifestPath = path.join(resolved, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      return this.failResult(start, 'NO_MANIFEST', `No plugin manifest found at ${resolved}`);
    }

    // ── Phase 3: Read & parse manifest ─────────────────────────────
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      return this.failResult(start, 'INVALID_MANIFEST', `Failed to parse manifest: ${(err as Error).message}`);
    }

    // ── Phase 4: Run validation pipeline ───────────────────────────
    progress('validating', 'Running validation pipeline');
    const validationErrors = this.runValidationPipeline(manifest);
    if (validationErrors.length > 0) {
      return {
        success: false,
        durationMs: Date.now() - start,
        errors: validationErrors,
        warnings: [],
      };
    }

    const pluginName = (manifest.name as string) ?? path.basename(resolved);
    const dest = options.targetDir ?? path.join(this.clowHome, 'plugins', pluginName);

    // ── Phase 5: Overwrite check ───────────────────────────────────
    if (fs.existsSync(dest) && !options.force) {
      return this.failResult(start, 'ALREADY_EXISTS', `Plugin directory already exists: ${dest}. Use force=true to overwrite.`);
    }

    // ── Phase 6: Size check ────────────────────────────────────────
    progress('validating', 'Checking plugin size');
    try {
      const sizeBytes = await getDirectorySize(resolved);
      const sizeMB = sizeBytes / (1024 * 1024);
      if (sizeMB > MAX_PLUGIN_SIZE_MB) {
        return this.failResult(start, 'TOO_LARGE', `Plugin is ${formatBytes(sizeBytes)} (max ${MAX_PLUGIN_SIZE_MB}MB)`);
      }
    } catch { /* skip size check on error */ }

    // ── Phase 7: Disk space check ──────────────────────────────────
    if (!options.skipDiskCheck) {
      progress('validating', 'Checking available disk space');
      const hasDiskSpace = await this.checkDiskSpace(dest);
      if (!hasDiskSpace) {
        return this.failResult(
          start,
          'INSUFFICIENT_DISK',
          `Not enough free disk space.  At least ${formatBytes(MIN_FREE_DISK_BYTES)} is required.`,
        );
      }
    }

    // ── Phase 8: Pre-install hooks ─────────────────────────────────
    progress('hooks', 'Running pre-install hooks');
    for (const hook of this.preInstallHooks) {
      try {
        const allowed = await hook(resolved, manifest);
        if (!allowed) {
          return this.failResult(start, 'PRE_HOOK_REJECTED', 'A pre-install hook rejected the installation');
        }
      } catch (err) {
        return this.failResult(start, 'PRE_HOOK_ERROR', `Pre-install hook error: ${(err as Error).message}`);
      }
    }

    // ── Phase 9: Copy / Symlink ────────────────────────────────────
    try {
      if (options.symlink) {
        progress('installing', 'Creating symlink');
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest)) await safeRemoveDir(dest);
        await fsp.symlink(resolved, dest, 'dir');
      } else {
        progress('installing', 'Copying files');
        await fsp.mkdir(dest, { recursive: true });
        await this.copyWithExclusions(resolved, dest);

        // Run npm install in copied directory
        if (!options.skipNpmInstall) {
          progress('installing', 'Running npm install');
          try {
            npmInstall(dest);
          } catch (err) {
            console.warn(`[LocalInstaller] npm install warning: ${(err as Error).message}`);
          }
        }
      }

      // ── Phase 10: Post-install verification ───────────────────────
      if (!options.skipVerification) {
        progress('verifying', 'Running post-install verification');
        const verifyErrors = await this.verifyInstallation(dest);
        if (verifyErrors.length > 0) {
          // Rollback on verification failure
          if (!options.symlink) await safeRemoveDir(dest);
          return {
            success: false,
            pluginName,
            durationMs: Date.now() - start,
            errors: verifyErrors,
            warnings: [],
          };
        }
      }

      // ── Phase 11: Post-install hooks ──────────────────────────────
      progress('hooks', 'Running post-install hooks');
      for (const hook of this.postInstallHooks) {
        try {
          await hook(dest, manifest);
        } catch (err) {
          console.warn(`[LocalInstaller] Post-install hook warning: ${(err as Error).message}`);
        }
      }

      progress('complete', 'Installation complete');
      return {
        success: true,
        pluginName,
        installedTo: dest,
        durationMs: Date.now() - start,
        errors: [],
        warnings: [],
        metadata: { mode: options.symlink ? 'symlink' : 'copy', sourcePath: resolved },
      };
    } catch (err: any) {
      // Rollback
      if (!options.symlink) await safeRemoveDir(dest);
      return this.failResult(start, 'INSTALL_FAILED', err.message);
    }
  }

  // ─── Validation Pipeline ────────────────────────────────────────

  /**
   * Run a series of checks against the parsed manifest and return
   * an array of blocking errors.  An empty array means the manifest
   * passed all checks.
   */
  private runValidationPipeline(manifest: Record<string, unknown>): PluginValidationError[] {
    const errors: PluginValidationError[] = [];

    // Name is required
    if (!manifest.name || typeof manifest.name !== 'string') {
      errors.push({ code: 'MISSING_NAME', message: 'Manifest is missing a "name" field', severity: 'error', recoverable: false });
    }

    // Version is required
    if (!manifest.version || typeof manifest.version !== 'string') {
      errors.push({ code: 'MISSING_VERSION', message: 'Manifest is missing a "version" field', severity: 'error', recoverable: false });
    } else if (!/^\d+\.\d+\.\d+/.test(manifest.version as string)) {
      errors.push({ code: 'INVALID_VERSION', message: 'Manifest version must be valid semver', severity: 'error', recoverable: false });
    }

    // Description is required
    if (!manifest.description || typeof manifest.description !== 'string') {
      errors.push({ code: 'MISSING_DESCRIPTION', message: 'Manifest is missing a "description" field', severity: 'error', recoverable: false });
    }

    return errors;
  }

  // ─── Post-Install Verification ──────────────────────────────────

  /**
   * Verify that the plugin was installed correctly by checking
   * that the manifest exists and can be parsed at the destination.
   */
  private async verifyInstallation(dest: string): Promise<PluginValidationError[]> {
    const errors: PluginValidationError[] = [];

    const destManifest = path.join(dest, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
    if (!fs.existsSync(destManifest)) {
      errors.push({
        code: 'VERIFY_NO_MANIFEST',
        message: 'Manifest not found after installation',
        severity: 'error',
        recoverable: false,
      });
      return errors;
    }

    try {
      const content = await fsp.readFile(destManifest, 'utf-8');
      JSON.parse(content);
    } catch {
      errors.push({
        code: 'VERIFY_PARSE_ERROR',
        message: 'Installed manifest is not valid JSON',
        severity: 'error',
        recoverable: false,
      });
    }

    return errors;
  }

  // ─── Disk Space Check ───────────────────────────────────────────

  /**
   * Check whether there is enough free disk space at the target
   * location.  Uses `os.freemem()` as a rough proxy when
   * platform-specific calls are unavailable.
   */
  private async checkDiskSpace(targetPath: string): Promise<boolean> {
    try {
      // Use statfs when available (Node 18.15+)
      const dir = path.dirname(targetPath);
      await fsp.mkdir(dir, { recursive: true });
      const stats = await fsp.statfs(dir);
      const freeBytes = stats.bavail * stats.bsize;
      return freeBytes >= MIN_FREE_DISK_BYTES;
    } catch {
      // Fallback: assume enough space when we cannot determine it
      return true;
    }
  }

  // ─── Copy with Exclusions ────────────────────────────────────────

  private async copyWithExclusions(src: string, dest: string): Promise<void> {
    const entries = await fsp.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      if (COPY_EXCLUDE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== PLUGIN_MANIFEST_DIR) continue;

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await fsp.mkdir(destPath, { recursive: true });
        await this.copyWithExclusions(srcPath, destPath);
      } else if (entry.isFile()) {
        await fsp.copyFile(srcPath, destPath);
      }
    }
  }

  // ─── Result Helpers ──────────────────────────────────────────────

  private failResult(startTime: number, code: string, message: string): InstallationResult {
    return {
      success: false,
      durationMs: Date.now() - startTime,
      errors: [{ code, message, severity: 'error', recoverable: false }],
      warnings: [],
    };
  }
}
