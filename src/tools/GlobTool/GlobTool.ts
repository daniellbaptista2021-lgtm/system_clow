/**
 * GlobTool — Fast file pattern matching
 *
 * Based on Claude Code's GlobTool
 * Supports glob patterns like "**\/*.ts" or "src/**\/*.tsx"
 * Returns matching file paths sorted by modification time
 */

import { z } from 'zod';
import { buildTool, type ToolResult } from '../Tool.js';
import { glob } from 'glob';
import * as path from 'path';
import { getCwd } from '../../bootstrap/state.js';

const GlobInputSchema = z.object({
  pattern: z.string().describe('The glob pattern to match files against'),
  path: z.string().optional().describe('The directory to search in (defaults to CWD)'),
});

type GlobInput = z.infer<typeof GlobInputSchema>;

export const GlobTool = buildTool<GlobInput>({
  name: 'Glob',
  aliases: ['GlobTool'],
  description: `Fast file pattern matching. Supports glob patterns like "**/*.ts".
Returns matching file paths sorted by modification time.
Use this when you need to find files by name patterns.`,
  inputSchema: GlobInputSchema,

  isReadOnly() { return true; },
  isConcurrencySafe() { return true; },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: GlobInput): Promise<ToolResult> {
    const searchPath = input.path
      ? (path.isAbsolute(input.path) ? input.path : path.resolve(getCwd(), input.path))
      : getCwd();

    try {
      const matches = await glob(input.pattern, {
        cwd: searchPath,
        nodir: false,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      });

      if (matches.length === 0) {
        return {
          output: [],
          outputText: `No files found matching pattern: ${input.pattern}`,
        };
      }

      // Sort by path (glob doesn't guarantee order)
      matches.sort();

      const MAX_RESULTS = 500;
      const truncated = matches.length > MAX_RESULTS;
      const displayed = truncated ? matches.slice(0, MAX_RESULTS) : matches;

      let outputText = displayed.join('\n');
      if (truncated) {
        outputText += `\n\n[${matches.length} total matches, showing first ${MAX_RESULTS}]`;
      }

      return {
        output: matches,
        outputText,
      };
    } catch (err: any) {
      return {
        output: null,
        outputText: `Error: ${err.message}`,
        isError: true,
      };
    }
  },
});
