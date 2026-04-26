// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefreshCallback = (oldToken: string) => Promise<string>;

interface ScheduledRefresh {
  token: string;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
  scheduledAt: number;
}

// ---------------------------------------------------------------------------
// TokenRefreshManager
// ---------------------------------------------------------------------------

export class TokenRefreshManager {
  private scheduled: ScheduledRefresh | null = null;
  private readonly defaultBufferMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options?: {
    defaultBufferMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
  }) {
    this.defaultBufferMs = options?.defaultBufferMs ?? 60_000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 5_000;
  }

  /**
   * Schedule a token refresh. Parses the JWT to find the exp claim and
   * schedules the callback to fire `bufferMs` before expiry.
   */
  scheduleRefresh(
    token: string,
    refreshCallback: RefreshCallback,
    bufferMs?: number,
  ): void {
    this.cancel();

    const buffer = bufferMs ?? this.defaultBufferMs;
    const expiresAt = this.getExpiration(token);
    if (expiresAt === null) return;

    const refreshAt = expiresAt - buffer;
    const delayMs = Math.max(0, refreshAt - Date.now());

    const timer = setTimeout(() => {
      this.executeRefresh(token, refreshCallback, 0);
    }, delayMs);

    this.scheduled = { token, timer, expiresAt, scheduledAt: Date.now() };
  }

  /** Cancel any pending refresh. */
  cancel(): void {
    if (this.scheduled) {
      clearTimeout(this.scheduled.timer);
      this.scheduled = null;
    }
  }

  /** Whether a refresh is currently scheduled. */
  isScheduled(): boolean {
    return this.scheduled !== null;
  }

  /** Get the scheduled expiration time, if any. */
  getScheduledExpiry(): number | null {
    return this.scheduled?.expiresAt ?? null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async executeRefresh(
    oldToken: string,
    refreshCallback: RefreshCallback,
    attempt: number,
  ): Promise<void> {
    try {
      const newToken = await refreshCallback(oldToken);
      this.scheduleRefresh(newToken, refreshCallback);
    } catch (err) {
      if (attempt < this.maxRetries) {
        const timer = setTimeout(() => {
          this.executeRefresh(oldToken, refreshCallback, attempt + 1);
        }, this.retryDelayMs * (attempt + 1));
        if (this.scheduled) this.scheduled.timer = timer;
      } else {
        this.scheduled = null;
        console.error(
          '[TokenRefreshManager] Failed to refresh after retries:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Decode the JWT (without verification) and extract the `exp` claim.
   * Returns the expiry as a Unix timestamp in milliseconds, or null.
   */
  private getExpiration(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return null;
      const payload = parts[1]!;
      const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
      const claims = JSON.parse(decoded) as Record<string, unknown>;
      const exp = claims['exp'];
      if (typeof exp === 'number') return exp * 1000;
      return null;
    } catch {
      return null;
    }
  }
}
