/**
 * Camofox Browser Tools — adapted from camofox-browser's plugin.ts
 *
 * Wraps the camofox REST API (running at 127.0.0.1:9377 inside the container)
 * as DjinnBot AgentTool objects. These are PTC tools — agents call them via
 * exec_code Python, which is ideal for multi-step browsing workflows.
 *
 * The tool names, descriptions, and parameter schemas match camofox-browser's
 * shipped plugin exactly. The execute functions are thin HTTP wrappers.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CAMOFOX_URL = process.env.CAMOFOX_URL || 'http://127.0.0.1:9377';
const CAMOFOX_API_KEY = process.env.CAMOFOX_API_KEY || '';
const COOKIES_DIR = process.env.CAMOFOX_COOKIES_DIR || '/home/agent/cookies';

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function fetchApi(urlPath: string, options: RequestInit = {}): Promise<any> {
  const url = `${CAMOFOX_URL}${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Camofox ${res.status}: ${text}`);
  }
  return res.json();
}

function ok(data: unknown): AgentToolResult<{}> {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: {} };
}

// ── Netscape cookie file parser ───────────────────────────────────────────

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

function parseNetscapeCookies(content: string, domainSuffix?: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, value] = parts;
    if (domainSuffix && !domain.endsWith(domainSuffix)) continue;
    cookies.push({
      name,
      value: value || '',
      domain,
      path: cookiePath || '/',
      expires: parseInt(expires, 10) || -1,
      httpOnly: false,
      secure: secure.toLowerCase() === 'true',
    });
  }
  return cookies;
}

// ── Schemas ───────────────────────────────────────────────────────────────

const CreateTabParams = Type.Object({
  url: Type.String({ description: 'Initial URL to navigate to' }),
});

const TabIdParams = Type.Object({
  tabId: Type.String({ description: 'Tab identifier' }),
});

const SnapshotParams = Type.Object({
  tabId: Type.String({ description: 'Tab identifier' }),
  offset: Type.Optional(Type.Number({
    description: 'Character offset for paginated snapshots. Use nextOffset from a previous truncated response.',
  })),
});

const ClickParams = Type.Object({
  tabId: Type.String({ description: 'Tab identifier' }),
  ref: Type.Optional(Type.String({ description: 'Element ref from snapshot (e.g., e1)' })),
  selector: Type.Optional(Type.String({ description: 'CSS selector (alternative to ref)' })),
});

const TypeParams = Type.Object({
  tabId: Type.String({ description: 'Tab identifier' }),
  ref: Type.Optional(Type.String({ description: 'Element ref from snapshot (e.g., e2)' })),
  selector: Type.Optional(Type.String({ description: 'CSS selector (alternative to ref)' })),
  text: Type.String({ description: 'Text to type' }),
  pressEnter: Type.Optional(Type.Boolean({ description: 'Press Enter after typing' })),
});

const NavigateParams = Type.Object({
  tabId: Type.String({ description: 'Tab identifier' }),
  url: Type.Optional(Type.String({ description: 'URL to navigate to' })),
  macro: Type.Optional(Type.String({
    description: 'Search macro (e.g., @google_search, @youtube_search, @amazon_search, @reddit_search, @wikipedia_search, @twitter_search, @linkedin_search)',
  })),
  query: Type.Optional(Type.String({ description: 'Search query (when using macro)' })),
});

const ScrollParams = Type.Object({
  tabId: Type.String({ description: 'Tab identifier' }),
  direction: Type.Union([
    Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right'),
  ]),
  amount: Type.Optional(Type.Number({ description: 'Pixels to scroll (default: 500)' })),
});

const ImportCookiesParams = Type.Object({
  cookiesPath: Type.String({
    description: 'Filename of the cookie file (e.g., "linkedin.txt"). Resolved relative to /home/agent/cookies/',
  }),
  domainSuffix: Type.Optional(Type.String({
    description: 'Only import cookies whose domain ends with this suffix (e.g., ".linkedin.com")',
  })),
});

const YouTubeTranscriptParams = Type.Object({
  url: Type.String({ description: 'YouTube video URL' }),
  languages: Type.Optional(Type.Array(Type.String(), {
    description: 'Preferred languages (default: ["en"])',
  })),
});

const EmptyParams = Type.Object({});

// ── Tool factory ──────────────────────────────────────────────────────────

export interface CamofoxToolsConfig {
  agentId: string;
}

export function createCamofoxTools(config: CamofoxToolsConfig): AgentTool[] {
  const { agentId } = config;

  const tools: AgentTool[] = [
    // ── camofox_create_tab ────────────────────────────────────────────────
    {
      name: 'camofox_create_tab',
      label: 'camofox_create_tab',
      description:
        'PREFERRED: Create a new browser tab using Camoufox anti-detection browser. ' +
        'Use camofox tools instead of Chrome/built-in browser — they bypass bot detection ' +
        'on Google, Amazon, LinkedIn, etc. Returns JSON with a "tabId" field — parse it ' +
        'with json.loads() and pass result["tabId"] to other camofox tools. ' +
        'Always call camofox_snapshot after creating a tab to read the page content.',
      parameters: CreateTabParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof CreateTabParams>;
        const result = await fetchApi('/tabs', {
          method: 'POST',
          body: JSON.stringify({ url: p.url, userId: agentId, sessionKey: 'default' }),
        });
        return ok(result);
      },
    },

    // ── camofox_snapshot ──────────────────────────────────────────────────
    {
      name: 'camofox_snapshot',
      label: 'camofox_snapshot',
      description:
        'Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction. ' +
        'Returns JSON with "snapshot" (page text with element refs), "url", "refsCount", and pagination fields. ' +
        'Large pages are truncated — if hasMore=true, call again with the nextOffset value. ' +
        'Always call this after create_tab, navigate, click, scroll, back, or forward to see the result.',
      parameters: SnapshotParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof SnapshotParams>;
        const qs = p.offset ? `&offset=${p.offset}` : '';
        const result = await fetchApi(
          `/tabs/${p.tabId}/snapshot?userId=${agentId}&includeScreenshot=true${qs}`,
        );
        return ok({
          url: result.url,
          refsCount: result.refsCount,
          snapshot: result.snapshot,
          truncated: result.truncated,
          totalChars: result.totalChars,
          hasMore: result.hasMore,
          nextOffset: result.nextOffset,
        });
      },
    },

    // ── camofox_click ─────────────────────────────────────────────────────
    {
      name: 'camofox_click',
      label: 'camofox_click',
      description: 'Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector. Must provide either ref or selector. Call camofox_snapshot afterward to see the updated page.',
      parameters: ClickParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof ClickParams>;
        const result = await fetchApi(`/tabs/${p.tabId}/click`, {
          method: 'POST',
          body: JSON.stringify({ ref: p.ref, selector: p.selector, userId: agentId }),
        });
        return ok(result);
      },
    },

    // ── camofox_type ──────────────────────────────────────────────────────
    {
      name: 'camofox_type',
      label: 'camofox_type',
      description: 'Type text into an element in a Camoufox tab. Must provide either ref or selector to target the input field. Call camofox_snapshot afterward to verify.',
      parameters: TypeParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof TypeParams>;
        const result = await fetchApi(`/tabs/${p.tabId}/type`, {
          method: 'POST',
          body: JSON.stringify({ ref: p.ref, selector: p.selector, text: p.text, userId: agentId }),
        });
        if (p.pressEnter) {
          await fetchApi(`/tabs/${p.tabId}/press`, {
            method: 'POST',
            body: JSON.stringify({ key: 'Enter', userId: agentId }),
          });
        }
        return ok(result);
      },
    },

    // ── camofox_navigate ──────────────────────────────────────────────────
    {
      name: 'camofox_navigate',
      label: 'camofox_navigate',
      description:
        'Navigate a Camoufox tab to a URL or use a search macro. ' +
        'Provide either url (direct navigation) OR macro + query (e.g., macro="@google_search", query="python requests"). ' +
        'Available macros: @google_search, @youtube_search, @amazon_search, @reddit_search, @wikipedia_search, @twitter_search, @linkedin_search. ' +
        'Call camofox_snapshot afterward to read the page.',
      parameters: NavigateParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof NavigateParams>;
        const result = await fetchApi(`/tabs/${p.tabId}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ url: p.url, macro: p.macro, query: p.query, userId: agentId }),
        });
        return ok(result);
      },
    },

    // ── camofox_scroll ────────────────────────────────────────────────────
    {
      name: 'camofox_scroll',
      label: 'camofox_scroll',
      description: 'Scroll a Camoufox page in a given direction (up/down/left/right). Default scroll amount is 500px. Call camofox_snapshot afterward to see newly visible content.',
      parameters: ScrollParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof ScrollParams>;
        const result = await fetchApi(`/tabs/${p.tabId}/scroll`, {
          method: 'POST',
          body: JSON.stringify({ direction: p.direction, amount: p.amount, userId: agentId }),
        });
        return ok(result);
      },
    },

    // ── camofox_screenshot ────────────────────────────────────────────────
    {
      name: 'camofox_screenshot',
      label: 'camofox_screenshot',
      description: 'Take a screenshot of a Camoufox page. Returns base64 PNG.',
      parameters: TabIdParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof TabIdParams>;
        const url = `${CAMOFOX_URL}/tabs/${p.tabId}/screenshot?userId=${agentId}`;
        const res = await fetch(url);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Camofox ${res.status}: ${text}`);
        }
        const arrayBuffer = await res.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return {
          content: [{ type: 'image' as any, data: base64, mimeType: 'image/png' }],
          details: {},
        };
      },
    },

    // ── camofox_close_tab ─────────────────────────────────────────────────
    {
      name: 'camofox_close_tab',
      label: 'camofox_close_tab',
      description: 'Close a Camoufox browser tab.',
      parameters: TabIdParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof TabIdParams>;
        const result = await fetchApi(`/tabs/${p.tabId}`, {
          method: 'DELETE',
          body: JSON.stringify({ userId: agentId }),
        });
        return ok(result);
      },
    },

    // ── camofox_list_tabs ─────────────────────────────────────────────────
    {
      name: 'camofox_list_tabs',
      label: 'camofox_list_tabs',
      description: 'List all open Camoufox browser tabs.',
      parameters: EmptyParams,
      execute: async (): Promise<AgentToolResult<{}>> => {
        const result = await fetchApi(`/tabs?userId=${agentId}`);
        return ok(result);
      },
    },

    // ── camofox_import_cookies ────────────────────────────────────────────
    {
      name: 'camofox_import_cookies',
      label: 'camofox_import_cookies',
      description:
        'Import cookies into the Camoufox browser session from a cookie file. ' +
        'Cookie files are Netscape-format .txt files placed in /home/agent/cookies/ ' +
        'by the DjinnBot cookie management system. Use to authenticate to sites like ' +
        'LinkedIn, GitHub, etc. without interactive login.',
      parameters: ImportCookiesParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof ImportCookiesParams>;

        // Resolve path safely within the cookies directory
        const resolved = path.resolve(COOKIES_DIR, p.cookiesPath);
        if (!resolved.startsWith(path.resolve(COOKIES_DIR))) {
          throw new Error('Path traversal blocked: cookiesPath must be within the cookies directory');
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        const cookies = parseNetscapeCookies(content, p.domainSuffix);

        if (cookies.length === 0) {
          return ok({ imported: 0, message: 'No cookies found in file' + (p.domainSuffix ? ` matching domain ${p.domainSuffix}` : '') });
        }

        if (!CAMOFOX_API_KEY) {
          throw new Error('CAMOFOX_API_KEY is not set. Cookie import requires authentication.');
        }

        const result = await fetchApi(`/sessions/${encodeURIComponent(agentId)}/cookies`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CAMOFOX_API_KEY}`,
          },
          body: JSON.stringify({ cookies }),
        });

        return ok({ imported: cookies.length, userId: agentId, result });
      },
    },

    // ── camofox_back ──────────────────────────────────────────────────────
    {
      name: 'camofox_back',
      label: 'camofox_back',
      description: 'Go back in browser history for a Camoufox tab. Call camofox_snapshot afterward to see the page.',
      parameters: TabIdParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof TabIdParams>;
        const result = await fetchApi(`/tabs/${p.tabId}/back`, {
          method: 'POST',
          body: JSON.stringify({ userId: agentId }),
        });
        return ok(result);
      },
    },

    // ── camofox_forward ───────────────────────────────────────────────────
    {
      name: 'camofox_forward',
      label: 'camofox_forward',
      description: 'Go forward in browser history for a Camoufox tab. Call camofox_snapshot afterward to see the page.',
      parameters: TabIdParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof TabIdParams>;
        const result = await fetchApi(`/tabs/${p.tabId}/forward`, {
          method: 'POST',
          body: JSON.stringify({ userId: agentId }),
        });
        return ok(result);
      },
    },

    // ── camofox_youtube_transcript ────────────────────────────────────────
    {
      name: 'camofox_youtube_transcript',
      label: 'camofox_youtube_transcript',
      description: 'Extract captions/transcript from a YouTube video. Uses yt-dlp for fast extraction.',
      parameters: YouTubeTranscriptParams,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<{}>> => {
        const p = params as Static<typeof YouTubeTranscriptParams>;
        const result = await fetchApi('/youtube/transcript', {
          method: 'POST',
          body: JSON.stringify({ url: p.url, languages: p.languages || ['en'] }),
        });
        return ok(result);
      },
    },
  ];

  console.log(`[Camofox] Created ${tools.length} browser tools for agent ${agentId}`);
  return tools;
}
