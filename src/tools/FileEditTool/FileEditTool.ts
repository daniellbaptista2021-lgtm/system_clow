/**
 * FileEditTool — Surgical text replacements in files
 *
 * Based on Claude Code's FileEditTool
 * Performs exact string replacements. Fails if old_string is not unique.
 * Supports replace_all for renaming across the file.
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type RenderOptions } from '../Tool.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getCwd } from '../../bootstrap/state.js';

const FileEditInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to modify'),
  old_string: z.string().describe('The text to replace'),
  new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
  replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default false)'),
});

type FileEditInput = z.infer<typeof FileEditInputSchema>;

export const FileEditTool = buildTool<FileEditInput>({
  name: 'Edit',
  aliases: ['FileEdit', 'FileEditTool'],
  searchHint: 'file edit replace modify',
  description: `Performs exact string replacements in files.
The edit will FAIL if old_string is not unique in the file (unless replace_all=true).
You must Read the file first before editing.
old_string and new_string must be different.`,
  inputSchema: FileEditInputSchema,

  userFacingName(input?: FileEditInput) {
    return input ? `Edit(${path.basename(input.file_path)})` : 'Edit';
  },
  isReadOnly() { return false; },
  isConcurrencySafe() { return false; },
  isDestructive() { return false; }, // Edits are reversible
  interruptBehavior() { return 'block' as const; },
  toAutoClassifierInput(input: FileEditInput) { return `${input.file_path}: "${input.old_string}" → "${input.new_string}"`; },
  renderToolUseMessage(input: FileEditInput, options: RenderOptions) {
    const name = options.verbose ? input.file_path : path.basename(input.file_path);
    return `Edit ${name}`;
  },

  async checkPermissions(input: FileEditInput) {
    return { behavior: 'ask' as const, message: `Edit file: ${input.file_path}` };
  },

  async call(input: FileEditInput): Promise<ToolResult> {
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(getCwd(), input.file_path);

    if (input.old_string === input.new_string) {
      return {
        output: null,
        outputText: 'Error: old_string and new_string are identical',
        isError: true,
      };
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      if (!content.includes(input.old_string)) {
        return {
          output: null,
          outputText: `Error: old_string not found in ${filePath}. Make sure you have the exact text including whitespace and indentation.`,
          isError: true,
        };
      }

      if (!input.replace_all) {
        // Check uniqueness
        const count = content.split(input.old_string).length - 1;
        if (count > 1) {
          return {
            output: null,
            outputText: `Error: old_string appears ${count} times in ${filePath}. Use replace_all=true to replace all, or provide more surrounding context to make it unique.`,
            isError: true,
          };
        }
      }

      let newContent: string;
      if (input.replace_all) {
        newContent = content.split(input.old_string).join(input.new_string);
      } else {
        const index = content.indexOf(input.old_string);
        newContent =
          content.slice(0, index) +
          input.new_string +
          content.slice(index + input.old_string.length);
      }

      await fs.writeFile(filePath, newContent, 'utf-8');

      const replacements = input.replace_all
        ? content.split(input.old_string).length - 1
        : 1;

      return {
        output: { replacements },
        outputText: `Successfully edited ${filePath} (${replacements} replacement${replacements > 1 ? 's' : ''})`,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return {
          output: null,
          outputText: `Error: File not found: ${filePath}`,
          isError: true,
        };
      }
      return {
        output: null,
        outputText: `Error editing file: ${err.message}`,
        isError: true,
      };
    }
  },
});
