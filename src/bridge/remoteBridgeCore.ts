/**
 * remoteBridgeCore.ts — Environment-less JWT direct bridge
 *
 * For v3 "env-less" mode: no environment registration needed.
 * Client gets a JWT directly and uses it to connect.
 * Simpler than standalone but less feature-rich.
 */

import * as crypto from 'crypto';
import type { BridgeConfig, BridgeSession, Transport, OutboundMessage, InboundMessage } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// RemoteBridgeCore
// ════════════════════════════════════════════════════════════════════════════

export class RemoteBridgeCore {
  private sessions = new Map<string, BridgeSession>();
  private messageHandlers = new Set<(msg: InboundMessage) => void>();
  private connected = false;

  constructor(private readonly config: BridgeConfig) {}

  /**
   * Create a direct session with JWT authentication.
   */
  async createSession(jwt: string): Promise<BridgeSession> {
    const sessionId = `env-less_${crypto.randomUUID().slice(0, 8)}`;

    const session: BridgeSession = {
      sessionId,
      source: 'env-less',
      createdAt: Date.now(),
      status: 'creating',
      workerJwt: jwt,
    };

    this.sessions.set(sessionId, session);
    session.status = 'idle';
    return session;
  }

  /**
   * Connect to the bridge endpoint.
   */
  async connect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!session.workerJwt) throw new Error('No JWT for session');

    session.status = 'running';
    this.connected = true;
  }

  /**
   * Send a message through the bridge.
   */
  async send(sessionId: string, message: OutboundMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') {
      throw new Error(`Session ${sessionId} not active`);
    }

    // In env-less mode, POST directly to endpoint
    const response = await fetch(`${this.config.endpointUrl}/v1/code/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.workerJwt}`,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Send failed: ${response.status}`);
    }
  }

  /**
   * Close a session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'completed';
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Register a handler for inbound messages.
   */
  onMessage(handler: (msg: InboundMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => { this.messageHandlers.delete(handler); };
  }

  isConnected(): boolean { return this.connected; }

  getActiveSessions(): BridgeSession[] {
    return [...this.sessions.values()].filter(s => s.status === 'running');
  }
}
