/**
 * WebFetchTool — Fetch a URL and return clean markdown content
 *
 * Based on Claude Code's WebFetchTool
 * - HTML → markdown via turndown
 * - JSON → formatted JSON
 * - SSRF protection: blocks private IPs, localhost, file://, ftp://
 * - Truncation at 100,000 chars (~25k tokens)
 * - Optional prompt: pre-filters content via a Claude side query
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type RenderOptions } from '../Tool.js';
import TurndownService from 'turndown';
import { callModelSync, type ClovMessage } from '../../api/anthropic.js';
import * as dns from 'dns/promises';
import * as url from 'url';

// ─── SSRF Protection ────────────────────────────────────────────────────────

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

async function resolveAndCheckHost(hostname: string): Promise<{ safe: boolean; reason?: string }> {
  // Direct pattern check on hostname
  if (isBlockedHost(hostname)) {
    return { safe: false, reason: `Blocked host: ${hostname} (private/local network)` };
  }

  // DNS resolve to check actual IP
  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const all = [...addresses, ...addresses6];

    for (const addr of all) {
      if (isBlockedHost(addr)) {
        return { safe: false, reason: `Blocked: ${hostname} resolves to private IP ${addr}` };
      }
    }
  } catch {
    // DNS resolution failed — allow (could be valid external host with temp DNS issue)
  }

  return { safe: true };
}

// ─── HTML → Markdown ────────────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Strip script, style, nav, footer, header tags
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript']);

function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html);
  } catch {
    // Fallback: strip tags manually
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CONTENT_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'Clow/1.0 (System Clow AI Agent)';

// ─── Input Schema ───────────────────────────────────────────────────────────

const WebFetchInputSchema = z.object({
  url: z.string().url().describe('The URL to fetch content from'),
  prompt: z.string().optional().describe('Optional prompt to extract specific info from the page'),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

// ─── The Tool ───────────────────────────────────────────────────────────────

export const WebFetchTool = buildTool<WebFetchInput>({
  name: 'WebFetch',
  aliases: ['WebFetchTool'],
  searchHint: 'url fetch download webpage http',
  description: `Fetch content from a URL and return it as clean markdown.
- Converts HTML to markdown automatically
- Returns JSON formatted for JSON APIs
- Use when you have a specific URL to read (docs, APIs, articles)
- For searching the web, use WebSearch instead
- Has a 30-second timeout and 100K character limit`,
  inputSchema: WebFetchInputSchema,

  userFacingName(input?: WebFetchInput) {
    if (!input) return 'WebFetch';
    try { return `WebFetch(${new URL(input.url).hostname})`; } catch { return 'WebFetch'; }
  },
  isReadOnly() { return true; },
  isConcurrencySafe() { return true; },
  isDestructive() { return false; },
  toAutoClassifierInput(input: WebFetchInput) { return input.url; },
  renderToolUseMessage(input: WebFetchInput, _opts: RenderOptions) {
    try { return `Fetch ${new URL(input.url).hostname}${new URL(input.url).pathname.slice(0, 30)}`; } catch { return `Fetch ${input.url.slice(0, 50)}`; }
  },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: WebFetchInput): Promise<ToolResult> {
    const targetUrl = input.url.trim();

    // ── Protocol validation ─────────────────────────────────────────────
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return error(`Invalid URL: ${targetUrl}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return error(`Blocked protocol: ${parsed.protocol} — only http:// and https:// are allowed`);
    }

    // ── SSRF check ──────────────────────────────────────────────────────
    const hostCheck = await resolveAndCheckHost(parsed.hostname);
    if (!hostCheck.safe) {
      return error(`Security: ${hostCheck.reason}`);
    }

    // ── Fetch ───────────────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return error(`Timeout: URL did not respond within ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      return error(`Fetch failed: ${err.message}`);
    }

    if (!response.ok) {
      return error(`HTTP ${response.status} ${response.statusText} for ${targetUrl}`);
    }

    // ── Content-type routing ────────────────────────────────────────────
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    let rawBody: string;

    try {
      rawBody = await response.text();
    } catch (err: any) {
      return error(`Failed to read response body: ${err.message}`);
    }

    let content: string;

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      content = htmlToMarkdown(rawBody);
    } else if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawBody);
        content = '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
      } catch {
        content = rawBody;
      }
    } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
      content = rawBody;
    } else if (contentType.includes('application/pdf')) {
      return error('PDF content detected. WebFetch cannot process PDFs. Save the URL and use a PDF-specific tool.');
    } else if (contentType.includes('image/') || contentType.includes('audio/') || contentType.includes('video/')) {
      return error(`Binary content type (${contentType}) cannot be processed as text.`);
    } else {
      // Best effort: try as text
      content = rawBody;
    }

    // ── Truncation ──────────────────────────────────────────────────────
    const originalLength = content.length;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS) +
        `\n\n[Content truncated. Original was ${originalLength.toLocaleString()} characters, showing first ${MAX_CONTENT_CHARS.toLocaleString()}]`;
    }

    // ── Optional prompt (pre-filter via Claude side query) ─────────────
    if (input.prompt) {
      try {
        const sideMessages: ClovMessage[] = [
          {
            role: 'user',
            content: `Here is the content fetched from ${targetUrl}:\n\n${content}\n\n---\n\nBased on the content above, answer this question:\n${input.prompt}`,
          },
        ];
        const result = await callModelSync(
          sideMessages,
          'You are a helpful assistant. Answer based only on the provided content. Be concise and specific.',
          2048,
        );
        return {
          output: { url: targetUrl, filtered: true, originalLength },
          outputText: `Content from ${targetUrl} (filtered by prompt):\n\n${result.content}`,
        };
      } catch (err: any) {
        // Side query failed — return raw content instead
        return {
          output: { url: targetUrl, filtered: false, originalLength },
          outputText: `Content from ${targetUrl} (prompt filter failed: ${err.message}, returning raw):\n\n${content}`,
        };
      }
    }

    return {
      output: { url: targetUrl, contentLength: content.length, originalLength },
      outputText: `Content from ${targetUrl}:\n\n${content}`,
    };
  },
});

function error(msg: string): ToolResult {
  return { output: null, outputText: `Error: ${msg}`, isError: true };
}
