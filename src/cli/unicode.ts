export interface UnicodeGlyphs {
  infinity: string;
  bullet: string;
  separator: string;
  branch: string;
  tool: string;
  agent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  command: string;
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 && value !== '0' && value.toLowerCase() !== 'false';
}

export function supportsUnicode(): boolean {
  if (process.platform !== 'win32') return true;
  if (envFlag('WT_SESSION') || envFlag('TERM_PROGRAM')) return true;
  if ((process.env.TERM || '').toLowerCase() === 'xterm-256color') return true;
  return Boolean(process.stdout?.isTTY);
}

export function getGlyphs(): UnicodeGlyphs {
  if (!supportsUnicode()) {
    return {
      infinity: '>',
      bullet: '*',
      separator: '|',
      branch: '>',
      tool: 'T',
      agent: 'A',
      success: '+',
      warning: '!',
      error: 'x',
      info: 'i',
      command: '/',
    };
  }

  return {
    infinity: '∞',
    bullet: '•',
    separator: '│',
    branch: '›',
    tool: '◈',
    agent: '◉',
    success: '✓',
    warning: '▲',
    error: '✕',
    info: '○',
    command: '⌘',
  };
}
