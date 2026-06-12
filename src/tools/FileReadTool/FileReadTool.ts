/**
 * FileReadTool — Read file contents
 *
 * Based on Claude Code's FileReadTool
 * Supports: offset/limit for large files, line numbering (cat -n format)
 * Cap: 2,000 lines per read (matching documented behavior)
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext, type ValidationResult, type RenderOptions } from '../Tool.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { formatPathAccessError, resolvePathFromContext } from '../pathing.js';

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
  searchHint: 'file read cat view contents',
  description: `Read a file from the local filesystem. Results returned in cat -n format with line numbers.
By default reads up to ${MAX_LINES} lines from the beginning.
Use offset and limit for large files to read specific sections.`,
  inputSchema: FileReadInputSchema,

  userFacingName(input?: FileReadInput) {
    if (!input) return 'Read';
    return `Read(${path.basename(input.file_path)})`;
  },
  isReadOnly() { return true; },
  isConcurrencySafe() { return true; },
  isDestructive() { return false; },
  interruptBehavior() { return 'cancel' as const; },

  toAutoClassifierInput(input: FileReadInput) { return input.file_path; },

  renderToolUseMessage(input: FileReadInput, options: RenderOptions) {
    return options.verbose ? `Read ${input.file_path}` : `Read ${path.basename(input.file_path)}`;
  },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: FileReadInput, context: ToolUseContext): Promise<ToolResult> {
    let filePath = input.file_path;

    try {
      filePath = resolvePathFromContext(input.file_path, context);
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
        outputText: formatPathAccessError(err, 'Error reading file'),
        isError: true,
      };
    }
  },
});
