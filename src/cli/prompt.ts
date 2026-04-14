import { color } from './theme.js';
import { getGlyphs } from './unicode.js';

export function renderPrompt(): string {
  const glyphs = getGlyphs();
  return `${color.brandBright(`\n${glyphs.infinity}`)} ${color.muted('')}`;
}
