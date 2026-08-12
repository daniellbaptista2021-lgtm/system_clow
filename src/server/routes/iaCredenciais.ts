/**
 * iaCredenciais.ts — rotas da chave de IA do cliente (BYOK).
 *
 * Contrato de seguranca desta rota, e vale pra qualquer coisa que venha a ser
 * acrescentada aqui: **a chave nunca sai daqui pro navegador.** O GET devolve
 * a mascara; nao existe endpoint que leia a chave de volta. Quem quiser trocar,
 * digita a nova — recuperar a antiga nao e caso de uso de ninguem exceto de
 * quem roubou a sessao.
 *
 * O tenant vem SEMPRE do contexto autenticado, nunca do corpo do pedido.
 * Aceitar `tenantId` do cliente deixaria qualquer um gravar credencial na
 * conta alheia — ou, pior, ler a mascara da chave de outro.
 */
import { Hono } from 'hono';
import {
  PROVEDORES,
  obterCredencialPublica,
  salvarCredencial,
  removerCredencial,
  validarCredencial,
  acharProvedor,
} from '../../tenancy/aiCredentials.js';
import { logger } from '../../utils/logger.js';
import type { Context } from 'hono';

function tenantDa(c: Context): string | null {
  const t = (c as any).get?.('tenantId') as string | undefined;
  return t || null;
}

export function buildIaCredenciaisRoutes(): Hono {
  const app = new Hono();

  /** Catalogo de provedores — alimenta o seletor da tela. */
  app.get('/provedores', (c) =>
    c.json({
      provedores: PROVEDORES.map((p) => ({
        id: p.id,
        label: p.label,
        modelSugerido: p.modelSugerido,
        ajuda: p.ajuda,
        precisaUrl: p.id === 'custom',
      })),
    }),
  );

  // Caminhos nomeados de proposito (`/estado`, `/conectar`, `/desconectar`) em
  // vez de um `/` que muda de verbo. Montar o recurso na raiz do grupo faz o
  // roteador tratar `/v1/ia-credenciais` e `/v1/ia-credenciais/` como coisas
  // diferentes — 404 conforme a barra final, que e um bug chato de achar e que
  // ja apareceu aqui na primeira tentativa.

  /** Estado atual — mascara, modelos e ultimo resultado. Sem segredo. */
  app.get('/estado', (c) => {
    const tenantId = tenantDa(c);
    if (!tenantId) return c.json({ error: 'sem_tenant' }, 401);
    const atual = obterCredencialPublica(tenantId);
    return c.json({ conectado: !!atual, credencial: atual });
  });

  /**
   * Testa a chave sem gravar. Serve o botao "testar" da tela: o cliente
   * descobre que errou ANTES de salvar, em vez de descobrir quando o primeiro
   * lead mandar mensagem e o agente ficar mudo.
   */
  app.post('/testar', async (c) => {
    const tenantId = tenantDa(c);
    if (!tenantId) return c.json({ error: 'sem_tenant' }, 401);
    const corpo = await c.req.json().catch(() => ({}));
    const { provider, apiKey, baseUrl } = corpo as any;
    if (!provider || !apiKey) return c.json({ ok: false, erro: 'Informe o provedor e a chave.' }, 400);
    const r = await validarCredencial(provider, apiKey, baseUrl);
    // Devolve ate 200 modelos: com a lista em maos, a tela vira um seletor em
    // vez de um campo de texto onde errar o nome do modelo e o padrao.
    return c.json({ ok: r.ok, erro: r.erro, modelos: r.modelos?.slice(0, 200) });
  });

  /** Grava (ou troca) a credencial. Valida antes — gravar chave quebrada
   *  so adia o erro pro pior momento possivel. */
  app.put('/conectar', async (c) => {
    const tenantId = tenantDa(c);
    if (!tenantId) return c.json({ error: 'sem_tenant' }, 401);
    const corpo = await c.req.json().catch(() => ({}));
    const { provider, apiKey, model, crmModel, baseUrl, pularTeste } = corpo as any;
    if (!provider || !apiKey) {
      return c.json({ error: 'dados_incompletos', message: 'Informe o provedor e a chave.' }, 400);
    }
    if (!acharProvedor(provider)) {
      return c.json({ error: 'provedor_desconhecido' }, 400);
    }
    if (!pularTeste) {
      const teste = await validarCredencial(provider, apiKey, baseUrl);
      if (!teste.ok) {
        return c.json({ error: 'chave_recusada', message: teste.erro }, 400);
      }
    }
    try {
      const publica = salvarCredencial({ tenantId, provider, apiKey, model, crmModel, baseUrl });
      return c.json({ ok: true, credencial: publica });
    } catch (e: any) {
      logger.error(`[byok] falha ao gravar credencial do tenant ${tenantId}: ${e?.message}`);
      return c.json({ error: 'falha_ao_gravar', message: e?.message }, 400);
    }
  });

  /** Desconecta. O agente daquele cliente para — de proposito, e a tela avisa. */
  app.delete('/desconectar', (c) => {
    const tenantId = tenantDa(c);
    if (!tenantId) return c.json({ error: 'sem_tenant' }, 401);
    removerCredencial(tenantId);
    return c.json({ ok: true });
  });

  return app;
}
