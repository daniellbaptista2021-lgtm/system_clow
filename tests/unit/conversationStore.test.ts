import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe.sequential('conversationStore', () => {
  const originalHome = process.env.CLOW_HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'evox-conversations-'));
  let storage: typeof import('../../src/utils/session/sessionStorage.js');
  let store: typeof import('../../src/server/conversationStore.js');

  beforeAll(async () => {
    process.env.CLOW_HOME = testHome;
    vi.resetModules();
    storage = await import('../../src/utils/session/sessionStorage.js');
    store = await import('../../src/server/conversationStore.js');

    await storage.saveSessionMetadataForSession('session-a', 'session_start', {
      tenantId: 'tenant-a', cwd: '/tmp/a', createdAt: 100,
    });
    await storage.recordTranscriptForSession('session-a', 'user', 'Planeje minhas vendas');
    await storage.recordTranscriptForSession('session-a', 'assistant', 'Claro, vamos começar.');

    await storage.saveSessionMetadataForSession('session-b', 'session_start', {
      tenantId: 'tenant-b', cwd: '/tmp/b', createdAt: 200,
    });
    await storage.recordTranscriptForSession('session-b', 'user', 'Segredo de outro cliente');
    await storage.flushSession();
  });

  afterAll(async () => {
    await storage.deleteSessionTranscript('session-a');
    await storage.deleteSessionTranscript('session-b');
    if (originalHome === undefined) delete process.env.CLOW_HOME;
    else process.env.CLOW_HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('lista somente as conversas do próprio cliente', async () => {
    const conversations = await store.listTenantConversations('tenant-a');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: 'session-a',
      title: 'Planeje minhas vendas',
      messageCount: 2,
      pinned: false,
    });
  });

  it('renomeia e fixa de forma permanente', async () => {
    await store.updateTenantConversation('tenant-a', 'session-a', {
      title: 'Plano comercial',
      pinned: true,
    });
    await storage.flushSession();

    const result = await store.getTenantConversation('tenant-a', 'session-a');
    expect(result?.conversation).toMatchObject({ title: 'Plano comercial', pinned: true });
    expect(result?.messages.map((message) => message.text)).toEqual([
      'Planeje minhas vendas',
      'Claro, vamos começar.',
    ]);
  });

  it('impede ler ou apagar conversa de outro cliente', async () => {
    expect(await store.getTenantConversation('tenant-a', 'session-b')).toBeNull();
    expect(await store.deleteTenantConversation('tenant-a', 'session-b')).toBe(false);
    expect(await store.getTenantConversation('tenant-b', 'session-b')).not.toBeNull();
  });
});
