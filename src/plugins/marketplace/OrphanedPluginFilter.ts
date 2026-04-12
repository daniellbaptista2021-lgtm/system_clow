/**
 * OrphanedPluginFilter.ts — Detect plugins with deleted sources
 *
 * Based on Claude Code's orphanedPluginFilter.ts (200 lines)
 *
 * Detects:
 *   - Local source path no longer exists
 *   - Git source repo deleted from disk
 *   - Marketplace plugin delisted (source entry removed from catalog)
 *   - Install path missing (files deleted but registry entry remains)
 *   - Manifest file deleted (plugin dir exists but manifest gone)
 *   - Corrupt install (essential files missing)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LoadedPlugin, MarketplaceCatalog } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OrphanedPlugin {
  plugin: LoadedPlugin;
  reason: OrphanReason;
  details: string;
  detectedAt: number;
}

export type OrphanReason =
  | 'source_missing'      // source path/repo deleted
  | 'install_missing'     // installPath doesn't exist
  | 'manifest_missing'    // plugin dir exists but manifest deleted
  | 'delisted'           // removed from marketplace catalog
  | 'corrupt';           // essential files missing

// ════════════════════════════════════════════════════════════════════════════
// OrphanedPluginFilter Class
// ════════════════════════════════════════════════════════════════════════════

export class OrphanedPluginFilter {

  /**
   * Detect orphaned plugins from the registry.
   * Returns simple list of orphaned LoadedPlugins.
   */
  detectOrphans(plugins: LoadedPlugin[]): LoadedPlugin[] {
    return this.detectDetailed(plugins).map(o => o.plugin);
  }

  /**
   * Detect orphaned plugins with detailed reasons.
   */
  detectDetailed(plugins: LoadedPlugin[]): OrphanedPlugin[] {
    const orphans: OrphanedPlugin[] = [];

    for (const plugin of plugins) {
      // Skip builtin (always present)
      if (plugin.source.type === 'builtin') continue;

      // Check 1: Install path exists
      if (!fs.existsSync(plugin.installPath)) {
        orphans.push({
          plugin,
          reason: 'install_missing',
          details: `Install directory missing: ${plugin.installPath}`,
          detectedAt: Date.now(),
        });
        continue;
      }

      // Check 2: Manifest file exists
      const manifestPath = path.join(plugin.installPath, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) {
        orphans.push({
          plugin,
          reason: 'manifest_missing',
          details: `Manifest missing: ${manifestPath}`,
          detectedAt: Date.now(),
        });
        continue;
      }

      // Check 3: Source-specific checks
      switch (plugin.source.type) {
        case 'local': {
          const sourcePath = (plugin.source as any).path;
          if (sourcePath && !fs.existsSync(sourcePath)) {
            orphans.push({
              plugin,
              reason: 'source_missing',
              details: `Local source deleted: ${sourcePath}`,
              detectedAt: Date.now(),
            });
          }
          break;
        }

        case 'git': {
          // Check if .git directory exists (repo intact)
          const gitDir = path.join(plugin.installPath, '.git');
          if (!fs.existsSync(gitDir)) {
            orphans.push({
              plugin,
              reason: 'source_missing',
              details: `Git repo missing .git directory`,
              detectedAt: Date.now(),
            });
          }
          break;
        }

        case 'project': {
          const projectPath = (plugin.source as any).path;
          if (projectPath && !fs.existsSync(projectPath)) {
            orphans.push({
              plugin,
              reason: 'source_missing',
              details: `Project plugin directory deleted: ${projectPath}`,
              detectedAt: Date.now(),
            });
          }
          break;
        }

        case 'user': {
          const userPath = (plugin.source as any).path;
          if (userPath && !fs.existsSync(userPath)) {
            orphans.push({
              plugin,
              reason: 'source_missing',
              details: `User plugin directory deleted: ${userPath}`,
              detectedAt: Date.now(),
            });
          }
          break;
        }
      }
    }

    return orphans;
  }

  /**
   * Check if marketplace plugins are still in the catalog.
   */
  detectDelisted(plugins: LoadedPlugin[], catalog: MarketplaceCatalog): OrphanedPlugin[] {
    const catalogNames = new Set(catalog.plugins.map(p => p.name));
    const orphans: OrphanedPlugin[] = [];

    for (const plugin of plugins) {
      if (plugin.source.type !== 'marketplace') continue;

      if (!catalogNames.has(plugin.manifest.name)) {
        orphans.push({
          plugin,
          reason: 'delisted',
          details: `Plugin "${plugin.manifest.name}" no longer in marketplace catalog`,
          detectedAt: Date.now(),
        });
      }
    }

    return orphans;
  }

  /**
   * Check for corrupt installs (essential files missing).
   */
  detectCorrupt(plugins: LoadedPlugin[]): OrphanedPlugin[] {
    const corrupt: OrphanedPlugin[] = [];

    for (const plugin of plugins) {
      if (plugin.source.type === 'builtin') continue;
      if (!fs.existsSync(plugin.installPath)) continue;

      // Check manifest is valid JSON
      const manifestPath = path.join(plugin.installPath, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
      if (fs.existsSync(manifestPath)) {
        try {
          JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
          corrupt.push({
            plugin,
            reason: 'corrupt',
            details: 'Manifest is not valid JSON',
            detectedAt: Date.now(),
          });
        }
      }
    }

    return corrupt;
  }

  /**
   * Run all detection checks and return combined results.
   */
  detectAll(plugins: LoadedPlugin[], catalog?: MarketplaceCatalog): OrphanedPlugin[] {
    const results: OrphanedPlugin[] = [];

    results.push(...this.detectDetailed(plugins));

    if (catalog) {
      results.push(...this.detectDelisted(plugins, catalog));
    }

    results.push(...this.detectCorrupt(plugins));

    // Deduplicate (same plugin may appear in multiple checks)
    const seen = new Set<string>();
    return results.filter(o => {
      const key = `${o.plugin.manifest.name}:${o.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Format orphan report for display.
   */
  formatReport(orphans: OrphanedPlugin[]): string {
    if (orphans.length === 0) return 'No orphaned plugins detected.';

    const lines = [`${orphans.length} orphaned plugin(s) detected:\n`];
    for (const o of orphans) {
      lines.push(`  ⚠ ${o.plugin.manifest.name}@${o.plugin.manifest.version}`);
      lines.push(`    Reason: ${o.reason}`);
      lines.push(`    ${o.details}\n`);
    }
    lines.push('Run: clow plugins cleanup --orphans to remove them');
    return lines.join('\n');
  }
}
