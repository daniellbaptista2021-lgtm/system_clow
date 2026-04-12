/**
 * Bridge System — Complete type vocabulary
 *
 * Defines every type, interface, enum, and constant used across the bridge
 * subsystem (transports, API client, JWT utilities, session management).
 */

// ---------------------------------------------------------------------------
// Fundamental enums & literal unions
// ---------------------------------------------------------------------------

/** Operating mode of the bridge. */
export type BridgeMode = 'standalone' | 'repl' | 'env-less';

/** Wire-protocol version negotiated between client and server. */
export type BridgeTransportVersion = 'v1' | 'v2' | 'v3';

/** How child processes are spawned for work items. */
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir';

/** Lifecycle status of a bridge session. */
export type BridgeSessionStatus =
  | 'creating'
  | 'running'
  | 'idle'
  | 'requires_action'
  | 'completed'
  | 'failed'
  | 'killed';

/** Status of a registered environment. */
export type BridgeEnvironmentStatus = 'active' | 'inactive' | 'degraded';

// ---------------------------------------------------------------------------
// Control / system command types (string enums for wire compat)
// ---------------------------------------------------------------------------

export const ControlRequestType = {
  Pause: 'pause',
  Resume: 'resume',
  Cancel: 'cancel',
  Ping: 'ping',
  Reconfigure: 'reconfigure',
} as const;
export type ControlRequestType =
  (typeof ControlRequestType)[keyof typeof ControlRequestType];

export const SystemCommandType = {
  Shutdown: 'shutdown',
  Restart: 'restart',
  HealthCheck: 'health_check',
  ForceDisconnect: 'force_disconnect',
  RotateToken: 'rotate_token',
} as const;
export type SystemCommandType =
  (typeof SystemCommandType)[keyof typeof SystemCommandType];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Worktree-specific settings used when SpawnMode === 'worktree'. */
export interface WorktreeConfig {
  baseDir: string;
  keepAfterExit?: boolean;
}

/** Polling cadence knobs. */
export interface PollConfig {
  /** Base interval in milliseconds between poll requests. */
  intervalMs: number;
  /** Maximum interval after back-off. */
  maxIntervalMs: number;
  /** How many consecutive empty polls before switching to slow mode. */
  idleThreshold: number;
  /** Interval when at full capacity. */
  atCapacityMs: number;
  /** Interval when no sessions are active. */
  notAtCapacityMs: number;
  /** Interval when partially loaded. */
  partialCapacityMs: number;
}

/** Exponential back-off parameters for retries / reconnects. */
export interface BackoffConfig {
  /** Initial delay in ms. */
  initialDelayMs: number;
  /** Multiplicative factor per attempt. */
  multiplier: number;
  /** Upper bound on delay in ms. */
  maxDelayMs: number;
  /** Random jitter factor (0 – 1). */
  jitter: number;
  /** Initial back-off for general poll errors (ms). */
  generalInitialMs: number;
  /** Give-up threshold for sustained errors (ms). */
  generalGiveUpMs: number;
  /** Max cap for general back-off (ms). */
  generalCapMs: number;
}

/** Top-level bridge configuration supplied by the user / CLI. */
export interface BridgeConfig {
  mode: BridgeMode;
  transportVersion: BridgeTransportVersion;
  endpointUrl: string;
  apiKey?: string;
  spawnMode?: SpawnMode;
  capacity?: number;
  enableCrashRecovery?: boolean;
  pollConfig?: Partial<PollConfig>;
  backoff?: Partial<BackoffConfig>;
  worktree?: WorktreeConfig;
}

// ---------------------------------------------------------------------------
// Runtime entities
// ---------------------------------------------------------------------------

/** A registered bridge environment (server-side resource). */
export interface BridgeEnvironment {
  environmentId: string;
  secret: string;
  registeredAt: string;
  lastHeartbeatAt?: string;
  capacity: number;
  status: BridgeEnvironmentStatus;
}

/** An individual session managed by the bridge. */
export interface BridgeSession {
  sessionId: string;
  environmentId?: string;
  source: string;
  createdAt: number;
  childPid?: number;
  transportHandle?: string;
  status: BridgeSessionStatus;
  epoch?: number;
  workerJwt?: string;
  workerJwtExpiresAt?: number;
  workerEpoch?: number;
}

/** Pointer stored on disk for crash-recovery / reconnect. */
export interface BridgePointer {
  sessionId: string;
  environmentId?: string;
  source: string;
  createdAt: number;
  lastPid: number;
  perpetual?: boolean;
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

/** Capabilities granted by the server for a work item. */
export interface WorkCapabilities {
  canUseTools: boolean;
  canUseMcp: boolean;
  canSpawnSubagents: boolean;
  maxCostUsd?: number;
  maxTurns?: number;
}

/** A unit of work returned by the poll endpoint. */
export interface WorkResponse {
  workId: string;
  sessionId: string;
  sdkUrl: string;
  workSecret: string;
  capabilities: WorkCapabilities;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

/** Message sent from the bridge to the server. */
export interface OutboundMessage {
  type: string;
  payload: unknown;
  uuid: string;
  timestamp: number;
}

/** Message received from the server. */
export interface InboundMessage {
  type: string;
  payload: unknown;
  uuid: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

/** Callback signature for incoming messages on a transport. */
export type TransportMessageHandler = (message: InboundMessage) => void;

/**
 * Abstract transport that every concrete transport (Hybrid, SSE, REPL, etc.)
 * must implement.
 */
export interface Transport {
  readonly version: BridgeTransportVersion;

