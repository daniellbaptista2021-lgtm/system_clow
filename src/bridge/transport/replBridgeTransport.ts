/**
 * REPL Bridge Transport
 *
 * A simpler transport for "REPL mode" where the bridge operates within the
 * same process as the CLI.  Messages are exchanged via stdin / stdout using
 * newline-delimited JSON, making it useful for /remote-control style
 * integrations and testing.
 */

import * as readline from 'readline';
import type {
  BridgeTransportVersion,
  InboundMessage,
  OutboundMessage,
  Transport,
  TransportMessageHandler,
} from '../types.js';
import { TransportDisconnectedError } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// ReplBridgeTransport
// ---------------------------------------------------------------------------

export class ReplBridgeTransport implements Transport {
  readonly version: BridgeTransportVersion = 'v1';

  private handlers: TransportMessageHandler[] = [];
  private connected = false;
  private rl: readline.Interface | null = null;

  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  /**
   * @param input   Readable stream to receive inbound messages (default: stdin).
   * @param output  Writable stream to send outbound messages (default: stdout).
   */
  constructor(
    input?: NodeJS.ReadableStream,
    output?: NodeJS.WritableStream,
  ) {
    this.input = input ?? process.stdin;
    this.output = output ?? process.stdout;
  }

  // -----------------------------------------------------------------------
  // Transport interface
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;

    this.rl = readline.createInterface({ input: this.input });

    this.rl.on('line', (line: string) => {
      this.handleLine(line);
    });

    this.rl.on('close', () => {
      this.connected = false;
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.connected) {
      throw new TransportDisconnectedError();
    }
    return new Promise<void>((resolve, reject) => {
      const json = JSON.stringify(message) + '\n';
      this.output.write(json, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onMessage(handler: TransportMessageHandler): void {
    this.handlers.push(handler);
  }

  async reportState(state: Record<string, unknown>): Promise<void> {
    const msg: OutboundMessage = {
      type: 'state_report',
      payload: state,
      uuid: generateUuid(),
      timestamp: Date.now(),
    };
    await this.send(msg);
  }

  async reportDelivery(uuid: string): Promise<void> {
    const msg: OutboundMessage = {
      type: 'delivery_ack',
      payload: { uuid },
      uuid: generateUuid(),
      timestamp: Date.now(),
    };
    await this.send(msg);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: InboundMessage;
    try {
      parsed = JSON.parse(trimmed) as InboundMessage;
    } catch {
      // eslint-disable-next-line no-console
      console.error('[ReplBridgeTransport] Invalid JSON on stdin');
      return;
    }

    for (const handler of this.handlers) {
      try {
        handler(parsed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ReplBridgeTransport] Handler threw', err);
      }
    }
  }
}
