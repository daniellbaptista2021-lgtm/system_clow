/**
 * GrepTool — Content search in files
 *
 * Based on Claude Code's GrepTool
 * Supports regex, file type filtering, output modes
 * Uses Node.js built-in for portability (no ripgrep dependency)
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext, type RenderOptions } from '../Tool.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { formatPathAccessError, resolveSearchPathFromContext } from '../pathing.js';

const GrepInputSchema = z.object({
  pattern: z.string().describe('The regex pattern to search for in file contents'),
  path: z.string().optional().describe('File or directory to search in (defaults to CWD)'),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
    .default('files_with_matches')
    .describe('Output mode: content, files_with_matches, or count'),
  case_insensitive: z.boolean().optional().default(false),
  head_limit: z.number().optional().default(250).describe('Max results to return'),
});

type GrepInput = z.infer<typeof GrepInputSchema>;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.eot',
  '.lock',
]);

export const GrepTool = buildTool<GrepInput>({
  name: 'Grep',
  aliases: ['GrepTool'],
  searchHint: 'search code content regex find text',
  description: `Search file contents using regex patterns.
Output modes: "files_with_matches" (default, shows file paths), "content" (shows matching lines), "count" (shows match counts).
Filter with glob parameter (e.g., "*.ts").`,
  inputSchema: GrepInputSchema,

  userFacingName(input?: GrepInput) { return input ? `Grep(${input.pattern})` : 'Grep'; },
  isReadOnly() { return true; },
  isConcurrencySafe() { return true; },
  isDestructive() { return false; },
  toAutoClassifierInput(input: GrepInput) { return input.pattern; },
  renderToolUseMessage(input: GrepInput, _opts: RenderOptions) { return `Grep: /${input.pattern}/`; },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: GrepInput, context: ToolUseContext): Promise<ToolResult> {
    try {
      const searchPath = resolveSearchPathFromContext(input.path, context);
      const regex = new RegExp(input.pattern, input.case_insensitive ? 'gi' : 'g');

      // Find files
      const globPattern = input.glob || '**/*';
      const files = await glob(globPattern, {
        cwd: searchPath,
        nodir: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
        absolute: true,
      });

      const results: Array<{ file: string; line: number; content: string }> = [];
      const fileMatches: Map<string, number> = new Map();
      let totalMatches = 0;

      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        try {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');
          let fileCount = 0;

          for (let i = 0; i < lines.length; i++) {
            const matches = lines[i].match(regex);
            if (matches) {
              fileCount += matches.length;
              results.push({
                file: path.relative(searchPath, file),
                line: i + 1,
                content: lines[i],
              });
            }
          }

          if (fileCount > 0) {
            fileMatches.set(path.relative(searchPath, file), fileCount);
            totalMatches += fileCount;
          }
        } catch {
          // Skip unreadable files
        }

        if (results.length >= (input.head_limit || 250)) break;
      }

      // Format output based on mode
      let outputText: string;

      switch (input.output_mode) {
        case 'content': {
          const limited = results.slice(0, input.head_limit || 250);
          outputText = limited
            .map((r) => `${r.file}:${r.line}:${r.content}`)
            .join('\n');
          break;
        }
        case 'count': {
          outputText = Array.from(fileMatches.entries())
            .map(([file, count]) => `${file}:${count}`)
            .join('\n');
          break;
        }
        case 'files_with_matches':
        default: {
          outputText = Array.from(fileMatches.keys())
            .slice(0, input.head_limit || 250)
            .join('\n');
          break;
        }
      }

      if (!outputText) {
        outputText = `No matches found for pattern: ${input.pattern}`;
      }

      return {
        output: { totalMatches, fileCount: fileMatches.size },
        outputText,
      };
    } catch (err: any) {
      return {
        output: null,
        outputText: formatPathAccessError(err, 'Error: unable to search file contents'),
        isError: true,
      };
    }
  },
});
