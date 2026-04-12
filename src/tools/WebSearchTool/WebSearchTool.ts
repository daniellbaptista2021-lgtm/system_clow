/**
 * WebSearchTool — Search the web via Brave Search API
 *
 * Based on Claude Code's WebSearchTool
 * Provider: Brave Search API (2,000 free queries/month)
 * Fallback: if BRAVE_SEARCH_API_KEY not set, tool doesn't appear in registry
 *
 * Returns formatted markdown with title, URL, description, age
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type RenderOptions } from '../Tool.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 15_000;

// ─── Input Schema ───────────────────────────────────────────────────────────

const WebSearchInputSchema = z.object({
  query: z.string().min(1).max(400).describe('The search query'),
  max_results: z.number().int().min(1).max(20).optional().default(10)
    .describe('Maximum number of results to return (default 10)'),
  freshness: z.enum(['day', 'week', 'month', 'year', 'all']).optional()
    .describe('Filter results by freshness'),
});

type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

// ─── Brave API Response Types ───────────────────────────────────────────────

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  query?: { original: string };
  web?: { results: BraveWebResult[] };
  mixed?: { main: Array<{ type: string; index?: number }> };
}

// ─── Format Results ─────────────────────────────────────────────────────────

function formatResults(query: string, results: BraveWebResult[]): string {
  if (results.length === 0) {
    return `## Search results for: "${query}"\n\nNo results found.`;
  }

  const lines = [`## Search results for: "${query}"\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const age = r.age || r.page_age || '';
    lines.push(`${i + 1}. **${r.title}** — ${r.url}`);
    lines.push(`   ${r.description}`);
    if (age) {
      lines.push(`   _${age}_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── The Tool ───────────────────────────────────────────────────────────────

export const WebSearchTool = buildTool<WebSearchInput>({
  name: 'WebSearch',
  aliases: ['WebSearchTool'],
  searchHint: 'search web google brave query',
  description: `Search the web for current information. Returns titles, URLs, and descriptions.
Use when you need information beyond your training data: recent docs, library versions,
current best practices, error messages, Stack Overflow solutions.
Powered by Brave Search. Requires BRAVE_SEARCH_API_KEY env variable.`,
  inputSchema: WebSearchInputSchema,

  userFacingName(input?: WebSearchInput) { return input ? `WebSearch("${input.query.slice(0, 30)}")` : 'WebSearch'; },
  isEnabled() { return Boolean(process.env.BRAVE_SEARCH_API_KEY); },
  isReadOnly() { return true; },
  isConcurrencySafe() { return true; },
  isDestructive() { return false; },
  toAutoClassifierInput(input: WebSearchInput) { return input.query; },
  renderToolUseMessage(input: WebSearchInput, _opts: RenderOptions) { return `Search: "${input.query}"`; },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: WebSearchInput): Promise<ToolResult> {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return {
        output: null,
        outputText: 'Error: BRAVE_SEARCH_API_KEY not configured. Web search is unavailable.',
        isError: true,
      };
    }

    const query = input.query.trim();
    const maxResults = input.max_results ?? 10;

    // ── Build request URL ───────────────────────────────────────────────
    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
    });

    if (input.freshness && input.freshness !== 'all') {
      // Brave API freshness parameter: pd (day), pw (week), pm (month), py (year)
      const freshnessMap: Record<string, string> = {
        day: 'pd',
        week: 'pw',
        month: 'pm',
        year: 'py',
      };
      params.set('freshness', freshnessMap[input.freshness] || '');
    }

    const requestUrl = `${BRAVE_API_URL}?${params.toString()}`;

    // ── Fetch ───────────────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return {
          output: null,
          outputText: `Error: Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`,
          isError: true,
        };
      }
      return {
        output: null,
        outputText: `Error: Search request failed: ${err.message}`,
        isError: true,
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        output: null,
        outputText: `Error: Brave Search API returned HTTP ${response.status}: ${body.slice(0, 200)}`,
        isError: true,
      };
    }

    // ── Parse response ──────────────────────────────────────────────────
    let data: BraveSearchResponse;
    try {
      data = await response.json() as BraveSearchResponse;
    } catch {
      return {
        output: null,
        outputText: 'Error: Failed to parse search response as JSON',
        isError: true,
      };
    }

    const results = data.web?.results || [];

    // ── Format ──────────────────────────────────────────────────────────
    const formatted = formatResults(query, results.slice(0, maxResults));

    return {
      output: {
        query,
        resultCount: results.length,
        results: results.slice(0, maxResults).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          age: r.age || r.page_age,
        })),
      },
      outputText: formatted,
    };
  },
});
