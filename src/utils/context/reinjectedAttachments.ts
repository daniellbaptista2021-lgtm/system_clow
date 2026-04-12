/** Post-compact reinjection: restore recently-read files + invoked skills. */

import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';

const MAX_FILES = 5;
const FILE_BUDGET = 50_000;
const PER_FILE_MAX = 5_000;
const SKILL_BUDGET = 25_000;
const PER_SKILL_MAX = 5_000;

export class ReinjectedAttachments {
  async buildFileAttachments(filePaths: string[]): Promise<Array<{ path: string; content: string; tokens: number }>> {
    const result: Array<{ path: string; content: string; tokens: number }> = [];
    let budgetUsed = 0;

    for (const fp of filePaths) {
      if (result.length >= MAX_FILES || budgetUsed >= FILE_BUDGET) break;
      try {
        const content = await fsp.readFile(fp, 'utf-8');
        const tokens = Math.ceil(content.length / 4);
        if (tokens > PER_FILE_MAX) continue;
        if (budgetUsed + tokens > FILE_BUDGET) continue;
        result.push({ path: fp, content, tokens });
        budgetUsed += tokens;
      } catch { continue; }
    }
    return result;
  }

  static shouldStrip(msgType: string, attachmentKind?: string): boolean {
    return attachmentKind === 'skill_listing' || attachmentKind === 'skill_discovery';
  }
}
