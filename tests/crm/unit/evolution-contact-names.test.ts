import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
process.env.CRM_DB_PATH = `/tmp/clow-contact-names-${randomUUID()}.db`;

describe('agenda do WhatsApp', () => {
  let sync: any, store: any;
  const channel: any = { id: 'channel', tenantId: 'agenda', type: 'evolution' };
  beforeAll(async () => {
    sync = await import('../../../src/crm/channels/evolutionSync.js');
    store = await import('../../../src/crm/store.js');
  });
  it('importa nomes salvos sem criar cards, repete sem duplicar e aceita renomeação', () => {
    const entry = { remoteJid: '5521999991111@s.whatsapp.net', pushName: 'Ana Agenda', isSaved: true };
    expect(sync.applyContactNames(channel, [entry])).toBe(1);
    expect(sync.applyContactNames(channel, [entry])).toBe(0);
    const contact = store.findContactByPhone('agenda', '5521999991111');
    expect(contact.name).toBe('Ana Agenda');
    expect(store.listActivitiesByContact('agenda', contact.id)).toHaveLength(0);
    expect(sync.applyContactNames(channel, [{ ...entry, pushName: 'Ana Atualizada' }])).toBe(1);
    expect(store.findContactByPhone('agenda', '5521999991111').name).toBe('Ana Atualizada');
  });
  it('pushName de mensagem não troca nome da agenda e outros tenants ficam separados', () => {
    store.upsertContactByPhone('agenda', '5521999991111', { name: 'Nome Perfil' });
    expect(store.findContactByPhone('agenda', '5521999991111').name).toBe('Ana Atualizada');
    const c = store.createContact('outro', { name: 'Outra pessoa', phone: '5521999991111' });
    sync.applyContactNames(channel, [{ remoteJid: '5521999991111@s.whatsapp.net', name: 'Ana Nova' }]);
    expect(store.getContact('outro', c.id).name).toBe('Outra pessoa');
  });
  it('ignora LIDs, grupos, nome vazio e perfis fora da agenda sem criar contatos falsos', () => {
    expect(sync.applyContactNames(channel, [
      { remoteJid: '5521888881111@lid', name: 'LID' },
      { remoteJid: '5521888881111@g.us', name: 'Grupo' },
      { remoteJid: '5521888881111@s.whatsapp.net', pushName: 'Perfil', isSaved: false },
      { remoteJid: '5521888881111@s.whatsapp.net', name: '  ', isSaved: true },
    ])).toBe(0);
    expect(store.findContactByPhone('agenda', '5521888881111')).toBeNull();
  });
});
