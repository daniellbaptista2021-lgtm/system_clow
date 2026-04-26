import path from 'path';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import { buildTool, type Tool, type ToolResult, type ToolUseContext } from '../../tools/Tool.js';
import type { PluginSystem } from '../PluginSystem.js';
import type { LoadedPlugin } from '../types.js';
import { PluginToolLoader, type ResolvedPluginTool } from './PluginToolLoader.js';
import { PluginSandbox } from '../security/PluginSandbox.js';

interface PluginToolModuleContext {
  cwd: string;
  sessionId: string;
  tenantId?: string;
  workspaceRoot: string;
  pluginName: string;
  pluginRoot: string;
}

type PluginToolHandler = (input: unknown, context: PluginToolModuleContext) => Promise<unknown> | unknown;

interface PluginToolModule {
  execute?: PluginToolHandler;
  run?: PluginToolHandler;
  default?: PluginToolHandler | { execute?: PluginToolHandler; run?: PluginToolHandler };
}

function getHandler(mod: PluginToolModule): PluginToolHandler | null {
  if (typeof mod.execute === 'function') return mod.execute;
  if (typeof mod.run === 'function') return mod.run;
  if (typeof mod.default === 'function') return mod.default;
  if (mod.default && typeof mod.default === 'object') {
    if (typeof mod.default.execute === 'function') return mod.default.execute;
    if (typeof mod.default.run === 'function') return mod.default.run;
  }
  return null;
}

function normalizeOutput(result: unknown): ToolResult {
  if (typeof result === 'string') {
    return { output: result, outputText: result };
  }

  if (result && typeof result === 'object') {
    const candidate = result as Record<string, unknown>;
    if (typeof candidate.outputText === 'string') {
      return {
        output: candidate.output ?? candidate,
        outputText: candidate.outputText,
        isError: candidate.isError === true,
        metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null
          ? candidate.metadata as Record<string, unknown>
          : undefined,
      };
    }
  }

  return {
    output: result,
    outputText: JSON.stringify(result ?? null),
  };
}

function buildPluginContext(plugin: LoadedPlugin, context: ToolUseContext): PluginToolModuleContext {
  return {
    cwd: context.cwd,
    sessionId: context.sessionId,
    tenantId: context.tenantId,
    workspaceRoot: context.workspaceRoot || context.cwd,
    pluginName: plugin.manifest.name,
    pluginRoot: plugin.rootDir,
  };
}

function buildRuntimeTool(plugin: LoadedPlugin, resolved: ResolvedPluginTool, sandbox: PluginSandbox): Tool {
  return buildTool({
    name: resolved.qualifiedName,
    description: resolved.description,
    inputSchema: z.any(),
    userFacingName: () => resolved.qualifiedName,
    isReadOnly: () => !resolved.isWrite,
    isConcurrencySafe: () => true,
    isDestructive: () => resolved.isWrite,
    async checkPermissions() {
      return resolved.requiresConfirmation
        ? { behavior: 'ask' as const, message: `Plugin tool ${resolved.qualifiedName} requires confirmation` }
        : { behavior: 'passthrough' as const };
    },
    renderToolUseMessage() {
      return resolved.qualifiedName;
    },
    async call(input: unknown, context: ToolUseContext) {
      const workspaceRoot = context.workspaceRoot || context.cwd;
      const access = sandbox.validatePathWithSymlinks(plugin, resolved.filePath, workspaceRoot);
      if (!access.safe) {
        return {
          output: null,
          outputText: `Plugin tool blocked by sandbox: ${resolved.qualifiedName}`,
          isError: true,
        };
      }

      const mod = await import(pathToFileURL(path.resolve(resolved.filePath)).href);
      const handler = getHandler(mod as PluginToolModule);
      if (!handler) {
        return {
          output: null,
          outputText: `Plugin tool ${resolved.qualifiedName} is missing an exported execute/run function`,
          isError: true,
        };
      }

      try {
        const result = await handler(input, buildPluginContext(plugin, context));
        return normalizeOutput(result);
      } catch (err) {
        return {
          output: null,
          outputText: `Plugin tool ${resolved.qualifiedName} failed: ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  });
}

export async function buildPluginRuntimeTools(pluginSystem: PluginSystem): Promise<Tool[]> {
  const loader = new PluginToolLoader();
  const sandbox = new PluginSandbox();
  const tools: Tool[] = [];

  for (const plugin of pluginSystem.registry.listEnabled()) {
    const resolved = await loader.resolveAll(plugin.rootDir, plugin.manifest);
    for (const tool of resolved) {
      tools.push(buildRuntimeTool(plugin, tool, sandbox));
    }
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}
