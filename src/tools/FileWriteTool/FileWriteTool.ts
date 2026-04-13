/**
 * FileWriteTool — Create/overwrite files
 *
 * Based on Claude Code's FileWriteTool
 * Overwrites existing files. Creates parent directories if needed.
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext, type RenderOptions } from '../Tool.js';
import * as fs from 'fs/promises';
import * as fss from 'fs';
import * as path from 'path';
import { getCwd } from '../../bootstrap/state.js';
import { formatPathAccessError, resolvePathFromContext } from '../pathing.js';

const FileWriteInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to write'),
  content: z.string().describe('The content to write to the file'),
});

type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export const FileWriteTool = buildTool<FileWriteInput>({
  name: 'Write',
  aliases: ['FileWrite', 'FileWriteTool'],
  searchHint: 'file write create new',
  description: `Write a file to the local filesystem. Creates parent directories if needed.
This will overwrite existing files. Prefer Edit for modifying existing files.
You MUST Read the file first if it exists before using Write.`,
  inputSchema: FileWriteInputSchema,

  userFacingName(input?: FileWriteInput) {
    return input ? `Write(${path.basename(input.file_path)})` : 'Write';
  },
  isReadOnly() { return false; },
  isConcurrencySafe() { return false; },
  isDestructive(input: FileWriteInput) {
    // Destructive if overwriting an existing file
    const fp = path.isAbsolute(input.file_path) ? input.file_path : path.resolve(getCwd(), input.file_path);
    try { return fss.existsSync(fp); } catch { return false; }
  },
  interruptBehavior() { return 'block' as const; }, // Don't interrupt mid-write
  toAutoClassifierInput(input: FileWriteInput) { return input.file_path; },
  renderToolUseMessage(input: FileWriteInput, options: RenderOptions) {
    const name = options.verbose ? input.file_path : path.basename(input.file_path);
    return `Write ${name} (${input.content.split('\n').length} lines)`;
  },

  async checkPermissions(input: FileWriteInput) {
    return { behavior: 'ask' as const, message: `Write file: ${input.file_path}` };
  },

  async call(input: FileWriteInput, context: ToolUseContext): Promise<ToolResult> {
    try {
      const filePath = resolvePathFromContext(input.file_path, context);
      // Create parent directories
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, 'utf-8');

      const lines = input.content.split('\n').length;
      const bytes = Buffer.byteLength(input.content, 'utf-8');

      return {
        output: { path: filePath, lines, bytes },
        outputText: `Successfully wrote ${filePath} (${lines} lines, ${bytes} bytes)`,
      };
    } catch (err: any) {
      return {
        output: null,
        outputText: formatPathAccessError(err, 'Error writing file'),
        isError: true,
      };
    }
  },
});
