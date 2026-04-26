/**
 * JWT Utilities
 *
 * Lightweight helpers for decoding, inspecting, and scheduling refresh of
 * JWTs used by the bridge worker sessions.  These do NOT verify signatures —
 * that is the server's responsibility.
 */

import { TOKEN_REFRESH_BUFFER_MS } from '../types.js';

// ---------------------------------------------------------------------------
// Decode helpers
// ---------------------------------------------------------------------------

/** Standard JWT payload fields we care about. */
export interface JwtPayload {
  /** Subject (typically the session or worker id). */
  sub?: string;
  /** Issued-at (epoch seconds). */
  iat?: number;
  /** Expiration (epoch seconds). */
  exp?: number;
  /** Not-before (epoch seconds). */
  nbf?: number;
  /** Audience. */
  aud?: string | string[];
  /** Issuer. */
  iss?: string;
  /** JWT ID. */
  jti?: string;
  /** Arbitrary additional claims. */
  [key: string]: unknown;
}

/**
 * Decode the payload of a JWT **without** verifying the signature.
 *
 * @param token  The compact-serialised JWT (header.payload.signature).
 * @returns The parsed payload object.
 * @throws If the token cannot be split or base64-decoded.
 */
export function decodeJwt(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT: expected at least 2 dot-separated parts');
  }

  const payloadB64 = parts[1];
  const json = base64UrlDecode(payloadB64);
  try {
    return JSON.parse(json) as JwtPayload;
  } catch {
    throw new Error('Invalid JWT: payload is not valid JSON');
  }
}

/**
 * Check whether a JWT is expired (or will expire within `bufferMs`).
 *
 * @param token     Compact JWT string.
 * @param bufferMs  Milliseconds before actual expiry to treat as expired.
 *                  Defaults to {@link TOKEN_REFRESH_BUFFER_MS}.
 */
export function isJwtExpired(
  token: string,
  bufferMs: number = TOKEN_REFRESH_BUFFER_MS,
): boolean {
  const expiresAtMs = getJwtExpiry(token);
  if (expiresAtMs === null) {
    // No `exp` claim — treat as never-expiring.
    return false;
  }
  return Date.now() >= expiresAtMs - bufferMs;
}

/**
 * Extract the expiration timestamp from a JWT.
 *
 * @returns Epoch milliseconds, or `null` if the token has no `exp` claim.
 */
export function getJwtExpiry(token: string): number | null {
  const payload = decodeJwt(token);
  if (typeof payload.exp !== 'number') {
    return null;
  }
  // `exp` is in seconds; convert to milliseconds.
  return payload.exp * 1_000;
}

// ---------------------------------------------------------------------------
// Base64-URL decoding
// ---------------------------------------------------------------------------

function base64UrlDecode(input: string): string {
  // Restore standard base64 characters and add padding.
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';

  // Node.js Buffer path.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64').toString('utf-8');
  }

  // Browser / edge-runtime fallback.
  if (typeof atob === 'function') {
    return atob(b64);
  }

  throw new Error('No base64 decoder available');
}

// ---------------------------------------------------------------------------
// JwtRefreshManager
// ---------------------------------------------------------------------------

/** Callback invoked when the manager decides a refresh is due. */
export type JwtRefreshCallback = () => Promise<string>;

/**
 * Manages scheduled refresh of a worker JWT.
 *
 * The manager sets a timer so that the refresh callback fires shortly before
 * the current token expires.  On success it records the new token and
 * reschedules; on failure it retries with exponential back-off.
 */
export class JwtRefreshManager {
  private currentToken: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private readonly bufferMs: number;
  private refreshAttempt = 0;
  private readonly maxRetries = 5;
  private tokenHistory: Array<{ token: string; issuedAt: number }> = [];

  constructor(
    private readonly refreshCallback: JwtRefreshCallback,
    bufferMs?: number,
  ) {
    this.bufferMs = bufferMs ?? TOKEN_REFRESH_BUFFER_MS;
  }

  /** Schedule (or re-schedule) refresh based on the given token. */
  scheduleRefresh(token: string): void {
    this.cancel();
    this.cancelled = false;
    this.currentToken = token;
    this.refreshAttempt = 0;
    this.recordToken(token);

    const expiresAtMs = getJwtExpiry(token);
    if (expiresAtMs === null) {
      // No expiry — nothing to schedule.
      return;
    }

    const delayMs = Math.max(0, expiresAtMs - this.bufferMs - Date.now());
    this.timer = setTimeout(() => {
      void this.executeRefresh();
    }, delayMs);
  }

  /** Cancel any pending refresh. */
  cancel(): void {
    this.cancelled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Return the current token (may be stale if refresh failed). */
  getToken(): string | null {
    return this.currentToken;
  }

  /** Return rotation history for diagnostics. */
  getTokenHistory(): ReadonlyArray<{ token: string; issuedAt: number }> {
    return this.tokenHistory;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async executeRefresh(): Promise<void> {
    if (this.cancelled) return;

    try {
      const newToken = await this.refreshCallback();
      this.currentToken = newToken;
      this.refreshAttempt = 0;
      this.recordToken(newToken);
      this.scheduleRefresh(newToken);
    } catch (err) {
      this.refreshAttempt++;
      if (this.refreshAttempt > this.maxRetries) {
        // eslint-disable-next-line no-console
        console.error(
          `[JwtRefreshManager] Giving up after ${this.maxRetries} retries`,
          err,
        );
        return;
      }

      // Exponential back-off: 1s, 2s, 4s, 8s, 16s …
      const retryMs = 1_000 * Math.pow(2, this.refreshAttempt - 1);
      this.timer = setTimeout(() => {
        void this.executeRefresh();
      }, retryMs);
    }
  }

  private recordToken(token: string): void {
    this.tokenHistory.push({ token, issuedAt: Date.now() });
    // Keep last 10 entries.
    if (this.tokenHistory.length > 10) {
      this.tokenHistory = this.tokenHistory.slice(-10);
    }
  }
}
