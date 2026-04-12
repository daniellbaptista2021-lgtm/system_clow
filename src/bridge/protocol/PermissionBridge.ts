import * as crypto from 'crypto';
import type { Transport, OutboundMessage, InboundMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  workId: string;
  sessionId?: string;
  createdAt: number;
  resolve: (granted: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionBridgeOptions {
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// PermissionBridge
// ---------------------------------------------------------------------------

/**
 * Forward permission prompts to a remote UI and wait for a response.
 */
export class PermissionBridge {
  private readonly transport: Transport;
  private readonly pending: Map<string, PermissionRequest> = new Map();
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(transport: Transport, options?: PermissionBridgeOptions) {
    this.transport = transport;
    this.timeoutMs = options?.timeoutMs ?? 120_000;
  }

  /**
   * Request permission for a tool invocation. Sends a permission_request
   * message through the transport and waits for a response.
   */
  async requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    workId: string,
    sessionId?: string,
  ): Promise<boolean> {
    const id = 'perm_' + String(this.nextId++);

    const outbound: OutboundMessage = {
      type: 'permission_request',
      payload: {
        permissionId: id,
        toolName,
        toolInput,
        workId,
        sessionId,
      },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            'Permission request timed out after ' + this.timeoutMs + 'ms',
          ),
        );
      }, this.timeoutMs);

      const request: PermissionRequest = {
        id,
        toolName,
        toolInput,
        workId,
        sessionId,
        createdAt: Date.now(),
        resolve,
        reject,
        timer,
      };

      this.pending.set(id, request);

      this.transport.send(outbound).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Handle a permission response message from the remote UI.
   */
  handlePermissionResponse(msg: InboundMessage): void {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const permissionId = payload?.['permissionId'] as string | undefined;
    if (!permissionId) return;

    const request = this.pending.get(permissionId);
    if (!request) return;

    clearTimeout(request.timer);
    this.pending.delete(permissionId);

    const granted = payload?.['granted'] as boolean | undefined;
    const error = payload?.['error'] as string | undefined;

    if (error) {
      request.reject(new Error(error));
    } else {
      request.resolve(granted === true);
    }
  }

  /** Number of pending permission requests. */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** Check if a specific request is pending. */
  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** Cancel all pending permission requests. */
  cancelAll(reason?: string): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(
        new Error(reason ?? 'All permission requests cancelled'),
      );
    }
    this.pending.clear();
  }

  /** Cancel a specific pending permission request. */
  cancelRequest(id: string, reason?: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.reject(new Error(reason ?? 'Permission request cancelled'));
  }
}
