/**
 * slotConta.ts — o "slot" de cada conta: uma maquina Linux propria onde o
 * terminal do Agente IA roda, como no Territorio Proprio.
 *
 * Por que (29/10/2026): no servidor de producao o Bash das contas rodava cru,
 * como root, no host — sem bwrap nem firejail instalados, a caixa que o codigo
 * prometia nao existia. Para o EVOX, cada conta ganha a sua maquina, e o agente
 * pode fazer tudo nela (curl na Meta, scripts, instalar ferramentas) sem nunca
 * encostar no servidor do CRM nem nas outras contas.
 *
 * Prototipo no Mac: o `container` da Apple (uma micro-VM por conta). Em
 * producao o mesmo papel cabe a um container Incus — esta e a unica parte que
 * muda, por isso tudo que fala com a ferramenta mora aqui.
 *
 * A pasta da conta (a mesma que as ferramentas Read/Write usam) entra no slot
 * em /workspace. O resto da maquina e do slot: some se ele for recriado.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

const CLI = process.env.EVOX_SLOT_CLI || '/usr/local/bin/container';
const IMAGEM = process.env.EVOX_SLOT_IMAGEM || 'evox-slot:1';
const MEMORIA = process.env.EVOX_SLOT_MEMORIA || '1G';
const CPUS = process.env.EVOX_SLOT_CPUS || '2';
export const PASTA_NO_SLOT = '/workspace';

/** Slots ligados pela configuracao E com a ferramenta presente. Sem isto o
 *  terminal das contas fica desligado — nunca cai para rodar no servidor. */
export function slotsDisponiveis(): boolean {
  return process.env.EVOX_SLOTS === 'container' && fs.existsSync(CLI);
}

export function nomeDoSlot(tenantId: string): string {
  const limpo = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  if (!limpo) throw new Error('conta sem id valido para o slot');
  return `evox-${limpo}`;
}

// Um slot leva ~11s para nascer. Dois comandos da mesma conta ao mesmo tempo
// nao podem tentar criar o mesmo slot duas vezes.
const emPreparo = new Map<string, Promise<string>>();
const prontoAte = new Map<string, number>();
const VALIDADE_MS = 30_000;

async function estado(nome: string): Promise<'running' | 'stopped' | 'ausente'> {
  try {
    const { stdout } = await exec(CLI, ['inspect', nome], { timeout: 15_000 });
    const info = JSON.parse(stdout);
    const s = String((Array.isArray(info) ? info[0] : info)?.status || '').toLowerCase();
    return s === 'running' ? 'running' : 'stopped';
  } catch {
    return 'ausente';
  }
}

export async function garantirSlot(tenantId: string, pastaDaConta: string): Promise<string> {
  const nome = nomeDoSlot(tenantId);
  if ((prontoAte.get(nome) || 0) > Date.now()) return nome;
  const andamento = emPreparo.get(nome);
  if (andamento) return andamento;

  const p = (async () => {
    fs.mkdirSync(pastaDaConta, { recursive: true });
    const s = await estado(nome);
    if (s === 'stopped') {
      await exec(CLI, ['start', nome], { timeout: 120_000 });
    } else if (s === 'ausente') {
      await exec(CLI, [
        'run', '-d', '--name', nome,
        '-m', MEMORIA, '-c', CPUS,
        '-v', `${path.resolve(pastaDaConta)}:${PASTA_NO_SLOT}`,
        '-w', PASTA_NO_SLOT,
        IMAGEM, 'sleep', 'infinity',
      ], { timeout: 180_000 });
    }
    prontoAte.set(nome, Date.now() + VALIDADE_MS);
    return nome;
  })();
  emPreparo.set(nome, p);
  try {
    return await p;
  } finally {
    emPreparo.delete(nome);
  }
}

/** Caminho do host dentro da pasta da conta → o mesmo caminho dentro do slot. */
export function caminhoNoSlot(cwdHost: string, pastaDaConta: string): string {
  const rel = path.relative(path.resolve(pastaDaConta), path.resolve(cwdHost));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return PASTA_NO_SLOT;
  return path.posix.join(PASTA_NO_SLOT, ...rel.split(path.sep));
}

const aspas = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Linha de shell que roda o comando DENTRO do slot. O ambiente do servidor
 *  (chaves de API, segredos do .env) nao entra: `container exec` so leva o
 *  que for passado com -e, e aqui nada e passado. */
export function comandoNoSlot(nome: string, comando: string, cwdNoSlot: string): string {
  return `${aspas(CLI)} exec -w ${aspas(cwdNoSlot)} ${aspas(nome)} bash -lc ${aspas(comando)}`;
}
