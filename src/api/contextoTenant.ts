/**
 * contextoTenant.ts — quem e o cliente da chamada em curso.
 *
 * O motor de IA precisa saber de qual tenant e a credencial, mas `callModel`
 * e chamado de 15 lugares (QueryEngine, sessionPool, compactacao, missoes,
 * hooks de memoria, WebFetch...) e varios deles estao fundo numa pilha que
 * nao tem nada a ver com multi-tenancy. Enfiar um `tenantId` em cada
 * assinatura contaminaria o codebase inteiro pra carregar um dado que so o
 * fim da linha usa.
 *
 * AsyncLocalStorage resolve isso: quem abre o trabalho (a sessao, o webhook,
 * a rota) marca o tenant uma vez, e qualquer profundidade da pilha assincrona
 * enxerga a marca. Nao vaza entre requisicoes concorrentes — cada `run` tem
 * seu proprio armazenamento, que e exatamente a garantia que um `let` global
 * NAO daria num servidor com varios clientes ao mesmo tempo.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ContextoTenant {
  tenantId: string;
  ehAdmin?: boolean;
}

const armazenamento = new AsyncLocalStorage<ContextoTenant>();

/** Roda `fn` marcando o tenant. Tudo que ela chamar enxerga a marca. */
export function comTenant<T>(ctx: ContextoTenant, fn: () => T): T {
  return armazenamento.run(ctx, fn);
}

/** Tenant da chamada em curso, ou undefined fora de um `comTenant`. */
export function tenantAtual(): ContextoTenant | undefined {
  return armazenamento.getStore();
}
