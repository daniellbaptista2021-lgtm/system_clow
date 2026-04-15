/**
 * openapi.ts — OpenAPI 3.1 specification for System Clow API
 *
 * Auto-serves Swagger UI at /docs and OpenAPI JSON at /openapi.json
 */

import { Hono } from 'hono';

// ════════════════════════════════════════════════════════════════════════════
// OpenAPI 3.1 Specification
// ════════════════════════════════════════════════════════════════════════════

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'System Clow API',
    version: '1.0.0',
    description: 'AI coding agent API — execute tasks, manage sessions, search memory, and more.',
    contact: { name: 'System Clow', url: 'https://github.com/daniellbaptista2021-lgtm/system_clow' },
    license: { name: 'Proprietary' },
  },
  servers: [
    { url: 'https://system-clow.pvcorretor01.com.br', description: 'Production' },
    { url: 'http://localhost:3001', description: 'Local Development' },
  ],
  tags: [
    { name: 'Auth', description: 'Authentication endpoints' },
    { name: 'Sessions', description: 'Chat session management' },
    { name: 'Memory', description: 'Persistent memory system' },
    { name: 'System', description: 'Health and metrics' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        operationId: 'getHealth',
        responses: {
          200: {
            description: 'Server status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Admin login',
        operationId: 'login',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: { description: 'Login successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/verify': {
      get: {
        tags: ['Auth'],
        summary: 'Verify admin token',
        operationId: 'verifyToken',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Token valid' },
          401: { description: 'Token invalid or expired' },
        },
      },
    },
    '/v1/sessions': {
      post: {
        tags: ['Sessions'],
        summary: 'Create a new session',
        operationId: 'createSession',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSessionRequest' } } },
        },
        responses: {
          200: { description: 'Session created', content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionResponse' } } } },
        },
      },
      get: {
        tags: ['Sessions'],
        summary: 'List active sessions',
        operationId: 'listSessions',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Session list', content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { $ref: '#/components/schemas/SessionMeta' } } } } } } },
        },
      },
    },
    '/v1/sessions/{id}/messages': {
      post: {
        tags: ['Sessions'],
        summary: 'Send message (SSE streaming)',
        operationId: 'sendMessage',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageRequest' } } },
        },
        responses: {
          200: { description: 'SSE stream of events', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        },
      },
    },
    '/v1/sessions/{id}': {
      get: {
        tags: ['Sessions'],
        summary: 'Get session metadata',
        operationId: 'getSession',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Session metadata' } },
      },
      delete: {
        tags: ['Sessions'],
        summary: 'End/delete session',
        operationId: 'deleteSession',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Session deleted' } },
      },
    },
    '/v1/sessions/{id}/history': {
      get: {
        tags: ['Sessions'],
        summary: 'Get message history',
        operationId: 'getHistory',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Message history array' } },
      },
    },
    '/v1/memory/search': {
      get: {
        tags: ['Memory'],
        summary: 'Search persistent memory (FTS5)',
        operationId: 'searchMemory',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 }, description: 'Max results' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['observation', 'summary'] } },
        ],
        responses: {
          200: { description: 'Search results', content: { 'application/json': { schema: { $ref: '#/components/schemas/MemorySearchResponse' } } } },
        },
      },
    },
    '/v1/memory/sessions': {
      get: {
        tags: ['Memory'],
        summary: 'List remembered sessions',
        operationId: 'listMemorySessions',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }],
        responses: { 200: { description: 'Session list with summaries' } },
      },
    },
    '/v1/memory/sessions/{id}/timeline': {
      get: {
        tags: ['Memory'],
        summary: 'Get session observation timeline',
        operationId: 'getTimeline',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Observation timeline' } },
      },
    },
    '/v1/memory/sessions/{id}': {
      delete: {
        tags: ['Memory'],
        summary: 'Delete session memory (GDPR)',
        operationId: 'deleteMemorySession',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Session data deleted' } },
      },
    },
    '/v1/memory/stats': {
      get: {
        tags: ['Memory'],
        summary: 'Memory system statistics',
        operationId: 'getMemoryStats',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/MemoryStats' } } } },
        },
      },
    },
    '/v1/metrics': {
      get: {
        tags: ['System'],
        summary: 'Performance metrics (latency, throughput)',
        operationId: 'getMetrics',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Metrics summary' } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          service: { type: 'string', example: 'system-clow' },
          version: { type: 'string', example: '1.0.0' },
          activeSessions: { type: 'integer' },
          uptimeSeconds: { type: 'integer' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          token: { type: 'string', description: 'JWT token (12h expiry)' },
        },
      },
      CreateSessionRequest: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Custom session ID (auto-generated if omitted)' },
          mode: { type: 'string', enum: ['server', 'coordinator'], default: 'server' },
        },
      },
      SessionResponse: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string' },
          cwd: { type: 'string' },
          mode: { type: 'string' },
        },
      },
      SessionMeta: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          cwd: { type: 'string' },
          mode: { type: 'string' },
          messageCount: { type: 'integer' },
          createdAt: { type: 'integer' },
          lastAccess: { type: 'integer' },
        },
      },
      MessageRequest: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', description: 'User message text' },
        },
      },
      MemorySearchResponse: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['observation', 'summary'] },
                id: { type: 'integer' },
                session_id: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string' },
                created_at_epoch: { type: 'integer' },
              },
            },
          },
          count: { type: 'integer' },
        },
      },
      MemoryStats: {
        type: 'object',
        properties: {
          sessionCount: { type: 'integer' },
          observationCount: { type: 'integer' },
          summaryCount: { type: 'integer' },
          dbSizeBytes: { type: 'integer' },
        },
      },
    },
  },
};

// ════════════════════════════════════════════════════════════════════════════
// Routes: /openapi.json + /docs (Swagger UI)
// ════════════════════════════════════════════════════════════════════════════

export function buildDocsRoutes(): Hono {
  const app = new Hono();

  // OpenAPI JSON spec
  app.get('/openapi.json', (c) => c.json(OPENAPI_SPEC));

  // Swagger UI HTML
  app.get('/docs', (c) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>System Clow API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0;background:#1a1a2e}.topbar{display:none}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
      defaultModelsExpandDepth: 2,
    });
  </script>
</body>
</html>`;
    return c.html(html);
  });

  return app;
}
