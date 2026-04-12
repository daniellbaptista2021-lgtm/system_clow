// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecodedWorkSecret {
  transportVersion: number;
  jwt: string;
  sseUrl?: string;
  wsUrl?: string;
  ccrBaseUrl?: string;
  workerEpoch?: number;
}

// ---------------------------------------------------------------------------
// WorkSecretDecoder
// ---------------------------------------------------------------------------

export class WorkSecretDecoder {
  /**
   * Decode a work secret string into its constituent parts.
   *
   * The work secret is a Base64-encoded JSON object containing transport
   * connection details and authentication tokens.
   *
   * @throws Error if the secret cannot be decoded or is malformed.
   */
  decode(workSecret: string): DecodedWorkSecret {
    if (!workSecret || workSecret.trim().length === 0) {
      throw new Error('Work secret is empty');
    }

    let jsonStr: string;
    try {
      jsonStr = Buffer.from(workSecret, 'base64').toString('utf-8');
    } catch (err) {
      throw new Error(
        'Failed to Base64-decode work secret: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        'Failed to parse work secret JSON: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    return this.validate(parsed);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private validate(parsed: Record<string, unknown>): DecodedWorkSecret {
    const transportVersion =
      parsed['transportVersion'] ?? parsed['transport_version'];
    if (typeof transportVersion !== 'number') {
      throw new Error('Work secret missing or invalid transportVersion');
    }

    const jwt = parsed['jwt'] ?? parsed['token'];
    if (typeof jwt !== 'string' || jwt.length === 0) {
      throw new Error('Work secret missing or invalid jwt');
    }

    const sseUrl = this.optionalString(parsed, 'sseUrl', 'sse_url');
    const wsUrl = this.optionalString(parsed, 'wsUrl', 'ws_url');
    const ccrBaseUrl = this.optionalString(parsed, 'ccrBaseUrl', 'ccr_base_url');
    const workerEpoch = parsed['workerEpoch'] ?? parsed['worker_epoch'];
    const epochNum = typeof workerEpoch === 'number' ? workerEpoch : undefined;

    return {
      transportVersion,
      jwt: jwt as string,
      sseUrl,
      wsUrl,
      ccrBaseUrl,
      workerEpoch: epochNum,
    };
  }

  private optionalString(
    obj: Record<string, unknown>,
    ...keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) return val;
    }
    return undefined;
  }
}
