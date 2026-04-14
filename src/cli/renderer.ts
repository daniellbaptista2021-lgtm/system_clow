import type { QueryEngine } from '../query/QueryEngine.js';
import { getTotalInputTokens, getTotalOutputTokens } from '../bootstrap/state.js';
import { color, divide, getTerminalWidth, kv, pill, truncateAnsi } from './theme.js';
import { getGlyphs } from './unicode.js';

interface ToolRecord {
  name: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  endedAt?: number;
}

interface TurnState {
  startedAt: number;
  tools: ToolRecord[];
  assistantOpen: boolean;
  assistantStreamed: boolean;
  lastResult?: string;
  agentNames: Set<string>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  try {
    const json = JSON.stringify(input);
    return json.length > 88 ? `${json.slice(0, 85)}...` : json;
  } catch {
    return String(input);
  }
}

export class TerminalSessionRenderer {
  private turn: TurnState | null = null;
  private readonly glyphs = getGlyphs();

  renderHeader(header: string): void {
    process.stdout.write(header);
  }

  renderNotice(message: string, tone: 'muted' | 'success' | 'warning' | 'error' | 'accent' = 'muted'): void {
    const painter = {
      muted: color.muted,
      success: color.success,
      warning: color.warning,
      error: color.danger,
      accent: color.accent,
    }[tone];
    process.stdout.write(`${painter(`${this.glyphs.branch} ${message}`)}\n`);
  }

  beginTurn(input: string): void {
    this.turn = {
      startedAt: Date.now(),
      tools: [],
      assistantOpen: false,
      assistantStreamed: false,
      agentNames: new Set<string>(),
    };
    process.stdout.write(`\n${color.brandBright(this.glyphs.infinity)} ${color.white('You')}\n`);
    process.stdout.write(`${color.text(input)}\n\n`);
  }

  startAssistant(): void {
    if (!this.turn) return;
    if (this.turn.assistantOpen) return;
    this.turn.assistantOpen = true;
    process.stdout.write(`${color.accent(this.glyphs.branch)} ${color.white('System Clow')}\n`);
  }

  streamText(text: string): void {
    if (!this.turn) return;
    if (!this.turn.assistantOpen) {
      this.startAssistant();
    }
    this.turn.assistantStreamed = true;
    process.stdout.write(color.text(text));
  }

  private ensureAssistantBreak(): void {
    if (!this.turn?.assistantOpen) return;
    process.stdout.write('\n');
    this.turn.assistantOpen = false;
  }

  toolStarted(name: string, input: unknown): void {
    if (!this.turn) return;
    this.ensureAssistantBreak();
    const record: ToolRecord = { name, status: 'running', startedAt: Date.now() };
    this.turn.tools.push(record);
    if (name.toLowerCase().includes('agent')) {
      this.turn.agentNames.add(name);
    }
    const preview = summarizeToolInput(input);
    const suffix = preview ? ` ${color.muted(preview)}` : '';
    process.stdout.write(
      `${pill('tool', 'gold')} ${color.white(name)} ${color.muted('started')}${suffix}\n`,
    );
  }

  toolFinished(name: string, result: { isError?: boolean } | null | undefined): void {
    if (!this.turn) return;
    const record = [...this.turn.tools].reverse().find((tool) => tool.name === name && tool.status === 'running');
    if (record) {
      record.status = result?.isError ? 'error' : 'success';
      record.endedAt = Date.now();
    }
    const tone = result?.isError ? 'danger' : 'success';
    const status = result?.isError ? 'error' : 'done';
    const duration = record?.endedAt ? formatDuration(record.endedAt - record.startedAt) : '';
    process.stdout.write(
      `${pill(name.toLowerCase().includes('agent') ? 'agent' : 'tool', tone === 'danger' ? 'danger' : 'success')} ${color.white(name)} ${color.muted(status)}${duration ? ` ${color.muted(`(${duration})`)}` : ''}\n`,
    );
  }

  renderSystem(subtype: string, message: string): void {
    if (!this.turn) return;
    this.ensureAssistantBreak();
    let tone: 'muted' | 'warning' | 'error' | 'accent' = 'muted';
    if (subtype.includes('error') || subtype.includes('failed')) tone = 'error';
    else if (subtype.includes('warning') || subtype.includes('compact')) tone = 'warning';
    else if (subtype.includes('fallback')) tone = 'accent';
    this.renderNotice(message, tone);
  }

