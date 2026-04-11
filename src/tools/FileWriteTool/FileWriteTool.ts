/**
 * FileWriteTool — Create/overwrite files
 *
 * Based on Claude Code's FileWriteTool
 * Overwrites existing files. Creates parent directories if needed.
 */

import { z } from 'zod';
import { buildTool, type ToolResult } from '../Tool.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getCwd } from '../../bootstrap/state.js';

const FileWriteInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to write'),
  content: z.string().describe('The content to write to the file'),
});

type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export const FileWriteTool = buildTool<FileWriteInput>({
  name: 'Write',
  aliases: ['FileWrite', 'FileWriteTool'],
  description: `Write a file to the local filesystem. Creates parent directories if needed.
This will overwrite existing files. Prefer Edit for modifying existing files.
You MUST Read the file first if it exists before using Write.`,
  inputSchema: FileWriteInputSchema,

  isReadOnly() { return false; },
  isConcurrencySafe() { return false; },

  async checkPermissions(input: FileWriteInput) {
    return { behavior: 'ask' as const, message: `Write file: ${input.file_path}` };
  },

  async call(input: FileWriteInput): Promise<ToolResult> {
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(getCwd(), input.file_path);

    try {
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
        outputText: `Error writing file: ${err.message}`,
        isError: true,
      };
    }
  },
});
