/**
 * TeammateMailbox.ts — File-based mailbox with lockfile concurrency control
 *
 * Each agent has an inbox file at ~/.clow/teams/<team>/inboxes/<agentId>.json.
 * Messages are JSON arrays. Concurrent access is protected by .lock files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type {
  MailboxMessage,
  TeamFile,
} from '../types.js';

import {
  MAILBOX_MAX_SIZE,
  MAILBOX_POLL_INTERVAL_MS,
  INBOXES_DIR_NAME,
} from '../constants.js';

import { acquireLock } from './MailboxConcurrency.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface TeammateMailboxOptions {
  /** The clow home directory (e.g., ~/.clow). Teams are at <clowHome>/teams/. */
  clowHome: string;
  /** Specific team name. If omitted, team is derived from agent IDs. */
  teamName?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// TeammateMailbox
// ════════════════════════════════════════════════════════════════════════════

export class TeammateMailbox {
  private readonly clowHome: string;
  private readonly fixedTeamName: string | undefined;

  constructor(options: TeammateMailboxOptions) {
    this.clowHome = options.clowHome;
    this.fixedTeamName = options.teamName;

    // If a fixed team is provided, ensure its inbox dir exists
    if (this.fixedTeamName) {
      const inboxDir = this.getInboxDir(this.fixedTeamName);
      fs.mkdirSync(inboxDir, { recursive: true });
    }
  }

  /**
   * Get the teams root directory.
   */
  private get teamsRoot(): string {
    return path.join(this.clowHome, 'teams');
  }

  /**
   * Get the inbox directory for a given team.
   */
  private getInboxDir(teamName: string): string {
    return path.join(this.teamsRoot, teamName, INBOXES_DIR_NAME);
  }

  /**
   * Extract team name from an agent ID (format: "name@teamName").
   * Falls back to fixedTeamName if no @ found.
   */
  private getTeamNameFromAgentId(agentId: string): string {
    const atIndex = agentId.indexOf('@');
    if (atIndex !== -1) {
      return agentId.slice(atIndex + 1);
    }
    if (this.fixedTeamName) {
      return this.fixedTeamName;
    }
    throw new Error(`Cannot determine team from agent ID "${agentId}" and no fixed team configured`);
  }

  // ─── Send ──────────────────────────────────────────────────────────

  /**
   * Send a message to a recipient's inbox.
   * If `to` is '*', broadcasts to all team members except the sender.
   *
   * @returns The message ID
   */
  async send(message: Omit<MailboxMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): Promise<string> {
    // Assign ID if not present
    if (!message.id) {
      message.id = generateMessageId();
    }
    if (!message.timestamp) {
      message.timestamp = Date.now();
    }

    // After assigning id and timestamp, the message is fully formed
    const fullMessage = message as MailboxMessage;

    if (fullMessage.to === '*') {
      await this.broadcast(fullMessage);
      return fullMessage.id;
    }

    await this.appendToInbox(fullMessage.to, fullMessage);
    return fullMessage.id;
  }

