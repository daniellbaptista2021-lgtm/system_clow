/**
 * Locks dos agentes de coluna — escopo por tenant e lock de execucao por card.
 *
 * Cobre as correcoes de race condition multi-worker:
 *   1. buildLockKey inclui tenantId (messageIds identicos de tenants
 *      diferentes nao podem compartilhar o mesmo lock de dedupe).
 *   2. buildCardRunLockKey serializa execucoes por card (fire de inatividade
 *      nao roda em paralelo com mensagem inbound do mesmo card).
 *   3. clusterStore.del libera o lock antes do TTL (release no finally).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildLockKey,
  buildCardRunLockKey,
  type RunColumnAgentInput,
} from '../../../src/crm/agents/columnAgentRunner.js';
import { getCluster, _resetClusterStoreForTests } from '../../../src/utils/clusterStore.js';

function inputFor(tenantId: string, messageId?: string): RunColumnAgentInput {
  return {
    channel: { tenantId } as any,
    card: { id: 'card-1' } as any,
    column: { id: 'col-1' } as any,
    customerPhone: '5511999990000',
    messageId,
  };
}

afterEach(async () => {
  await _resetClusterStoreForTests();
});

describe('buildLockKey', () => {
  it('escopa o lock de messageId por tenant', () => {
    const a = buildLockKey(inputFor('tenant-a', 'MSG123'));
    const b = buildLockKey(inputFor('tenant-b', 'MSG123'));
    expect(a).not.toBe(b);
    expect(a).toContain('tenant-a');
    expect(b).toContain('tenant-b');
  });

  it('fallback sem messageId continua escopado por tenant + phone', () => {
    const key = buildLockKey(inputFor('tenant-a'));
    expect(key).toContain('tenant-a');
    expect(key).toContain('5511999990000');
  });
});

describe('buildCardRunLockKey', () => {
  it('e unico por tenant + card', () => {
    expect(buildCardRunLockKey('t1', 'c1')).not.toBe(buildCardRunLockKey('t2', 'c1'));
    expect(buildCardRunLockKey('t1', 'c1')).not.toBe(buildCardRunLockKey('t1', 'c2'));
    expect(buildCardRunLockKey('t1', 'c1')).toBe(buildCardRunLockKey('t1', 'c1'));
  });
});

describe('clusterStore.del (release de lock)', () => {
  it('setNxEx segura o lock ate del liberar', async () => {
    const cluster = await getCluster();
    const key = buildCardRunLockKey('t1', 'c1');

    expect(await cluster.setNxEx(key, '1', 60)).toBe(true);
    // Segundo worker nao adquire enquanto o lock vive
    expect(await cluster.setNxEx(key, '1', 60)).toBe(false);

    await cluster.del(key);
    // Liberado antes do TTL — proximo run adquire na hora
    expect(await cluster.setNxEx(key, '1', 60)).toBe(true);
  });
});
