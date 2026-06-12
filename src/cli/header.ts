import { color, divide, formatList, getTerminalWidth, kv, padRight, pill, truncateAnsi, visibleLength } from './theme.js';
import { getGlyphs, supportsUnicode } from './unicode.js';

export interface HeaderRenderInput {
  productName: string;
  version: string;
  subtitle: string;
  model: string;
  sessionId: string;
  cwd: string;
  tools: string[];
  quickCommands: string[];
  mode?: string;
  notices?: string[];
}

function frameLine(content: string, width: number): string {
  const glyphs = supportsUnicode()
    ? { left: '│', right: '│' }
    : { left: '|', right: '|' };
  const innerWidth = width - 4;
  return `${color.softBorder(glyphs.left)} ${padRight(content, innerWidth)} ${color.softBorder(glyphs.right)}`;
}

export function renderHeader(input: HeaderRenderInput): string {
  const width = getTerminalWidth();
  const innerWidth = width - 4;
  const glyphs = getGlyphs();
  const edge = supportsUnicode()
    ? {
        topLeft: '╭',
        topRight: '╮',
        bottomLeft: '╰',
        bottomRight: '╯',
        horizontal: '─',
      }
    : {
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: '+',
        horizontal: '-',
      };

  const title = `${color.brandBright(glyphs.infinity)} ${color.white(input.productName)} ${pill(`v${input.version}`, 'gold')}`;
  const modelLine = `${pill(input.mode || 'workspace', input.mode?.toLowerCase().includes('plan') ? 'cyan' : 'gold')} ${kv('Model', input.model)}`;
  const sessionLine = kv('Session', input.sessionId.slice(0, 8), innerWidth);
  const cwdLine = kv('CWD', input.cwd, innerWidth);
  const toolLine = `${color.muted('Tools')} ${formatList(input.tools, innerWidth - 7)}`;
  const commandLine = `${color.muted('Commands')} ${input.quickCommands.map((cmd) => pill(cmd, 'cyan')).join(` ${color.muted(glyphs.bullet)} `)}`;

  const lines = [
    `${color.softBorder(edge.topLeft)}${color.softBorder(edge.horizontal.repeat(width - 2))}${color.softBorder(edge.topRight)}`,
    frameLine(title, width),
    frameLine(truncateAnsi(color.text(input.subtitle), innerWidth), width),
    frameLine(modelLine, width),
    frameLine(sessionLine, width),
    frameLine(cwdLine, width),
    frameLine(toolLine, width),
    frameLine(commandLine, width),
  ];

  for (const notice of input.notices || []) {
    lines.push(frameLine(truncateAnsi(color.muted(`${glyphs.branch} ${notice}`), innerWidth), width));
  }

  lines.push(`${color.softBorder(edge.bottomLeft)}${color.softBorder(edge.horizontal.repeat(width - 2))}${color.softBorder(edge.bottomRight)}`);
  lines.push(divide(Math.max(visibleLength(stripAnsiFallback(lines[0])), width)));
  return `\n${lines.join('\n')}\n`;
}

function stripAnsiFallback(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}
