import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { podeUsarTerminal } from '../../src/tenancy/terminalPermitido.js';

// 29/10/2026: sem bwrap/firejail na maquina, o Bash de qualquer conta rodava
// como root no host. Terminal, ganchos e plugins do workspace ficaram so para
// as contas da lista CLOW_TERMINAL_TENANTS.

const RAIZ = path.resolve(__dirname, '../..');
const ler = (p: string) => fs.readFileSync(path.join(RAIZ, p), 'utf8');

describe('terminal so para contas liberadas', () => {
  const antes = process.env.CLOW_TERMINAL_TENANTS;
  afterEach(() => { process.env.CLOW_TERMINAL_TENANTS = antes; });

  it('lista vazia: nenhum cliente tem terminal', () => {
    delete process.env.CLOW_TERMINAL_TENANTS;
    expect(podeUsarTerminal('t-cliente')).toBe(false);
  });

  it('so a conta da lista passa, com espaco e tudo', () => {
    process.env.CLOW_TERMINAL_TENANTS = ' t-dono , t-outro ';
    expect(podeUsarTerminal('t-dono')).toBe(true);
    expect(podeUsarTerminal('t-cliente')).toBe(false);
  });

  it('admin_session sempre passa', () => {
    delete process.env.CLOW_TERMINAL_TENANTS;
    expect(podeUsarTerminal('t-qualquer', true)).toBe(true);
  });

  it('a sessao tira o Bash e le ganchos/plugins de pasta vazia para quem nao pode', () => {
    const pool = ler('src/server/sessionPool.ts');
    expect(pool).toMatch(/terminal \|\| slotsDisponiveis\(\) \|\| tool\.name !== 'Bash'/);
    expect(pool).toMatch(/pluginSystem\.initialize\(configRoot\)/);
    expect(pool).toMatch(/hookEngine\.initialize\(configRoot, false\)/);
    expect(pool).not.toMatch(/pluginSystem\.initialize\(workspaceRoot\)/);
    expect(pool).not.toMatch(/hookEngine\.initialize\(workspaceRoot/);
  });

  it('o BashTool recusa sozinho, na validacao e na execucao', () => {
    const bash = ler('src/tools/BashTool/BashTool.ts');
    expect(bash.match(/!podeUsarTerminal\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