  finishTurn(engine: QueryEngine, resultSubtype: string, resultContent?: string): void {
    if (!this.turn) return;
    if (this.turn.assistantOpen) {
      process.stdout.write('\n');
      this.turn.assistantOpen = false;
    }

    this.turn.lastResult = resultContent;
    const stats = engine.getQueryStats();
    const context = engine.getContextInfo();
    const duration = formatDuration(Date.now() - this.turn.startedAt);
    const usedTools = this.turn.tools.map((tool) => tool.name);
    const toolSummary = usedTools.length > 0 ? usedTools.join(', ') : 'none';
    const agentSummary = this.turn.agentNames.size > 0 ? Array.from(this.turn.agentNames).join(', ') : 'none';
    const statusTone = resultSubtype.startsWith('error') ? 'danger' : 'success';
    const statusLabel = resultSubtype.startsWith('error') ? 'attention' : 'complete';

    process.stdout.write(`${divide(getTerminalWidth())}\n`);
    process.stdout.write(`${pill(statusLabel, statusTone === 'danger' ? 'danger' : 'success')} ${kv('Tools used', toolSummary)}\n`);
    process.stdout.write(`${kv('Agents', agentSummary)}\n`);
    process.stdout.write(`${kv('Run', `${duration} ${this.glyphs.separator} ${stats.turnCount} turns ${this.glyphs.separator} $${stats.totalCostUsd.toFixed(4)}`)}\n`);
    process.stdout.write(`${kv('Context', `${context.usagePercent.toFixed(0)}% used ${this.glyphs.separator} ${engine.getMessageCount()} messages`)}\n\n`);
    this.turn = null;
  }

  renderHelp(pluginCommands: Array<{ plugin: string; command: { name: string; description: string } }>): void {
    const sections = [
      `${pill('core', 'gold')} ${color.white('/help')} ${color.muted('show available commands')}`,
      `${pill('core', 'gold')} ${color.white('/exit')} ${color.muted('close the session')}`,
      `${pill('core', 'gold')} ${color.white('/clear')} ${color.muted('reset conversation state')}`,
      `${pill('core', 'gold')} ${color.white('/cost')} ${color.muted('show session cost and token details')}`,
      `${pill('core', 'gold')} ${color.white('/context')} ${color.muted('show current workspace and context info')}`,
      `${pill('core', 'gold')} ${color.white('/plan')} ${color.muted('toggle plan mode')}`,
      `${pill('core', 'gold')} ${color.white('/remote-control start|stop|status')} ${color.muted('manage remote control bridge')}`,
    ];
    process.stdout.write(`\n${color.white('System Clow Commands')}\n`);
    process.stdout.write(`${divide(getTerminalWidth())}\n`);
    for (const line of sections) {
      process.stdout.write(`${line}\n`);
    }
    if (pluginCommands.length > 0) {
      process.stdout.write(`\n${color.white('Plugin Commands')}\n`);
      for (const entry of pluginCommands) {
        process.stdout.write(`${pill(entry.plugin, 'cyan')} ${color.white(`/${entry.command.name}`)} ${color.muted(entry.command.description)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  renderCost(engine: QueryEngine): void {
    const stats = engine.getQueryStats();
    const context = engine.getContextInfo();
    process.stdout.write(`\n${color.white('Session Cost')}\n`);
    process.stdout.write(`${divide(getTerminalWidth())}\n`);
    process.stdout.write(`${kv('Total', `$${stats.totalCostUsd.toFixed(4)}`)}\n`);
    process.stdout.write(`${kv('Input tokens', getTotalInputTokens().toLocaleString())}\n`);
    process.stdout.write(`${kv('Output tokens', getTotalOutputTokens().toLocaleString())}\n`);
    process.stdout.write(`${kv('Messages', String(engine.getMessageCount()))}\n`);
    process.stdout.write(`${kv('Context', `${context.usagePercent.toFixed(1)}% used`)}\n\n`);
  }

  renderContext(engine: QueryEngine, sessionId: string, cwd: string): void {
    const stats = engine.getQueryStats();
    const context = engine.getContextInfo();
    process.stdout.write(`\n${color.white('Workspace Context')}\n`);
    process.stdout.write(`${divide(getTerminalWidth())}\n`);
    process.stdout.write(`${kv('Session', sessionId.slice(0, 8))}\n`);
    process.stdout.write(`${kv('CWD', cwd)}\n`);
    process.stdout.write(`${kv('Model', engine.getModel())}\n`);
    process.stdout.write(`${kv('Messages', String(engine.getMessageCount()))}\n`);
    process.stdout.write(`${kv('Tools used', stats.uniqueToolsUsed.join(', ') || 'none')}\n`);
    process.stdout.write(`${kv('Context', `${context.estimatedTokens.toLocaleString()} estimated tokens`)}\n\n`);
  }

  renderInterrupt(): void {
    this.ensureAssistantBreak();
    this.renderNotice('Execution interrupted.', 'warning');
  }

  renderGoodbye(): void {
    process.stdout.write(`${color.muted('\nSession closed. Goodbye.\n')}`);
  }
}
