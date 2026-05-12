/**
 * CRM store — barrel module.
 *
 * The data-access layer was split into per-entity files under
 * src/crm/store/* in this refactor. This barrel re-exports every named
 * export from each entity file so that existing call sites
 *   import { listContacts } from './store.js';
 * keep working without changes.
 *
 * Module-level state (lazy emitter caches) lives in store/_internals.ts
 * and is shared across every entity file.
 */
export * from './store/boardsStore.js';
export * from './store/cardsStore.js';
export * from './store/contactsStore.js';
export * from './store/agentsStore.js';
export * from './store/channelsStore.js';
export * from './store/subscriptionsStore.js';
export * from './store/inventoryStore.js';
export * from './store/automationsStore.js';
