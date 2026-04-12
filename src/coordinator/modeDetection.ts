/**
 * modeDetection.ts — Detect and control coordinator mode activation
 *
 * Coordinator mode is enabled via:
 *   1. Environment variable: CLOW_COORDINATOR_MODE=1
 *   2. Legacy env var: CLAUDE_CODE_COORDINATOR_MODE=1
 *   3. Programmatic: setCoordinatorMode(true)
 *
 * When resuming a session, the mode is matched to the session's original mode.
 */

// ════════════════════════════════════════════════════════════════════════════
// Mode Detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if coordinator mode is enabled.
 * Checks both CLOW and legacy CLAUDE_CODE env vars.
 */
export function isCoordinatorModeEnabled(): boolean {
  if (process.env.CLOW_COORDINATOR_MODE === '1' ||
      process.env.CLOW_COORDINATOR_MODE === 'true') {
    return true;
  }

  if (process.env.CLAUDE_CODE_COORDINATOR_MODE === '1') {
    return true;
  }

  return false;
}

/**
 * Enable or disable coordinator mode programmatically.
 */
export function setCoordinatorMode(enabled: boolean): void {
  if (enabled) {
    process.env.CLOW_COORDINATOR_MODE = '1';
  } else {
    delete process.env.CLOW_COORDINATOR_MODE;
  }
}

/**
 * Match session mode when resuming.
 * If session was created in coordinator mode but current process is not, switch.
 */
export function matchSessionMode(sessionMode: 'coordinator' | 'normal' | undefined): void {
  if (!sessionMode) return;

  const currentIsCoordinator = isCoordinatorModeEnabled();
  const sessionIsCoordinator = sessionMode === 'coordinator';

  if (currentIsCoordinator === sessionIsCoordinator) return;

  setCoordinatorMode(sessionIsCoordinator);
}

/**
 * Get the current mode as a string for session metadata.
 */
export function getCurrentMode(): 'coordinator' | 'normal' {
  return isCoordinatorModeEnabled() ? 'coordinator' : 'normal';
}

/**
 * Check if coordinator mode is allowed for the current tier.
 * Coordinator mode is restricted to PROFISSIONAL and BUSINESS tiers.
 */
export function isCoordinatorAllowedForTier(tier: string): boolean {
  const allowed = new Set(['profissional', 'business']);
  return allowed.has(tier);
}
