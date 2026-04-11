/**
 * FileReadTool — Read file contents
 *
 * Based on Claude Code's FileReadTool
 * Supports: offset/limit for large files, line numbering (cat -n format)
 * Cap: 2,000 lines per read (matching documented behavior)
 */

import { z } from 'zod';
import { buildTool, type ToolResult } from '../Tool.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getCwd } from '../../bootstrap/state.js';

const MAX_LINES = 2000;

const FileReadInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from (0-based)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
});

type FileReadInput = z.infer<typeof FileReadInputSchema>;

export const FileReadTool = buildTool<FileReadInput>({
  name: 'Read',
  aliases: ['FileRead', 'FileReadTool'],
  description: `Read a file from the local filesystem. Results returned in cat -n format with line numbers.
By default reads up to ${MAX_LINES} lines from the beginning.
Use offset and limit for large files to read specific sections.`,
  inputSchema: FileReadInputSchema,

  isReadOnly() { return true; },
  isConcurrencySafe() { return true; },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: FileReadInput): Promise<ToolResult> {
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(getCwd(), input.file_path);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const allLines = content.split('\n');

      const offset = input.offset || 0;
      const limit = Math.min(input.limit || MAX_LINES, MAX_LINES);
      const lines = allLines.slice(offset, offset + limit);

      // cat -n format: line numbers starting at 1
      const numbered = lines
        .map((line, i) => `${offset + i + 1}\t${line}`)
        .join('\n');

      let outputText = numbered;
      if (allLines.length > offset + limit) {
        outputText += `\n\n[File has ${allLines.length} total lines. Showing lines ${offset + 1}-${offset + lines.length}]`;
      }

      return {
        output: { content, totalLines: allLines.length },
        outputText,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return {
          output: null,
          outputText: `Error: File not found: ${filePath}`,
          isError: true,
        };
      }
      if (err.code === 'EISDIR') {
        return {
          output: null,
          outputText: `Error: ${filePath} is a directory, not a file. Use Bash with 'ls' to list directory contents.`,
          isError: true,
        };
      }
      return {
        output: null,
        outputText: `Error reading file: ${err.message}`,
        isError: true,
      };
    }
  },
});
