/**
 * CRM REST API routes — mounted at /v1/crm.
 *
 * This file is the ORCHESTRATOR. The actual endpoint handlers live in
 * src/crm/routes/{boards,cards,contacts,...}.ts and are wired up here in
 * the same order they appeared in the previous monolithic version, so
 * Hono's first-match-wins routing behavior is preserved exactly.
 *
 * To add a new route:
 *   - Add its handler to the appropriate domain file in src/crm/routes/
 *   - It will be picked up automatically (the registerX function loops
 *     are the entry points called below).
 */
import { Hono } from 'hono';
import * as rl from './rateLimiter.js';
import { fieldSelectionMiddleware } from './fieldSelector.js';

import { registerAuthExchangeRoutes } from './routes/auth-exchange.js';
import { registerBoardsRoutes } from './routes/boards.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerCardsRoutes } from './routes/cards.js';
import { registerContactsRoutes } from './routes/contacts.js';
import { registerAgentsRoutes } from './routes/agents.js';
import { registerChannelsRoutes } from './routes/channels.js';
import { registerSubscriptionsRoutes } from './routes/subscriptions.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerAutomationsRoutes } from './routes/automations.js';

const app = new Hono();

// ═══ ONDA 30: Rate limit + field selection middlewares ════════════════
app.use('*', rl.rateLimitMiddleware());
app.use('*', fieldSelectionMiddleware());

registerAuthExchangeRoutes(app);
registerBoardsRoutes(app);
registerStatsRoutes(app);
registerCardsRoutes(app);
registerContactsRoutes(app);
registerAgentsRoutes(app);
registerChannelsRoutes(app);
registerSubscriptionsRoutes(app);
registerInventoryRoutes(app);
registerMediaRoutes(app);
registerAutomationsRoutes(app);

export default app;
