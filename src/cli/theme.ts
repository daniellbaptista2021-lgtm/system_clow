import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { getGlyphs, supportsUnicode } from './unicode.js';

export const cliTheme = {
  bg: '#0d0b09',
  panel: '#171310',
  border: '#473526',
  borderSoft: '#2d2219',
  gold: '#d8a15b',
  goldBright: '#f0c889',
  cyan: '#6ec7cf',
  white: '#f3eee7',
  text: '#d8d1c6',
  muted: '#9d8f80',
  danger: '#d67f70',
  warning: '#d7b56a',
  success: '#88c3ab',
};

export const color = {
  brand: chalk.hex(cliTheme.gold),
  brandBright: chalk.hex(cliTheme.goldBright),
  accent: chalk.hex(cliTheme.cyan),
  text: chalk.hex(cliTheme.text),
  white: chalk.hex(cliTheme.white),
  muted: chalk.hex(cliTheme.muted),
  border: chalk.hex(cliTheme.border),
  softBorder: chalk.hex(cliTheme.borderSoft),
  danger: chalk.hex(cliTheme.danger),
  warning: chalk.hex(cliTheme.warning),
  success: chalk.hex(cliTheme.success),
  dim: chalk.dim,
};

export function getTerminalWidth(fallback = 110): number {
  const columns = process.stdout.columns || fallback;
  return Math.max(72, Math.min(columns, 140));
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function padRight(value: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${' '.repeat(padding)}`;
}

export function truncateAnsi(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

export function divide(width = getTerminalWidth()): string {
  const glyphs = getGlyphs();
  const lineChar = supportsUnicode() ? '─' : '-';
  return color.softBorder(lineChar.repeat(Math.max(20, width))) + color.muted(` ${glyphs.infinity}`);
}

export function pill(label: string, tone: 'gold' | 'cyan' | 'muted' | 'danger' | 'success' = 'muted'): string {
  const painter = {
    gold: color.brandBright,
    cyan: color.accent,
    muted: color.muted,
    danger: color.danger,
    success: color.success,
  }[tone];
  return painter(`[${label}]`);
}

export function kv(label: string, value: string, width?: number): string {
  const line = `${color.muted(label)} ${color.text(value)}`;
  return width ? truncateAnsi(line, width) : line;
}

export function formatList(values: string[], width: number): string {
  if (values.length === 0) return color.muted('none');
  let current = '';
  for (const value of values) {
    const candidate = current ? `${current}${color.muted(', ')}${color.text(value)}` : color.text(value);
    if (visibleLength(candidate) > width) {
      const remaining = values.length - current.split(',').filter(Boolean).length;
      return `${truncateAnsi(current || candidate, width - 8)} ${color.muted(`+${remaining}`)}`;
    }
    current = candidate;
  }
  return current;
}
