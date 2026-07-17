/**
 * MCP client wiring, kept injectable so the core is testable without live
 * calls. Adapters depend on the tiny `McpToolClient` interface — tests and
 * the dev demo inject `FixtureMcpClient`; real use injects `LiveMcpClient`.
 */

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

/** How this engine identifies itself to every MCP server it dials. */
export const MCP_CLIENT_INFO = { name: "shadow-cortex", version: "0.1.0" };

export interface McpToolClient {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Replays canned tool responses from a JSON file keyed by tool name. */
export class FixtureMcpClient implements McpToolClient {
  private readonly responses: Record<string, unknown>;

  constructor(fixturePath: string) {
    this.responses = JSON.parse(readFileSync(fixturePath, "utf8"));
  }

  async callTool(name: string): Promise<unknown> {
    if (!(name in this.responses)) {
      throw new Error(`Fixture has no canned response for tool "${name}"`);
    }
    return this.responses[name];
  }
}

/**
 * Live MCP-over-HTTP client. Two auth shapes:
 * - a bearer token string from the environment (e.g. SHADOWALPHA_MCP_TOKEN) —
 *   credentials are referenced, never inline; or
 * - `{ authProvider }` (an SDK OAuthClientProvider, e.g. the Robinhood
 *   FileOAuthProvider) — the SDK attaches tokens and silently refreshes them;
 *   when interaction would be required the provider fails closed.
 */
export class LiveMcpClient implements McpToolClient {
  private client: Client | null = null;

  constructor(
    private readonly url: string,
    private readonly auth?: string | { authProvider: OAuthClientProvider },
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client(MCP_CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      ...(typeof this.auth === "object" && this.auth !== null
        ? { authProvider: this.auth.authProvider }
        : {}),
      requestInit:
        typeof this.auth === "string" && this.auth
          ? { headers: { Authorization: `Bearer ${this.auth}` } }
          : undefined,
    });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    // Prefer structured content; fall back to parsing the first text block.
    if (result.structuredContent !== undefined) return result.structuredContent;
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === "text")?.text;
    if (text === undefined) return result;
    try {
      return parseLenientJson(text);
    } catch {
      return text;
    }
  }
}

/**
 * Some upstream tools emit literal NaN/Infinity value tokens (observed live
 * on the ShadowAlpha leaderboard), which is invalid JSON. Replace bare value
 * tokens with null before parsing — the lookaround anchors keep occurrences
 * inside string values (e.g. a post quote containing "NaN") untouched.
 */
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const sanitized = text.replace(
      /(?<=[:,[]\s*)(?:NaN|-?Infinity)(?=\s*[,\]}])/g,
      "null",
    );
    return JSON.parse(sanitized);
  }
}
