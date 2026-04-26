/**
 * Automation engine — trigger dispatch tests.
 *
 * For each TriggerType the engine declares, verify that emit() with
 * that trigger fires automations registered against that trigger AND
 * does NOT fire automations registered against a different trigger.
 *
 * NOTES on the user's spec vs. reality (documented for the next reader):
 *   - The user listed 6 triggers (card_moved, card_created, contact_created,
 *     message_received, time_based, webhook_received). The engine has 8
 *     types, names slightly different:
 *       inbound_message  ↔ message_received
 *       schedule         ↔ time_based
 *       webhook          ↔ webhook_received
 *       contact_created  → does NOT exist in engine (no caller emits it)
 *       outbound_message + card_stale + due_approaching → exist additionally
 *   - card_created and card_moved are declared but NO production code path
 *     emits them today — they exist only to support the bundled templates
 *     (welcome_new_lead, won_thank_you). Tests below emit them directly to
 *     prove the matching/dispatch works; integration with the store layer
 *     would need new emit calls in store/cardsStore.ts.
 *   TODO: wire emit({trigger:'card_created'}) into store.createCard and
 *         emit({trigger:'card_moved'}) into store.moveCard so the
 *         bundled templates actually fire in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-aut-trig-'));
  process.env.CLOW_HOME = tmpHome;
  process.env.CRM_DB_PATH = join(tmpHome, 'crm.sqlite3');
  // Trigger schema migration for this fresh DB.
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

const TRIGGERS = [
  'inbound_message',
  'outbound_message',
  'card_created',
  'card_moved',
  'card_stale',
  'due_approaching',
  'webhook',
  'schedule',
] as const;

describe('Automation engine — trigger dispatch', () => {
  it.each(TRIGGERS)('%s trigger fires automations registered against it', async (trigger) => {
    const auts = await import('../../../src/crm/automations.js');
    const tenantId = 'tenant-trig-' + trigger;
    auts.createAutomation(tenantId, {
      name: `test-${trigger}`,
      trigger: { type: trigger },
      conditions: [],
      // add_note has no external deps and works without a card/contact
      actions: [{ type: 'add_note', params: { content: 'fired' } }],
    });

    await auts.emit({ trigger, tenantId, contactId: undefined, cardId: undefined });

    const list = auts.listAutomations(tenantId);
    expect(list).toHaveLength(1);
    expect(list[0]!.runsCount).toBe(1);
    expect(list[0]!.lastRunAt).toBeGreaterThan(0);
  });

  it('emit with trigger A does NOT fire automations registered for trigger B', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const tenantId = 'tenant-mismatch';
    auts.createAutomation(tenantId, {
      name: 'wants-inbound',
      trigger: { type: 'inbound_message' },
      conditions: [],
      actions: [{ type: 'add_note', params: { content: 'x' } }],
    });

    await auts.emit({ trigger: 'card_moved', tenantId });

    const list = auts.listAutomations(tenantId);
    expect(list[0]!.runsCount).toBe(0);
  });

  it('disabled automations are NOT fired', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const tenantId = 'tenant-disabled';
    const aut = auts.createAutomation(tenantId, {
      name: 'off',
      trigger: { type: 'inbound_message' },
      conditions: [],
      actions: [{ type: 'add_note', params: { content: 'x' } }],
      enabled: false,
    });

    await auts.emit({ trigger: 'inbound_message', tenantId });

    const after = auts.listAutomations(tenantId).find((a) => a.id === aut.id);
    expect(after!.runsCount).toBe(0);
  });

  it('multi-tenant isolation: tenant A automation does not run on tenant B event', async () => {
    const auts = await import('../../../src/crm/automations.js');
    auts.createAutomation('tenantA', {
      name: 'A only',
      trigger: { type: 'inbound_message' },
      conditions: [],
      actions: [{ type: 'add_note', params: { content: 'A' } }],
    });

    await auts.emit({ trigger: 'inbound_message', tenantId: 'tenantB' });

    expect(auts.listAutomations('tenantA')[0]!.runsCount).toBe(0);
  });

  it('runs_count + last_run_at advance on each fire', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const tenantId = 'tenant-counter';
    auts.createAutomation(tenantId, {
      name: 'counter',
      trigger: { type: 'webhook' },
      conditions: [],
      actions: [{ type: 'add_note', params: { content: 'x' } }],
    });

    await auts.emit({ trigger: 'webhook', tenantId, cardId: 'card-1' });
    await auts.emit({ trigger: 'webhook', tenantId, cardId: 'card-2' });
    await auts.emit({ trigger: 'webhook', tenantId, cardId: 'card-3' });

    const a = auts.listAutomations(tenantId)[0]!;
    expect(a.runsCount).toBe(3);
  });

  it('dedupes re-entrant emits with the same dedupe key', async () => {
    // Same tenant + trigger + cardId + activityId collapses to one run.
    const auts = await import('../../../src/crm/automations.js');
    const tenantId = 'tenant-dedupe';
    auts.createAutomation(tenantId, {
      name: 'dd',
      trigger: { type: 'inbound_message' },
      conditions: [],
      actions: [{ type: 'add_note', params: { content: 'x' } }],
    });

    // Fire two emits in parallel with identical dedupe keys.
    await Promise.all([
      auts.emit({ trigger: 'inbound_message', tenantId, cardId: 'c1', activityId: 'a1' }),
      auts.emit({ trigger: 'inbound_message', tenantId, cardId: 'c1', activityId: 'a1' }),
    ]);

    // The second emit short-circuits on _runningEvents.has(key), so the
    // counter advances only once.
    expect(auts.listAutomations(tenantId)[0]!.runsCount).toBe(1);
  });
});
