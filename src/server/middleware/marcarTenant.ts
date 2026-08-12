/**
 * marcarTenant.ts — leva o tenant da requisicao pro AsyncLocalStorage.
 *
 * O `tenantAuth` ja resolve quem e o cliente e guarda no contexto do Hono,
 * mas o contexto do Hono so alcanca quem recebe o `c` — e o motor de IA fica
 * cinco camadas abaixo, em codigo que nao conhece HTTP.
 *
 * Este middleware existe como peca separada, e nao como mais um `c.set` dentro
 * do tenantAuth, por um motivo: o tenantAuth tem cinco `return next()`
 * diferentes (sessao de usuario, chave de API, sessao de admin, guard do Clow,
 * rotas puladas). Marcar em cada um seria cinco lugares pra esquecer um. Aqui
 * e um so, depois de todos eles, lendo o resultado de qualquer caminho.
 */
import { comTenant } from '../../api/contextoTenant.js';
import type { Context, Next } from 'hono';

export async function marcarTenant(c: Context, next: Next): Promise<void> {
  const tenantId = (c as any).get?.('tenantId') as string | undefined;
  const authMode = (c as any).get?.('authMode') as string | undefined;

  // Sem tenant (rota publica, health, webhook antes de resolver o canal) segue
  // sem marca: quem precisar de credencial vai falhar com "conecte sua chave",
  // que e a mensagem certa, em vez de pegar a chave de outra pessoa.
  if (!tenantId) {
    await next();
    return;
  }

  await comTenant({ tenantId, ehAdmin: authMode === 'admin_session' }, () => next());
}
