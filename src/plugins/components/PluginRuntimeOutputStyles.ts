import type { PluginSystem } from '../PluginSystem.js';
import { PluginOutputStyleLoader, type ResolvedOutputStyle } from './PluginOutputStyleLoader.js';

export interface PluginOutputStyleRuntime {
  styles: ResolvedOutputStyle[];
  activeStyle?: ResolvedOutputStyle;
  systemPromptAddition?: string;
}

function selectActiveStyle(styles: ResolvedOutputStyle[]): ResolvedOutputStyle | undefined {
  if (styles.length === 0) return undefined;

  const visible = styles.filter((style) => !style.hidden);
  const pool = visible.length > 0 ? visible : styles;
  const preferredLang = process.env.CLOW_OUTPUT_LANGUAGE || process.env.LANG;

  if (preferredLang) {
    const normalized = preferredLang.toLowerCase();
    const langMatch = pool.find((style) => style.language?.toLowerCase() === normalized);
    if (langMatch) return langMatch;
  }

  return pool[0];
}

function buildSystemPromptAddition(style: ResolvedOutputStyle): string {
  return [
    `## Output style`,
    `Use the plugin-provided output style \"${style.name}\" from plugin \"${style.pluginName}\".`,
    `Format: ${style.format}`,
    `Description: ${style.description}`,
    '',
    style.body,
  ].join('\n');
}

export async function buildPluginRuntimeOutputStyles(pluginSystem: PluginSystem): Promise<PluginOutputStyleRuntime> {
  const loader = new PluginOutputStyleLoader();
  const styles: ResolvedOutputStyle[] = [];

  for (const plugin of pluginSystem.registry.listEnabled()) {
    const resolved = await loader.resolveAll(plugin.rootDir, plugin.manifest);
    styles.push(...resolved);
  }

  styles.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  const activeStyle = selectActiveStyle(styles);

  return {
    styles,
    activeStyle,
    systemPromptAddition: activeStyle ? buildSystemPromptAddition(activeStyle) : undefined,
  };
}
