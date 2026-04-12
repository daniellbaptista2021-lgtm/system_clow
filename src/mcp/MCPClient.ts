/**
 * MCPClient.ts — JSON-RPC 2.0 Client over stdio
 *
 * Based on Claude Code's MCP integration (doc 02, 04)
 * Implements the Model Context Protocol client side:
 *   - Spawns server process, communicates via stdin/stdout
 *   - Handshake: initialize → initialized notification → tools/list
 *   - Line-delimited JSON parser with buffer for fragmented messages
 *   - Per-request timeout (60s default)
 *   - Clean shutdown with process kill
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

// ─── Types ───────────────────────────────────────���──────────────────────────

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface MCPServerInfo {
  name: string;
  version: string;
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Constants ───────────────────────────────────���──────────────────────────

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

// ─── MCPClient Class ────────────────────────────────────────────────────────

export class MCPClient {
  private serverName: string;
  private command: string;
  private args: string[];
  private env: Record<string, string>;

  private process?: ChildProcess;
  private requestId: number = 0;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private tools: MCPTool[] = [];
  private serverInfo?: MCPServerInfo;
  private _connected: boolean = false;

  /** Line-delimited JSON buffer — critical for fragmented messages */
  private buffer: string = '';

  /** Stderr accumulator for debug/error reporting */
  private stderrBuffer: string = '';

  constructor(
    serverName: string,
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = env;
  }

  // ─── Public API ─────────��───────────────────────────────────────────

  get name(): string { return this.serverName; }
  get isConnected(): boolean { return this._connected; }
  get toolCount(): number { return this.tools.length; }

  async connect(): Promise<void> {
    // Spawn server process
    const mergedEnv = { ...process.env, ...this.env };

    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
      windowsHide: true,
      shell: process.platform === 'win32', // Windows needs shell:true for npx/npm
    });

    // Wire up stdout (protocol) and stderr (logs)
    this.process.stdout!.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf-8');
      // Keep last 10K of stderr
      if (this.stderrBuffer.length > 10_000) {
        this.stderrBuffer = this.stderrBuffer.slice(-5_000);
      }
    });

    this.process.on('exit', (code) => {
      this._connected = false;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${this.serverName}" exited with code ${code}`));
        clearTimeout(pending.timer);
      }
      this.pendingRequests.clear();
    });

    this.process.on('error', (err) => {
      this._connected = false;
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${this.serverName}" error: ${err.message}`));
        clearTimeout(pending.timer);
      }
      this.pendingRequests.clear();
    });

    // ── Handshake: initialize ─���───────────────────────────────────────
    try {
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'clow', version: '1.0.0' },
      }, CONNECT_TIMEOUT_MS) as any;

      this.serverInfo = initResult?.serverInfo;

      // Send initialized notification (no id, no response expected)
      this.sendNotification('notifications/initialized');

      // ── List tools ─────────���────────────────────────────────────────
      const toolsResult = await this.sendRequest('tools/list', {}, CONNECT_TIMEOUT_MS) as any;
      this.tools = (toolsResult?.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      }));

      this._connected = true;
    } catch (err: any) {
      this.kill();
      throw new Error(
        `Failed to connect to MCP server "${this.serverName}": ${err.message}` +
        (this.stderrBuffer ? `\nServer stderr: ${this.stderrBuffer.slice(-500)}` : ''),
      );
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    // Try graceful shutdown notification
    try {
      this.sendNotification('notifications/cancelled');
    } catch {}
    this.kill();
  }

  listTools(): MCPTool[] {
    return [...this.tools];
  }

  getServerInfo(): MCPServerInfo | undefined {
    return this.serverInfo;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this._connected) {
      throw new Error(`MCP server "${this.serverName}" is not connected`);
    }

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as any;

    // MCP tool results come as { content: [{ type, text }], isError? }
    return {
      content: result?.content || [{ type: 'text', text: JSON.stringify(result) }],
      isError: result?.isError || false,
    };
  }

  // ─── JSON-RPC Transport ─────────��───────────────────────────────────

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.serverName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
      });

      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private send(msg: JSONRPCRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error(`Cannot send to MCP server "${this.serverName}" — stdin not writable`);
    }
    const data = JSON.stringify(msg) + '\n';
    this.process.stdin.write(data);
  }

  // ─── Line-Delimited JSON Parser ────────��───────────────────────────
  // Critical: servers may send fragmented chunks. Buffer incomplete lines.

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? ''; // Last incomplete line stays in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JSONRPCResponse;
        this.handleMessage(msg);
      } catch {
        // Not JSON — server log output, ignore
      }
    }
  }

  private handleMessage(msg: JSONRPCResponse): void {
    // Notifications from server (no id) — ignore for now
    if (msg.id === undefined || msg.id === null) return;

    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return; // Orphan response

    this.pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // ─── Process Management ─────────────────────────────────────────────

  private kill(): void {
    if (this.process) {
      try {
        this.process.stdin?.end();
        this.process.kill('SIGTERM');
        // Force kill after 3s if still alive
        const proc = this.process;
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 3_000);
      } catch {}
      this.process = undefined;
    }
  }
}
