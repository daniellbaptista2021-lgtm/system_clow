/** Manage additional working directories (monorepo support). */

import * as fs from 'fs';
import * as path from 'path';

export class AdditionalDirectoriesManager {
  private dirs = new Set<string>();

  add(dir: string): void {
    const r = path.resolve(dir);
    if (!fs.existsSync(r)) throw new Error(`Not found: ${r}`);
    if (!fs.statSync(r).isDirectory()) throw new Error(`Not a directory: ${r}`);
    this.dirs.add(r);
  }

  remove(dir: string): boolean { return this.dirs.delete(path.resolve(dir)); }
  list(): string[] { return [...this.dirs].sort(); }

  isInside(filePath: string, primaryWorkspace: string): boolean {
    const abs = path.resolve(filePath);
    const pRel = path.relative(primaryWorkspace, abs);
    if (!pRel.startsWith('..') && !path.isAbsolute(pRel)) return true;
    for (const d of this.dirs) {
      const rel = path.relative(d, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
  }

  clear(): void { this.dirs.clear(); }
}
