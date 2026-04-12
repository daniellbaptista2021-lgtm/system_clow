/**
 * commandClassifier.ts — Advanced command classification
 * Detects: read-only, destructive, network, privileged, pipes, chains, subshells
 */

import {
  READ_ONLY_COMMANDS, READ_ONLY_GIT, READ_ONLY_NPM,
  DESTRUCTIVE_COMMANDS, NETWORK_COMMANDS, PRIVILEGED_COMMANDS,
} from './constants.js';

export type CommandCategory =
  | 'read_only' | 'write_local' | 'write_remote'
  | 'network' | 'destructive' | 'privileged' | 'unknown';

export interface CommandClassification {
  category: CommandCategory;
  confidence: number;
  reasons: string[];
  hasPipe: boolean;
  hasRedirect: boolean;
  hasChain: boolean;
  hasSubshell: boolean;
  hasSudo: boolean;
  detectedCommands: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

const SEVERITY: Record<CommandCategory, number> = {
  read_only: 0, unknown: 1, network: 2, write_local: 3,
  write_remote: 4, destructive: 5, privileged: 6,
};

export class CommandClassifier {
  classify(command: string): CommandClassification {
    const t = command.trim();
    const hasPipe = /(?<!\\)\|(?!\|)/.test(t);
    const hasChain = /(?<!\\)(&&|\|\||;)/.test(t);
    const hasRedirect = /(?<!\\)[<>]/.test(t) || />>/.test(t);
    const hasSubshell = /\$\(|`/.test(t);
    const hasSudo = /(?:^|\s)sudo\b/.test(t);

    const segments = t.split(/(?:&&|\|\||;)/).map(s => s.trim()).filter(Boolean);
    let worstCat: CommandCategory = 'read_only';
    let minConf = 1.0;
    const allReasons: string[] = [];
    const allCmds: string[] = [];

    for (const seg of segments) {
      const r = this.classifySegment(seg);
      allReasons.push(...r.reasons);
      allCmds.push(...r.commands);
      if (SEVERITY[r.category] > SEVERITY[worstCat]) worstCat = r.category;
      if (r.confidence < minConf) minConf = r.confidence;
    }

    let confidence = minConf;
    if (hasPipe) confidence *= 0.85;
    if (hasSubshell) confidence *= 0.75;
    if (hasChain) confidence *= 0.9;
    if (hasSudo) { worstCat = 'privileged'; allReasons.push('sudo'); }

    return {
      category: worstCat, confidence, reasons: allReasons,
      hasPipe, hasRedirect, hasChain, hasSubshell, hasSudo,
      detectedCommands: [...new Set(allCmds)],
      riskLevel: this.risk(worstCat, hasSudo),
    };
  }

  private classifySegment(seg: string): { category: CommandCategory; confidence: number; reasons: string[]; commands: string[] } {
    const tokens = seg.split(/\s+/);
    const cmd = tokens[0]; const a1 = tokens[1] ?? '';
    if (!cmd) return { category: 'unknown', confidence: 0, reasons: [], commands: [] };

    if (READ_ONLY_COMMANDS.has(cmd))
      return { category: 'read_only', confidence: 0.95, reasons: [`${cmd} read-only`], commands: [cmd] };

    if (cmd === 'git') {
      if (READ_ONLY_GIT.has(a1)) return { category: 'read_only', confidence: 0.95, reasons: [`git ${a1} read-only`], commands: ['git'] };
      if (['push','pull','fetch','clone'].includes(a1)) return { category: 'network', confidence: 0.9, reasons: [`git ${a1} network`], commands: ['git'] };
      if (a1 === 'reset' && seg.includes('--hard')) return { category: 'destructive', confidence: 0.95, reasons: ['git reset --hard'], commands: ['git'] };
      if (a1 === 'clean' && /-[a-z]*f/.test(seg)) return { category: 'destructive', confidence: 0.95, reasons: ['git clean -f'], commands: ['git'] };
      return { category: 'write_local', confidence: 0.8, reasons: [`git ${a1}`], commands: ['git'] };
    }

    if (cmd === 'npm' || cmd === 'yarn' || cmd === 'pnpm') {
      if (READ_ONLY_NPM.has(a1)) return { category: 'read_only', confidence: 0.95, reasons: [`${cmd} ${a1} read-only`], commands: [cmd] };
      if (['install','i','add','update'].includes(a1)) return { category: 'write_local', confidence: 0.9, reasons: [`${cmd} ${a1}`], commands: [cmd] };
      if (['uninstall','remove','rm'].includes(a1)) return { category: 'destructive', confidence: 0.9, reasons: [`${cmd} ${a1}`], commands: [cmd] };
      if (a1 === 'publish') return { category: 'write_remote', confidence: 0.95, reasons: [`${cmd} publish`], commands: [cmd] };
    }

    if (DESTRUCTIVE_COMMANDS.has(cmd)) {
      const crit = cmd === 'rm' && /-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/.test(seg);
      return { category: 'destructive', confidence: crit ? 0.99 : 0.95, reasons: [`${cmd}${crit?' -rf':''}`], commands: [cmd] };
    }
    if (NETWORK_COMMANDS.has(cmd)) return { category: 'network', confidence: 0.95, reasons: [cmd], commands: [cmd] };
    if (PRIVILEGED_COMMANDS.has(cmd)) return { category: 'privileged', confidence: 0.99, reasons: [cmd], commands: [cmd] };
    if (['mv','cp','mkdir','touch','chmod','chown'].includes(cmd)) return { category: 'write_local', confidence: 0.85, reasons: [cmd], commands: [cmd] };

    return { category: 'unknown', confidence: 0.5, reasons: [`unknown: ${cmd}`], commands: [cmd] };
  }

  private risk(cat: CommandCategory, sudo: boolean): 'low'|'medium'|'high'|'critical' {
    if (sudo || cat === 'privileged') return 'critical';
    if (cat === 'destructive' || cat === 'write_remote') return 'high';
    if (cat === 'write_local' || cat === 'network') return 'medium';
    return 'low';
  }

  isReadOnly(command: string): boolean { return this.classify(command).category === 'read_only'; }
  isDestructive(command: string): boolean { const c = this.classify(command).category; return c === 'destructive' || c === 'privileged'; }
}
