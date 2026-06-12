/**
 * commandValidator.ts — Security checks before execution
 * Blocks: bare git attack, fork bombs, device writes, curl|sh
 *
 * Multi-layered validation:
 *   1. Length check — reject absurdly long commands
 *   2. Pattern-based blocklist — known dangerous patterns
 *   3. Input sanitization — strip null bytes, control chars
 *   4. Error classification — categorize rejection reasons
 *   5. Execution statistics — track validation outcomes
 */

/** Classification of why a command was rejected */
export type ValidationErrorCategory =
  | 'length'
  | 'injection'
  | 'destructive'
  | 'network_abuse'
  | 'privilege_escalation'
  | 'resource_abuse';

/** Result of command validation with error classification */
export interface ValidationFailure {
  valid: false;
  reason: string;
  code: string;
  category: ValidationErrorCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export type CommandValidationResult = { valid: true } | ValidationFailure;

export class CommandValidator {
  /** Track validation statistics */
  private static totalValidations = 0;
  private static totalRejections = 0;
  private static rejectionsByCode = new Map<string, number>();
  private static rejectionsByCategory = new Map<ValidationErrorCategory, number>();

  /**
   * Validate a command for security issues.
   * Returns detailed error information including category and severity.
   *
   * @param command - The shell command to validate
   * @returns Validation result with detailed error info on failure
   */
  static validate(command: string): CommandValidationResult {
    this.totalValidations++;

    // Phase 1: Length validation
    if (command.length > 10_000) {
      return this.reject('Command too long (>10K chars)', 'COMMAND_TOO_LONG', 'length', 'medium');
    }

    // Phase 2: Null byte / control character detection
    if (/\x00/.test(command)) {
      return this.reject('Null bytes detected in command', 'NULL_BYTE', 'injection', 'critical');
    }

    // Phase 3: Pattern-based blocklist
    if (/\bgit\s+(?:--git-dir|--work-tree)\b/.test(command)) {
      return this.reject('git --git-dir/--work-tree blocked', 'GIT_DIR_FLAG', 'injection', 'high');
    }

    if (/:\(\)\s*\{[^}]*:\s*\|\s*:/.test(command)) {
      return this.reject('Fork bomb pattern detected', 'FORK_BOMB', 'resource_abuse', 'critical');
    }

    if (/>\s*\/dev\/(sd[a-z]|nvme|hd[a-z])/.test(command)) {
      return this.reject('Direct device write blocked', 'DEVICE_WRITE', 'destructive', 'critical');
    }

    if (/\bdd\s+.*\bof=\/dev\//.test(command)) {
      return this.reject('dd to device blocked', 'DD_DEVICE', 'destructive', 'critical');
    }

    if (/(?:curl|wget)\s+[^|]*\|\s*(?:bash|sh|zsh)/.test(command)) {
      return this.reject('curl|sh blocked (inspect script first)', 'CURL_PIPE_SHELL', 'injection', 'high');
    }

    // Phase 4: Additional security patterns
    if (/\bchmod\s+[0-7]*777\b/.test(command)) {
      return this.reject('chmod 777 is overly permissive', 'CHMOD_777', 'privilege_escalation', 'medium');
    }

    if (/\brm\s+(-rf?|--recursive)\s+\/\s*$/.test(command) || /\brm\s+(-rf?|--recursive)\s+\/\s+/.test(command)) {
      return this.reject('Recursive delete of root filesystem blocked', 'RM_ROOT', 'destructive', 'critical');
    }

    return { valid: true };
  }

  /**
   * Sanitize a command string by removing dangerous characters.
   * This does NOT replace validation — sanitize first, then validate.
   *
   * @param command - Raw command string
   * @returns Sanitized command with dangerous chars removed
   */
  static sanitize(command: string): string {
    // Remove null bytes
    let sanitized = command.replace(/\x00/g, '');
    // Remove other control characters (except \n, \t, \r)
    sanitized = sanitized.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // Trim excessive whitespace
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
    return sanitized;
  }

  /**
   * Get validation statistics.
   */
  static getStats(): {
    totalValidations: number;
    totalRejections: number;
    rejectionRate: number;
    rejectionsByCode: Record<string, number>;
    rejectionsByCategory: Record<string, number>;
  } {
    return {
      totalValidations: this.totalValidations,
      totalRejections: this.totalRejections,
      rejectionRate: this.totalValidations > 0 ? this.totalRejections / this.totalValidations : 0,
      rejectionsByCode: Object.fromEntries(this.rejectionsByCode),
      rejectionsByCategory: Object.fromEntries(this.rejectionsByCategory),
    };
  }

  /**
   * Reset validation statistics.
   */
  static resetStats(): void {
    this.totalValidations = 0;
    this.totalRejections = 0;
    this.rejectionsByCode.clear();
    this.rejectionsByCategory.clear();
  }

  /** Internal helper to create and track a rejection */
  private static reject(
    reason: string,
    code: string,
    category: ValidationErrorCategory,
    severity: 'low' | 'medium' | 'high' | 'critical',
  ): ValidationFailure {
    this.totalRejections++;
    this.rejectionsByCode.set(code, (this.rejectionsByCode.get(code) ?? 0) + 1);
    this.rejectionsByCategory.set(category, (this.rejectionsByCategory.get(category) ?? 0) + 1);
    return { valid: false, reason, code, category, severity };
  }
}
