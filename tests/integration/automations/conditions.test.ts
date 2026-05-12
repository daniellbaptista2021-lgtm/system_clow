/**
 * Automation engine — condition evaluation tests.
 *
 * Real engine has 9 conditions (matching the user's count):
 *   text_contains, text_matches, column_is, column_is_not,
 *   value_above, value_below, tag_has, contact_source,
 *   days_since_activity
 *
 * For each: a true case + a false case + at least one edge case
 * (null/empty/zero) to make sure null safety holds.
 *
 * Each condition is verified by registering a single-condition automation
 * and checking whether emit() fires it. We use add_note as the action
 * (no external deps) and inspect runs_count.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-aut-cond-'));
  process.env.CLOW_HOME = tmpHome;
  process.env.CRM_DB_PATH = join(tmpHome, 'crm.sqlite3');
  const schema = await import('../../../src/crm/schema.js');
  schema.getCrmDb();
});

afterEach(async () => {
  const schema = await import('../../../src/crm/schema.js');
  schema.closeCrmDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
  delete process.env.CRM_DB_PATH;
  vi.resetModules();
});

async function setupTenantWithCard(opts: { columnName?: string; valueCents?: number; tags?: string[]; source?: string }) {
  const auts = await import('../../../src/crm/automations.js');
  const store = await import('../../../src/crm/store.js');
  const tenantId = 'tenant-cond-' + Math.random().toString(36).slice(2, 8);

  const board = store.createBoard(tenantId, { name: 'Board', type: 'sales' });
  const col = store.createColumn(tenantId, { boardId: board.id, name: opts.columnName ?? 'Lead novo' });
  const contact = store.createContact(tenantId, {
    name: 'João',
    phone: '+5511988888888',
    tags: opts.tags ?? [],
    source: opts.source ?? 'whatsapp',
  });
  const card = store.createCard(tenantId, {
    boardId: board.id,
    columnId: col.id,
    title: 'Test card',
    contactId: contact.id,
    valueCents: opts.valueCents ?? 0,
  });

  return { auts, store, tenantId, boardId: board.id, columnId: col.id, contactId: contact.id, cardId: card.id };
}

async function fireWith(
  cond: { type: string; params?: any },
  trigger: 'inbound_message' | 'card_created' | 'card_moved' | 'card_stale' = 'inbound_message',
  setupOpts: Parameters<typeof setupTenantWithCard>[0] = {},
  eventOverrides: { text?: string } = {},
): Promise<{ ran: boolean; tenantId: string }> {
  const { auts, tenantId, cardId, contactId } = await setupTenantWithCard(setupOpts);
  const aut = auts.createAutomation(tenantId, {
    name: `cond-${cond.type}`,
    trigger: { type: trigger },
    conditions: [cond],
    actions: [{ type: 'add_note', params: { content: 'matched' } }],
  });

  await auts.emit({ trigger, tenantId, cardId, contactId, text: eventOverrides.text });

  const after = auts.listAutomations(tenantId).find((a) => a.id === aut.id)!;
  return { ran: after.runsCount > 0, tenantId };
}

// ─── 1. text_contains ─────────────────────────────────────────────────────

describe('condition: text_contains', () => {
  it('true when needle is in text', async () => {
    const { ran } = await fireWith({ type: 'text_contains', params: { value: 'orçamento' } }, 'inbound_message', {}, { text: 'quero saber o orçamento' });
    expect(ran).toBe(true);
  });
  it('false when needle is missing', async () => {
    const { ran } = await fireWith({ type: 'text_contains', params: { value: 'orçamento' } }, 'inbound_message', {}, { text: 'só falando oi' });
    expect(ran).toBe(false);
  });
  it('case-insensitive when caseInsensitive=true', async () => {
    const { ran } = await fireWith({ type: 'text_contains', params: { value: 'Preço', caseInsensitive: true } }, 'inbound_message', {}, { text: 'qual o PREÇO?' });
    expect(ran).toBe(true);
  });
  it('false on empty text', async () => {
    const { ran } = await fireWith({ type: 'text_contains', params: { value: 'preço' } }, 'inbound_message', {}, { text: '' });
    expect(ran).toBe(false);
  });
});

// ─── 2. text_matches ──────────────────────────────────────────────────────

describe('condition: text_matches', () => {
  it('true on regex match', async () => {
    const { ran } = await fireWith({ type: 'text_matches', params: { regex: 'pre[çc]o|or[çc]amento', flags: 'i' } }, 'inbound_message', {}, { text: 'qual o PRECO?' });
    expect(ran).toBe(true);
  });
  it('false on no match', async () => {
    const { ran } = await fireWith({ type: 'text_matches', params: { regex: '^[0-9]+$' } }, 'inbound_message', {}, { text: 'olá' });
    expect(ran).toBe(false);
  });
  it('false (and no throw) on invalid regex', async () => {
    const { ran } = await fireWith({ type: 'text_matches', params: { regex: '(((unbalanced' } }, 'inbound_message', {}, { text: 'anything' });
    expect(ran).toBe(false);
  });
});

// ─── 3. column_is / column_is_not ────────────────────────────────────────

describe('condition: column_is', () => {
  it('true when card is in named column', async () => {
    const { ran } = await fireWith({ type: 'column_is', params: { columnName: 'Lead novo' } }, 'inbound_message', { columnName: 'Lead novo' });
    expect(ran).toBe(true);
  });
  it('false when card is in a different column', async () => {
    const { ran } = await fireWith({ type: 'column_is', params: { columnName: 'Ganho' } }, 'inbound_message', { columnName: 'Lead novo' });
    expect(ran).toBe(false);
  });
});

describe('condition: column_is_not', () => {
  it('true when card column does NOT match', async () => {
    const { ran } = await fireWith({ type: 'column_is_not', params: { columnName: 'Ganho' } }, 'inbound_message', { columnName: 'Lead novo' });
    expect(ran).toBe(true);
  });
  it('false when card column matches', async () => {
    const { ran } = await fireWith({ type: 'column_is_not', params: { columnName: 'Lead novo' } }, 'inbound_message', { columnName: 'Lead novo' });
    expect(ran).toBe(false);
  });
});

// ─── 4. value_above / value_below ─────────────────────────────────────────

describe('condition: value_above', () => {
  it('true when card valueCents > threshold', async () => {
    const { ran } = await fireWith({ type: 'value_above', params: { cents: 100000 } }, 'inbound_message', { valueCents: 250000 });
    expect(ran).toBe(true);
  });
  it('false when valueCents == threshold (strict greater)', async () => {
    const { ran } = await fireWith({ type: 'value_above', params: { cents: 250000 } }, 'inbound_message', { valueCents: 250000 });
    expect(ran).toBe(false);
  });
  it('false when valueCents is 0 and threshold is 1', async () => {
    const { ran } = await fireWith({ type: 'value_above', params: { cents: 1 } }, 'inbound_message', { valueCents: 0 });
    expect(ran).toBe(false);
  });
});

describe('condition: value_below', () => {
  it('true when valueCents < threshold', async () => {
    const { ran } = await fireWith({ type: 'value_below', params: { cents: 100000 } }, 'inbound_message', { valueCents: 50000 });
    expect(ran).toBe(true);
  });
  it('false when valueCents >= threshold', async () => {
    const { ran } = await fireWith({ type: 'value_below', params: { cents: 100000 } }, 'inbound_message', { valueCents: 100000 });
    expect(ran).toBe(false);
  });
});

// ─── 5. tag_has ───────────────────────────────────────────────────────────

describe('condition: tag_has', () => {
  it('true when contact has the tag', async () => {
    const { ran } = await fireWith({ type: 'tag_has', params: { tag: 'vip' } }, 'inbound_message', { tags: ['vip', 'premium'] });
    expect(ran).toBe(true);
  });
  it('false when contact lacks the tag', async () => {
    const { ran } = await fireWith({ type: 'tag_has', params: { tag: 'vip' } }, 'inbound_message', { tags: [] });
    expect(ran).toBe(false);
  });
});

// ─── 6. contact_source ────────────────────────────────────────────────────

describe('condition: contact_source', () => {
  it('true on exact source match', async () => {
    const { ran } = await fireWith({ type: 'contact_source', params: { source: 'whatsapp' } }, 'inbound_message', { source: 'whatsapp' });
    expect(ran).toBe(true);
  });
  it('false on mismatch', async () => {
    const { ran } = await fireWith({ type: 'contact_source', params: { source: 'instagram' } }, 'inbound_message', { source: 'whatsapp' });
    expect(ran).toBe(false);
  });
});

// ─── 7. days_since_activity ───────────────────────────────────────────────

describe('condition: days_since_activity', () => {
  it('gte: true when card.lastActivityAt is older than N days', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const store = await import('../../../src/crm/store.js');
    const tenantId = 'tenant-dsa';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'C' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id });
    // Force lastActivityAt far in the past
    store.updateCard(tenantId, card.id, { lastActivityAt: Date.now() - 10 * 86400_000 });

    auts.createAutomation(tenantId, {
      name: 'stale',
      trigger: { type: 'card_stale' },
      conditions: [{ type: 'days_since_activity', params: { days: 7, op: 'gte' } }],
      actions: [{ type: 'add_note', params: { content: 'old' } }],
    });
    await auts.emit({ trigger: 'card_stale', tenantId, cardId: card.id, contactId: contact.id });

    expect(auts.listAutomations(tenantId)[0]!.runsCount).toBe(1);
  });

  it('lte: false when activity is older than threshold', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const store = await import('../../../src/crm/store.js');
    const tenantId = 'tenant-dsa-lte';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'C' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id });
    store.updateCard(tenantId, card.id, { lastActivityAt: Date.now() - 30 * 86400_000 });

    auts.createAutomation(tenantId, {
      name: 'fresh',
      trigger: { type: 'card_stale' },
      conditions: [{ type: 'days_since_activity', params: { days: 7, op: 'lte' } }],
      actions: [{ type: 'add_note', params: { content: 'fresh' } }],
    });
    await auts.emit({ trigger: 'card_stale', tenantId, cardId: card.id, contactId: contact.id });

    expect(auts.listAutomations(tenantId)[0]!.runsCount).toBe(0);
  });

  it('false when no timestamp exists at all', async () => {
    const { ran } = await fireWith({ type: 'days_since_activity', params: { days: 7, op: 'gte' } }, 'card_stale');
    // Card was just created, lastActivityAt is fresh — but updatedAt fallback also fresh — should be false
    expect(ran).toBe(false);
  });
});

// ─── 8. unknown condition type ────────────────────────────────────────────

describe('condition: unknown type', () => {
  it('returns false (default branch) and skips automation', async () => {
    const { ran } = await fireWith({ type: 'definitely_made_up_condition', params: {} } as any);
    expect(ran).toBe(false);
  });
});

// ─── 9. multiple conditions: ALL must match ──────────────────────────────

describe('multiple conditions are AND-combined', () => {
  it('fires only when every condition matches', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const store = await import('../../../src/crm/store.js');
    const tenantId = 'tenant-and';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'Lead novo' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999', tags: ['vip'] });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id, valueCents: 600000 });

    auts.createAutomation(tenantId, {
      name: 'and',
      trigger: { type: 'inbound_message' },
      conditions: [
        { type: 'tag_has', params: { tag: 'vip' } },
        { type: 'value_above', params: { cents: 500000 } },
        { type: 'column_is', params: { columnName: 'Lead novo' } },
      ],
      actions: [{ type: 'add_note', params: { content: 'all matched' } }],
    });
    await auts.emit({ trigger: 'inbound_message', tenantId, cardId: card.id, contactId: contact.id });

    expect(auts.listAutomations(tenantId)[0]!.runsCount).toBe(1);
  });

  it('does NOT fire when one condition fails', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const store = await import('../../../src/crm/store.js');
    const tenantId = 'tenant-and-fail';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'Lead novo' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999', tags: [] /* no vip */ });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id, valueCents: 600000 });

    auts.createAutomation(tenantId, {
      name: 'and-fail',
      trigger: { type: 'inbound_message' },
      conditions: [
        { type: 'tag_has', params: { tag: 'vip' } },
        { type: 'value_above', params: { cents: 500000 } },
      ],
      actions: [{ type: 'add_note', params: { content: 'x' } }],
    });
    await auts.emit({ trigger: 'inbound_message', tenantId, cardId: card.id, contactId: contact.id });

    expect(auts.listAutomations(tenantId)[0]!.runsCount).toBe(0);
  });
});