  /** Establish the underlying connection(s). */
  connect(): Promise<void>;

  /** Tear down all connections gracefully. */
  disconnect(): Promise<void>;

  /** Send an outbound message to the server. */
  send(message: OutboundMessage): Promise<void>;

  /** Register a handler for inbound messages. */
  onMessage(handler: TransportMessageHandler): void;

  /** Report the current local state to the server. */
  reportState(state: Record<string, unknown>): Promise<void>;

  /** Acknowledge delivery of a specific message. */
  reportDelivery(uuid: string): Promise<void>;

  /** Whether the transport currently considers itself connected. */
  isConnected(): boolean;
}

/** Factory function signature stored in the TransportRegistry. */
export type TransportFactory = (
  config: BridgeConfig,
  session: BridgeSession,
  workResponse: WorkResponse,
) => Transport;

// ---------------------------------------------------------------------------
// HTTP client types
// ---------------------------------------------------------------------------

/** Minimal HTTP response shape consumed by BridgeApiClient. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Minimal HTTP client interface for dependency injection in tests. */
export interface HttpClient {
  request(
    url: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// API request / response shapes
// ---------------------------------------------------------------------------

export interface RegisterEnvironmentRequest {
  capacity: number;
  metadata?: Record<string, string>;
}

export interface RegisterEnvironmentResponse {
  environmentId: string;
  secret: string;
  registeredAt: string;
}

export interface PollForWorkResponse {
  work: WorkResponse | null;
}

export interface HeartbeatRequest {
  environmentId: string;
  activeSessions: string[];
}

export interface HeartbeatResponse {
  ok: boolean;
  commands?: Array<{ type: SystemCommandType; payload?: unknown }>;
}

export interface AckWorkRequest {
  workId: string;
  sessionId: string;
}

export interface StopWorkRequest {
  workId: string;
  sessionId: string;
  reason?: string;
}

export interface CreateSessionEnvLessRequest {
  source: string;
  metadata?: Record<string, string>;
}

export interface CreateSessionEnvLessResponse {
  sessionId: string;
  sdkUrl: string;
  workSecret: string;
  workerJwt: string;
  workerJwtExpiresAt: number;
  epoch: number;
}

export interface CreateBridgeForSessionRequest {
  sessionId: string;
  environmentId: string;
}

export interface CreateBridgeForSessionResponse {
  transportHandle: string;
  sdkUrl: string;
  workSecret: string;
}

export interface ReconnectSessionRequest {
  sessionId: string;
  lastEpoch?: number;
}

export interface ReconnectSessionResponse {
  sdkUrl: string;
  workSecret: string;
  workerJwt: string;
  workerJwtExpiresAt: number;
  epoch: number;
}

// ---------------------------------------------------------------------------
// CCR (v2) types
// ---------------------------------------------------------------------------

/** An event posted to the CCR /worker/events endpoint. */
export interface CCREvent {
  eventType: string;
  payload: unknown;
  timestamp: number;
  uuid: string;
}

/** Registration payload for PUT /worker. */
export interface WorkerRegistration {
  workerId: string;
  sessionId: string;
  capabilities: string[];
  epoch: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BridgeApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'BridgeApiError';
  }
}

export class EpochConflictError extends Error {
  constructor(
    message: string,
    public readonly currentEpoch: number,
    public readonly serverEpoch: number,
  ) {
    super(message);
    this.name = 'EpochConflictError';
  }
}

export class TransportDisconnectedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Transport is not connected');
    this.name = 'TransportDisconnectedError';
  }
}

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

/** Maximum number of times we will re-register an environment after errors. */
export const MAX_ENVIRONMENT_RECREATIONS = 3;

/** How far ahead of actual expiry we refresh JWTs, in milliseconds. */
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000; // 5 minutes

/** Sensible defaults for polling cadence. */
export const DEFAULT_POLL_CONFIG: PollConfig = {
  intervalMs: 2_000,
  maxIntervalMs: 30_000,
  idleThreshold: 10,
  atCapacityMs: 10_000,
  notAtCapacityMs: 2_000,
  partialCapacityMs: 5_000,
};

/** Sensible defaults for exponential back-off. */
export const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelayMs: 500,
  multiplier: 2,
  maxDelayMs: 60_000,
  jitter: 0.2,
  generalInitialMs: 1_000,
  generalGiveUpMs: 300_000,
  generalCapMs: 30_000,
};

/** Maximum events per CCR batch upload. */
export const CCR_BATCH_SIZE = 50;

/** Flush interval for the serial batch uploader, in ms. */
export const CCR_FLUSH_INTERVAL_MS = 250;
