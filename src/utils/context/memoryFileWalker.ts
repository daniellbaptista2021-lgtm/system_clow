/** Walk from cwd upward collecting CLOW.md files. Stops at .git or home. */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { MemoryFileResult } from './types.js';

const MEMORY_NAMES = ['CLOW.md', '.clow/CLOW.md', 'clow.md'];
const MAX_DEPTH = 10;
const MAX_SIZE = 100_000;
const STOP_MARKERS = ['.git', 'node_modules'];

export class MemoryFileWalker {
  async walk(cwd: string, workspaceRoot: string): Promise<MemoryFileResult[]> {
    const results: MemoryFileResult[] = [];

    // 1. User-level (~/.clow/CLOW.md)
    const userFile = path.join(os.homedir(), '.clow', 'CLOW.md');
    const userMem = await this.tryLoad(userFile, 'user');
    if (userMem) results.push(userMem);

    // 2. Walk upward from cwd
    let dir = path.resolve(cwd);
    const visited = new Set<string>();
    let depth = 0;

    while (depth < MAX_DEPTH) {
      if (visited.has(dir)) break;
      visited.add(dir);

      for (const name of MEMORY_NAMES) {
        const fp = path.join(dir, name);
        const r = await this.tryLoad(fp, 'workspace');
        if (r && !results.some(x => x.path === r.path)) results.push(r);
      }

      if (STOP_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) break;
      if (dir === path.resolve(workspaceRoot)) break;
      if (dir === os.homedir()) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      depth++;
    }

    // 3. Subdir scan (only if cwd === workspaceRoot)
    if (path.resolve(cwd) === path.resolve(workspaceRoot)) {
      for (const r of await this.scanSubdirs(workspaceRoot)) {
        if (!results.some(x => x.path === r.path)) results.push(r);
      }
    }

    return results;
  }

  private async tryLoad(fp: string, source: MemoryFileResult['source']): Promise<MemoryFileResult | null> {
    try {
      const st = await fsp.stat(fp);
      if (!st.isFile()) return null;
      if (st.size > MAX_SIZE) { console.warn(`[MemoryWalker] Skip ${fp}: ${st.size} > ${MAX_SIZE}`); return null; }
      return { path: fp, content: await fsp.readFile(fp, 'utf-8'), source, loadedAt: Date.now() };
    } catch { return null; }
  }

  private async scanSubdirs(root: string): Promise<MemoryFileResult[]> {
    const results: MemoryFileResult[] = [];
    try {
      for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || STOP_MARKERS.includes(ent.name)) continue;
        for (const name of MEMORY_NAMES) {
          const r = await this.tryLoad(path.join(root, ent.name, name), 'project_subdir');
          if (r) results.push(r);
        }
      }
    } catch {}
    return results;
  }
}
