/**
 * outputProcessor.ts — Truncation + ANSI stripping for command output
 *
 * Handles:
 *   - ANSI escape code removal for clean output
 *   - Smart truncation preserving head and tail context
 *   - Output size statistics and tracking
 *   - Content-aware processing (detect binary output, error patterns)
 *   - JSDoc documentation for all public methods
 */

import { OUTPUT_LIMIT_CHARS, HEAD_LINES, TAIL_LINES } from './constants.js';

/** Result of processing command output */
export interface ProcessedOutput {
  /** The processed output string */
  output: string;
  /** Whether the output was truncated */
  truncated: boolean;
  /** Original character count before processing */
  originalLength: number;
  /** Number of lines in the original output */
  originalLineCount: number;
  /** Whether the output appears to contain binary data */
  containsBinary: boolean;
  /** Whether the output contains error patterns */
  containsErrors: boolean;
}

export class OutputProcessor {
  /** Track processing statistics */
  private static totalProcessed = 0;
  private static totalTruncated = 0;
  private static totalBytesProcessed = 0;
  private static totalBytesSaved = 0;

  /**
   * Process raw command output: strip ANSI codes, truncate if needed.
   * Preserves the first HEAD_LINES and last TAIL_LINES for context.
   *
   * @param raw - Raw command output string
   * @param opts - Processing options
   * @param opts.stripAnsi - Whether to strip ANSI codes (default: true)
   * @param opts.maxChars - Maximum characters to keep (default: OUTPUT_LIMIT_CHARS)
   * @returns Processed output with metadata
   */
  static process(raw: string, opts: { stripAnsi?: boolean; maxChars?: number } = {}): ProcessedOutput {
    this.totalProcessed++;
    this.totalBytesProcessed += raw.length;

    let text = opts.stripAnsi !== false ? this.stripAnsi(raw) : raw;
    const originalLength = text.length;
    const originalLineCount = text.split('\n').length;
    const maxChars = opts.maxChars ?? OUTPUT_LIMIT_CHARS;

    const containsBinary = this.detectBinary(text);
    const containsErrors = this.detectErrors(text);

    if (text.length <= maxChars) {
      return { output: text, truncated: false, originalLength, originalLineCount, containsBinary, containsErrors };
    }

    this.totalTruncated++;
    const bytesSaved = text.length - maxChars;
    this.totalBytesSaved += bytesSaved;

    const lines = text.split('\n');
    if (lines.length <= HEAD_LINES + TAIL_LINES) {
      const half = Math.floor(maxChars / 2);
      text = text.slice(0, half) + `\n\n[... ${originalLength - maxChars} chars hidden ...]\n\n` + text.slice(-half);
    } else {
      const head = lines.slice(0, HEAD_LINES);
      const tail = lines.slice(-TAIL_LINES);
      const hidden = lines.length - HEAD_LINES - TAIL_LINES;
      text = [...head, '', `[... ${hidden} lines hidden ...]`, '', ...tail].join('\n');
    }
    return { output: text, truncated: true, originalLength, originalLineCount, containsBinary, containsErrors };
  }

  /**
   * Strip ANSI escape sequences from text.
   * Removes color codes, cursor movement, and other terminal control sequences.
   *
   * @param text - Text potentially containing ANSI escape codes
   * @returns Clean text without ANSI codes
   */
  static stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * Detect if output contains binary data (non-printable characters).
   * Binary output should typically not be sent to the LLM.
   *
   * @param text - Output text to check
   * @returns True if binary patterns are detected
   */
  static detectBinary(text: string): boolean {
    // Check for high concentration of non-printable characters
    const sample = text.slice(0, 1000);
    let nonPrintable = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
    }
    return sample.length > 0 && (nonPrintable / sample.length) > 0.1;
  }

  /**
   * Detect if output contains common error patterns.
   * Useful for determining if a command may have failed.
   *
   * @param text - Output text to check for errors
   * @returns True if error patterns are found
   */
  static detectErrors(text: string): boolean {
    const errorPatterns = [
      /\bError\b/i,
      /\bFailed\b/i,
      /\bException\b/i,
      /\bFATAL\b/,
      /\bPANIC\b/,
      /command not found/i,
      /No such file or directory/i,
      /Permission denied/i,
    ];
    return errorPatterns.some(p => p.test(text));
  }

  /**
   * Get output processing statistics.
   *
   * @returns Statistics about output processing since startup
   */
  static getStats(): {
    totalProcessed: number;
    totalTruncated: number;
    truncationRate: number;
    totalBytesProcessed: number;
    totalBytesSaved: number;
    avgOutputSize: number;
  } {
    return {
      totalProcessed: this.totalProcessed,
      totalTruncated: this.totalTruncated,
      truncationRate: this.totalProcessed > 0 ? this.totalTruncated / this.totalProcessed : 0,
      totalBytesProcessed: this.totalBytesProcessed,
      totalBytesSaved: this.totalBytesSaved,
      avgOutputSize: this.totalProcessed > 0 ? Math.round(this.totalBytesProcessed / this.totalProcessed) : 0,
    };
  }

  /**
   * Reset all processing statistics.
   */
  static resetStats(): void {
    this.totalProcessed = 0;
    this.totalTruncated = 0;
    this.totalBytesProcessed = 0;
    this.totalBytesSaved = 0;
  }
}