  /**
   * Broadcast a message to all team members except the sender.
   * Reads the team config to discover all members + leader.
   */
  async broadcast(message: MailboxMessage): Promise<void> {
    const teamName = this.getTeamNameFromAgentId(message.from);
    const team = this.loadTeamConfig(teamName);
    if (!team) {
      throw new Error(`Team "${teamName}" not found`);
    }

    // Collect all agent IDs (leader + members)
    const allAgents: string[] = [team.leadAgentId];
    for (const member of team.members) {
      allAgents.push(member.agentId);
    }

    // Send to everyone except the sender
    const recipients = allAgents.filter((id) => id !== message.from);

    for (const recipientId of recipients) {
      const copy: MailboxMessage = {
        ...message,
        to: recipientId,
      };
      await this.appendToInbox(recipientId, copy);
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────

  /**
   * Read all messages in an agent's inbox without consuming them.
   */
  async read(agentId: string): Promise<MailboxMessage[]> {
    const inboxPath = this.getInboxPath(agentId);
    const release = await acquireLock(inboxPath);
    try {
      return this.readInboxFile(inboxPath);
    } finally {
      release();
    }
  }

  /**
   * Read all messages and clear the inbox (consume).
   */
  async readAndConsume(agentId: string): Promise<MailboxMessage[]> {
    const inboxPath = this.getInboxPath(agentId);
    const release = await acquireLock(inboxPath);
    try {
      const messages = this.readInboxFile(inboxPath);
      // Clear the inbox
      this.writeInboxFile(inboxPath, []);
      return messages;
    } finally {
      release();
    }
  }

  /**
   * Consume (remove) specific messages by ID from an agent's inbox.
   */
  async consumeSpecific(
    agentId: string,
    messageIds: string[]
  ): Promise<void> {
    const inboxPath = this.getInboxPath(agentId);
    const idsToRemove = new Set(messageIds);
    const release = await acquireLock(inboxPath);
    try {
      const messages = this.readInboxFile(inboxPath);
      const remaining = messages.filter((m) => !idsToRemove.has(m.id));
      this.writeInboxFile(inboxPath, remaining);
    } finally {
      release();
    }
  }

  // ─── Wait ──────────────────────────────────────────────────────────

  /**
   * Poll for a reply to a specific message.
   * Checks the inbox repeatedly until a matching reply is found or timeout.
   *
   * @param agentId - The agent whose inbox to check
   * @param replyToId - The message ID we're waiting for a reply to
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @returns The reply message, or null if timeout
   */
  async waitForReply(
    agentId: string,
    replyToId: string,
    timeoutMs: number
  ): Promise<MailboxMessage | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await this.read(agentId);
      const reply = messages.find((m) => m.replyToId === replyToId);

      if (reply) {
        // Consume just this message
        await this.consumeSpecific(agentId, [reply.id]);
        return reply;
      }

      // Wait before next poll
      const remaining = deadline - Date.now();
      const delay = Math.min(MAILBOX_POLL_INTERVAL_MS, remaining);
      if (delay <= 0) break;
      await sleep(delay);
    }

    return null;
  }

  // ─── Clear ─────────────────────────────────────────────────────────

  /**
   * Clear all messages in an agent's inbox.
   */
  async clearInbox(agentId: string): Promise<void> {
    const inboxPath = this.getInboxPath(agentId);
    const release = await acquireLock(inboxPath);
    try {
      this.writeInboxFile(inboxPath, []);
    } finally {
      release();
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Get the file path for an agent's inbox.
   */
  private getInboxPath(agentId: string): string {
    const teamName = this.getTeamNameFromAgentId(agentId);
    const inboxDir = this.getInboxDir(teamName);
    // Ensure inbox dir exists
    fs.mkdirSync(inboxDir, { recursive: true });
    const safeId = agentId.replace(/@/g, '_at_');
    return path.join(inboxDir, `${safeId}.json`);
  }

  /**
   * Append a message to an agent's inbox file (with lock).
   */
  private async appendToInbox(
    agentId: string,
    message: MailboxMessage
  ): Promise<void> {
    const inboxPath = this.getInboxPath(agentId);
    const release = await acquireLock(inboxPath);
    try {
      const messages = this.readInboxFile(inboxPath);

      // Enforce max inbox size — drop oldest if full
      if (messages.length >= MAILBOX_MAX_SIZE) {
        messages.splice(0, messages.length - MAILBOX_MAX_SIZE + 1);
      }

      messages.push(message);
      this.writeInboxFile(inboxPath, messages);
    } finally {
      release();
    }
  }

  /**
   * Read messages from an inbox file (no locking — caller must lock).
   */
  private readInboxFile(inboxPath: string): MailboxMessage[] {
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(inboxPath, 'utf-8').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MailboxMessage[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Write messages to an inbox file (no locking — caller must lock).
   */
  private writeInboxFile(
    inboxPath: string,
    messages: MailboxMessage[]
  ): void {
    const dir = path.dirname(inboxPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(inboxPath, JSON.stringify(messages, null, 2), 'utf-8');
  }

  /**
   * Load the team config from disk.
   */
  private loadTeamConfig(teamName: string): TeamFile | null {
    const configPath = path.join(
      this.teamsRoot,
      teamName,
      'config.json'
    );
    if (!fs.existsSync(configPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as TeamFile;
    } catch {
      return null;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function generateMessageId(): string {
  return `msg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
