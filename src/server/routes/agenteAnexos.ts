/**
 * agenteAnexos.ts — arquivos e áudio mandados para o Agente IA.
 *
 * A rota de mensagens do agente só aceita texto. Em vez de mexer nela, o
 * arquivo vai para a pasta da conta (`anexos/`), que é a mesma que as
 * ferramentas Read/Write/Bash do agente enxergam — no slot ela aparece em
 * /workspace. A tela então avisa na mensagem qual arquivo foi anexado, e o
 * agente o abre com as próprias ferramentas (imagem, PDF, planilha, texto).
 *
 * O áudio não vira arquivo para o agente: é transcrito pelo mesmo
 * `transcribeAudio` que atende os áudios do WhatsApp, e a tela manda o texto.
 *
 * O tenant vem SEMPRE do contexto autenticado, nunca do corpo do pedido.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import * as fs from 'fs';
import * as path from 'path';
import { getTenantWorkspaceDir } from '../../tenancy/bashSandbox.js';
import { logger } from '../../utils/logger.js';

const LIMITE_ARQUIVO = 20 * 1024 * 1024;
const LIMITE_AUDIO = 15 * 1024 * 1024;

function tenantDa(c: Context): string | null {
  const t = (c as any).get?.('tenantId') as string | undefined;
  return t || null;
}

/** Nome seguro: sem pasta, sem caracteres estranhos, com a extensão original. */
export function nomeSeguro(original: string): string {
  const base = path.basename(String(original || 'arquivo')).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const raiz = path.basename(base, path.extname(base)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'arquivo';
  return raiz + ext;
}

function decodificar(dados: unknown): Buffer | null {
  const s = String(dados || '');
  const m = /^data:[^;,]*(?:;[^,]*)?;base64,(.+)$/s.exec(s);
  try { return Buffer.from(m ? m[1] : s, 'base64'); } catch { return null; }
}

export function buildAgenteAnexosRoutes(): Hono {
  const app = new Hono();

  app.post('/anexo', async (c) => {
    const tenantId = tenantDa(c);
    if (!tenantId) return c.json({ error: 'sem_tenant' }, 401);
    const corpo = await c.req.json().catch(() => ({} as any));
    const bytes = decodificar(corpo?.dados);
    if (!bytes || !bytes.length) return c.json({ error: 'arquivo_vazio', message: 'O arquivo chegou vazio.' }, 400);
    if (bytes.length > LIMITE_ARQUIVO) return c.json({ error: 'arquivo_grande', message: 'O arquivo passa de 20 MB.' }, 413);
    const pasta = path.join(getTenantWorkspaceDir(tenantId), 'anexos');
    fs.mkdirSync(pasta, { recursive: true });
    const nome = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}-${nomeSeguro(corpo?.nome)}`;
    fs.writeFileSync(path.join(pasta, nome), bytes);
    logger.info(`[agente] anexo recebido tenant=${tenantId} ${nome} (${bytes.length} bytes)`);
    return c.json({ ok: true, caminho: `anexos/${nome}`, tamanho: bytes.length });
  });

  app.post('/audio', async (c) => {
    const tenantId = tenantDa(c);
    if (!tenantId) return c.json({ error: 'sem_tenant' }, 401);
    const corpo = await c.req.json().catch(() => ({} as any));
    const dados = String(corpo?.dados || '');
    if (!/^data:audio\//.test(dados)) return c.json({ error: 'audio_invalido', message: 'Isso não parece um áudio.' }, 400);
    if (dados.length > LIMITE_AUDIO * 1.4) return c.json({ error: 'audio_grande', message: 'O áudio é longo demais.' }, 413);
    const { transcribeAudio } = await import('../../crm/ai/agent.js');
    const texto = (await transcribeAudio(dados)).trim();
    if (!texto) return c.json({ error: 'sem_texto', message: 'Não consegui entender o áudio. Tente falar de novo, mais perto do microfone.' }, 422);
    return c.json({ ok: true, texto });
  });

  return app;
}
