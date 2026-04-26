/** Context assembly vocabulary. */

export interface SystemPromptParts {
  defaultSystemPrompt: string[];
  memoryMechanicsPrompt?: string;
  appendSystemPrompt?: string;
  customSystemPrompt?: string;
}

export interface UserContextBlock {
  cwd: string;
  workspaceRoot: string;
  platform: string;
  shell: string;
  nodeVersion: string;
  date: string;
  isGitRepo: boolean;
  gitBranch?: string;
  gitStatus?: string;
  recentlyModifiedFiles?: string[];
  additionalWorkingDirectories?: string[];
  tenantTier?: string;
  tenantId?: string;
  permissionMode: string;
  agentDepth: number;
}

export interface AssembledContext {
  systemPrompt: string;
  dynamicContextMessage: string;
  memoryMechanicsActive: boolean;
  discoveredSkills: string[];
  cacheableHash: string;
  estimatedTokens: number;
}

export interface ContextAssemblyOptions {
  tools: any[];
  mainLoopModel: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  workspaceRoot: string;
  cwd: string;
  additionalWorkingDirectories?: string[];
  tenantTier?: string;
  tenantId?: string;
  permissionMode: string;
  agentDepth: number;
  isCoordinatorMode?: boolean;
  scratchpadDir?: string;
}

export interface MemoryFileResult {
  path: string;
  content: string;
  source: 'user' | 'workspace' | 'project_subdir';
  loadedAt: number;
}
