/**
 * bridgeUI.ts — Terminal status display for bridge mode
 *
 * Shows connection status, active sessions, and activity
 * in a compact terminal-friendly format.
 */

import type { BridgeEnvironment, BridgeSessionStatus, PollConfig } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BridgeStatusInfo {
  mode: string;
  transportVersion: string;
  environmentId?: string;
  connected: boolean;
  activeSessions: number;
  capacity: number;
  uptime: number;
  messagesSent: number;
  messagesReceived: number;
  lastPollAt: number;
  lastHeartbeatAt: number;
  errors: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Bridge UI
// ════════════════════════════════════════════════════════════════════════════

export class BridgeUI {
  private statusInfo: BridgeStatusInfo = {
    mode: 'standalone',
    transportVersion: 'v2',
    connected: false,
    activeSessions: 0,
    capacity: 1,
    uptime: 0,
    messagesSent: 0,
    messagesReceived: 0,
    lastPollAt: 0,
    lastHeartbeatAt: 0,
    errors: 0,
  };

  /**
   * Update the status info.
   */
  update(partial: Partial<BridgeStatusInfo>): void {
    Object.assign(this.statusInfo, partial);
  }

  /**
   * Format a compact status line for terminal.
   */
  formatStatusLine(): string {
    const s = this.statusInfo;
    const parts: string[] = [];

    parts.push(s.connected ? '🟢' : '🔴');
    parts.push(`[${s.mode}/${s.transportVersion}]`);
    parts.push(`${s.activeSessions}/${s.capacity} sessions`);

    if (s.uptime > 0) {
      const mins = Math.floor(s.uptime / 60_000);
      parts.push(`${mins}m uptime`);
    }

    if (s.messagesSent > 0 || s.messagesReceived > 0) {
      parts.push(`↑${s.messagesSent} ↓${s.messagesReceived}`);
    }

    if (s.errors > 0) {
      parts.push(`⚠️${s.errors} errs`);
    }

    return parts.join(' | ');
  }

  /**
   * Format a detailed status block.
   */
  formatDetailedStatus(): string {
    const s = this.statusInfo;
    const lines: string[] = [];

    lines.push('═══ Bridge Status ═══');
    lines.push(`Mode: ${s.mode} | Transport: ${s.transportVersion}`);
    lines.push(`Connected: ${s.connected ? 'YES' : 'NO'}`);
    if (s.environmentId) lines.push(`Environment: ${s.environmentId.slice(0, 12)}...`);
    lines.push(`Sessions: ${s.activeSessions}/${s.capacity}`);
    lines.push(`Uptime: ${Math.floor((s.uptime || 0) / 1000)}s`);
    lines.push(`Messages: ↑${s.messagesSent} sent, ↓${s.messagesReceived} received`);
    lines.push(`Errors: ${s.errors}`);

    if (s.lastPollAt > 0) {
      lines.push(`Last poll: ${Math.floor((Date.now() - s.lastPollAt) / 1000)}s ago`);
    }
    if (s.lastHeartbeatAt > 0) {
      lines.push(`Last heartbeat: ${Math.floor((Date.now() - s.lastHeartbeatAt) / 1000)}s ago`);
    }

    return lines.join('\n');
  }

  /**
   * Format a session status indicator.
   */
  static formatSessionStatus(status: BridgeSessionStatus): string {
    const icons: Record<BridgeSessionStatus, string> = {
      creating: '🔄',
      running: '▶️',
      idle: '⏸️',
      requires_action: '❓',
      completed: '✅',
      failed: '❌',
      killed: '💀',
    };
    return `${icons[status] ?? '?'} ${status}`;
  }

  /**
   * Format pairing instructions for the user.
   */
  static formatPairingInstructions(environmentId: string, pairUrl?: string): string {
    const lines: string[] = [];
    lines.push('═══ Bridge Pairing ═══');
    lines.push('');
    lines.push(`Environment ID: ${environmentId}`);
    if (pairUrl) {
      lines.push(`Pair URL: ${pairUrl}`);
      lines.push('');
      lines.push('Scan the QR code or visit the URL to pair your device.');
    }
    lines.push('');
    lines.push('Waiting for connection...');
    return lines.join('\n');
  }
}
