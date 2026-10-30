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
 * Dois motores, escolhidos por EVOX_SLOTS:
 *  - `container`: o `container` da Apple (uma micro-VM por conta), no Mac;
 *  - `incus`: um container Incus por conta, na VPS. O servidor do EVOX roda
 *    dentro de um container Incus (o tamanho de 2 slots na tp2) e os slots das
 *    contas nascem DENTRO dele (Incus aninhado): tudo cabe naquele teto.
 * Tudo que fala com a ferramenta mora aqui.
 *
 * A pasta da conta (a mesma que as ferramentas Read/Write usam) entra no slot
 * em /workspace. O resto da maquina e do slot: some se ele for recriado.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

const MOTOR = process.env.EVOX_SLOTS === 'incus' ? 'incus' : 'container';
const CLI = process.env.EVOX_SLOT_CLI || (MOTOR === 'incus' ? '/usr/bin/incus' : '/usr/local/bin/container');
const IMAGEM = process.env.EVOX_SLOT_IMAGEM || (MOTOR === 'incus' ? 'evox-slot' : 'evox-slot:1');
const MEMORIA = process.env.EVOX_SLOT_MEMORIA || '1G';
const CPUS = process.env.EVOX_SLOT_CPUS || '2';
/** Incus: o "root" dos slots é este usuário do lado de fora (faixa de
 *  /etc/subuid do container do EVOX). A pasta da conta precisa ser dele para
 *  o slot conseguir escrever — o kernel do aninhado não faz o ajuste sozinho. */
const DONO_NO_HOST = Number(process.env.EVOX_SLOT_UID || 100000);
export const PASTA_NO_SLOT = '/workspace';

/** Slots ligados pela configuracao E com a ferramenta presente. Sem isto o
 *  terminal das contas fica desligado — nunca cai para rodar no servidor. */
export function slotsDisponiveis(): boolean {
  return (process.env.EVOX_SLOTS === 'container' || process.env.EVOX_SLOTS === 'incus') && fs.existsSync(CLI);
}

/** "1G" (formato do container da Apple) → "1GiB" (formato do Incus). */
const memoriaIncus = (m: string) => m.replace(/^(\d+)\s*G(i?B)?$/i, '$1GiB').replace(/^(\d+)\s*M(i?B)?$/i, '$1MiB');

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
  if (MOTOR === 'incus') {
    try {
      const { stdout } = await exec(CLI, ['list', `^${nome}$`, '--format', 'json'], { timeout: 15_000 });
      const info = JSON.parse(stdout)[0];
      if (!info) return 'ausente';
      return String(info.status || '').toLowerCase() === 'running' ? 'running' : 'stopped';
    } catch {
      return 'ausente';
    }
  }
  try {
    const { stdout } = await exec(CLI, ['inspect', nome], { timeout: 15_000 });
    const info = JSON.parse(stdout);
    const s = String((Array.isArray(info) ? info[0] : info)?.status || '').toLowerCase();
    return s === 'running' ? 'running' : 'stopped';
  } catch {
    return 'ausente';
  }
}

// O serviço de containers da Apple não volta sozinho depois de reiniciar o
// Mac. Desligado, `inspect` falha como se o slot não existisse, o `run` falha
// também, e o Agente IA fica sem terminal sem dizer por quê (30/10/2026).
let sistema: Promise<void> | null = null;
let sistemaConferidoAte = 0;
export function garantirSistema(): Promise<void> {
  // Confere de novo a cada minuto: o serviço pode cair com o Mac ligado.
  if (MOTOR === 'incus') return Promise.resolve(); // o incusd é serviço do sistema
  if (!sistema || Date.now() > sistemaConferidoAte) {
    sistemaConferidoAte = Date.now() + 60_000;
    sistema = (async () => {
      try {
        const { stdout } = await exec(CLI, ['system', 'status'], { timeout: 15_000 });
        if (/status\s+running/i.test(stdout)) return;
      } catch { /* desligado: o status sai com erro */ }
      // O kernel já foi instalado na primeira vez; sem a flag, o start fica
      // esperando uma resposta no terminal que não existe.
      await exec(CLI, ['system', 'start', '--disable-kernel-install'], { timeout: 180_000 });
    })().catch((e) => { sistema = null; throw e; });
  }
  return sistema;
}

export async function garantirSlot(tenantId: string, pastaDaConta: string): Promise<string> {
  const nome = nomeDoSlot(tenantId);
  if ((prontoAte.get(nome) || 0) > Date.now()) return nome;
  const andamento = emPreparo.get(nome);
  if (andamento) return andamento;

  const p = (async () => {
    await garantirSistema();
    fs.mkdirSync(pastaDaConta, { recursive: true });
    const s = await estado(nome);
    if (MOTOR === 'incus') {
      // Arquivos que o servidor gravou (anexos, áudios) nascem do root daqui e
      // o slot só os leria. Ao ligar o slot, a pasta inteira volta a ser dele.
      if (s !== 'running') {
        await exec('chown', ['-R', `${DONO_NO_HOST}:${DONO_NO_HOST}`, path.resolve(pastaDaConta)], { timeout: 60_000 }).catch(() => {});
      }
      if (s === 'ausente') {
        await exec(CLI, [
          'launch', IMAGEM, nome,
          '-c', `limits.memory=${memoriaIncus(MEMORIA)}`, '-c', 'limits.memory.enforce=hard',
          '-c', `limits.cpu=${CPUS}`, '-c', 'boot.autostart=true',
        ], { timeout: 180_000 });
        await exec(CLI, ['config', 'device', 'add', nome, 'workspace', 'disk',
          `source=${path.resolve(pastaDaConta)}`, `path=${PASTA_NO_SLOT}`], { timeout: 60_000 });
      } else if (s === 'stopped') {
        await exec(CLI, ['start', nome], { timeout: 120_000 });
      }
      prontoAte.set(nome, Date.now() + VALIDADE_MS);
      return nome;
    }
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
  if (MOTOR === 'incus') {
    // Sem --env: o ambiente do servidor (chaves) não entra no slot. Os
    // arquivos criados no slot já nascem do dono certo (root de lá = DONO_NO_HOST).
    return `${aspas(CLI)} exec ${aspas(nome)} --cwd ${aspas(cwdNoSlot)} -- bash -lc ${aspas(comando)}`;
  }
  return `${aspas(CLI)} exec -w ${aspas(cwdNoSlot)} ${aspas(nome)} bash -lc ${aspas(comando)}`;
}

/** Linha para o contexto do agente: a pasta do servidor aparece no terminal
 *  da conta como /workspace. Sem isto o agente via o caminho do servidor e
 *  tentava "cd" nele dentro do slot, onde não existe. */
export function avisoDoTerminal(cwd: string): string {
  const raiz = process.env.CLOW_WORKSPACES_DIR;
  if (!slotsDisponiveis() || !raiz) return '';
  const rel = path.relative(path.resolve(raiz), path.resolve(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return `Terminal (Bash): roda na maquina da conta; esta pasta la se chama ${PASTA_NO_SLOT}. Use ${PASTA_NO_SLOT} nos comandos, nunca o caminho acima.`;
}
