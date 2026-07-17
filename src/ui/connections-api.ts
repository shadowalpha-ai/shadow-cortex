/**
 * Connections API — the dashboard's no-terminal path to credentials.
 *
 * - ShadowAlpha: paste-a-token flow. The token is LIVE-VALIDATED with one
 *   cheap MCP call before being saved to state/shadowalpha-token.json (0600,
 *   gitignored). The SHADOWALPHA_MCP_TOKEN env var always wins over the file.
 * - Robinhood: full browser OAuth. `start` kicks off the SDK flow with the
 *   dashboard's own /api/connections/robinhood/callback as the redirect URL
 *   and returns the authorization URL for the browser to open; the callback
 *   route finishes the exchange, verifies the agentic account, and stores a
 *   MASKED account label for display.
 *
 * SECURITY: everything here handles credentials. Nothing logs a token, an
 * authorization code, or a full account number; status responses carry only
 * booleans and masked labels. Served exclusively on 127.0.0.1 (see server.ts).
 * Connections apply to the running engine ON RESTART (same save+restart
 * semantics as settings).
 */

import { findAgenticAccount } from "../execution/robinhood-shared.js";
import { writeJsonAtomic } from "../core/atomic-write.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { Settings } from "../settings/schema.js";
import type { AuditLog } from "../core/audit.js";
import { FileOAuthProvider, hasRobinhoodTokens } from "../execution/robinhood-oauth.js";
import { LiveMcpClient, MCP_CLIENT_INFO } from "../sources/mcp-client.js";
import {
  deleteShadowAlphaToken,
  saveShadowAlphaToken,
  shadowAlphaTokenSource,
} from "../settings/credentials.js";
import { log } from "../core/log.js";

export interface ConnectionsStatus {
  shadowalpha: { connected: boolean; source: "env" | "file" | null };
  robinhood: { connected: boolean; account: string | null };
}

type TokenValidator = (url: string, token: string) => Promise<void>;

/** Default validator: one cheap authenticated call against the live MCP. */
async function liveValidate(url: string, token: string): Promise<void> {
  const client = new LiveMcpClient(url, token);
  await client.callTool("get_stock_ideas", { limit: 1 });
}

interface PendingOauth {
  transport: StreamableHTTPClientTransport;
  provider: FileOAuthProvider;
  startedAt: number;
}

export class ConnectionsApi {
  private pendingOauth: PendingOauth | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly audit: AuditLog,
    private readonly validateToken: TokenValidator = liveValidate,
  ) {}

  // --- status ---

  status(): ConnectionsStatus {
    return {
      shadowalpha: {
        connected: shadowAlphaTokenSource(this.settings.paths.shadowalphaToken) !== null,
        source: shadowAlphaTokenSource(this.settings.paths.shadowalphaToken),
      },
      robinhood: {
        connected: hasRobinhoodTokens(this.settings.paths.robinhoodOauth),
        account: this.robinhoodDisplayAccount(),
      },
    };
  }

  // --- ShadowAlpha (token paste) ---

  async connectShadowAlpha(token: unknown): Promise<{ status: number; body: unknown }> {
    if (typeof token !== "string" || token.trim().length === 0) {
      return { status: 400, body: { error: { code: "bad_token", message: "token must be a non-empty string" } } };
    }
    const url = this.shadowAlphaUrl();
    try {
      await this.validateToken(url, token.trim());
    } catch (err) {
      // The message may quote upstream errors, never the token itself.
      return {
        status: 400,
        body: {
          error: {
            code: "token_rejected",
            message: `ShadowAlpha rejected the token (checked live against ${url}): ${String(err)}`,
          },
        },
      };
    }
    saveShadowAlphaToken(this.settings.paths.shadowalphaToken, token.trim());
    this.audit.write("connection_changed", { service: "shadowalpha", action: "connected" });
    return { status: 200, body: { ok: true, restartRequired: true, status: this.status() } };
  }

  disconnectShadowAlpha(): { status: number; body: unknown } {
    if (shadowAlphaTokenSource(this.settings.paths.shadowalphaToken) === "env") {
      return {
        status: 409,
        body: {
          error: {
            code: "env_token",
            message:
              "The token comes from the SHADOWALPHA_MCP_TOKEN environment variable — unset it in the shell that runs the engine.",
          },
        },
      };
    }
    deleteShadowAlphaToken(this.settings.paths.shadowalphaToken);
    this.audit.write("connection_changed", { service: "shadowalpha", action: "disconnected" });
    return { status: 200, body: { ok: true, restartRequired: true, status: this.status() } };
  }

  // --- Robinhood (browser OAuth) ---

  /**
   * Begin the OAuth flow. Returns the authorization URL for the browser to
   * open; the redirect comes back to the dashboard's own callback route.
   */
  async startRobinhoodOauth(callbackUrl: string): Promise<{ status: number; body: unknown }> {
    // A re-click abandons any earlier half-finished flow.
    this.pendingOauth = null;

    let authorizeUrl: string | null = null;
    const provider = new FileOAuthProvider(this.settings.paths.robinhoodOauth, {
      redirectUrl: callbackUrl,
      onRedirect: (url) => {
        authorizeUrl = url.toString();
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(this.settings.robinhood.url), {
      authProvider: provider,
    });
    const client = new Client(MCP_CLIENT_INFO);
    try {
      await client.connect(transport);
      // Token on disk is already valid.
      return { status: 200, body: { ok: true, alreadyConnected: true, status: this.status() } };
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || !authorizeUrl) {
        return {
          status: 502,
          body: { error: { code: "oauth_start_failed", message: String(err) } },
        };
      }
    }
    this.pendingOauth = { transport, provider, startedAt: Date.now() };
    return { status: 200, body: { ok: true, authorizeUrl } };
  }

  /** The redirect target. Returns HTML for the user's browser tab. */
  async finishRobinhoodOauth(
    code: string | null,
    error: string | null,
    state: string | null = null,
  ): Promise<{ status: number; html: string }> {
    const pending = this.pendingOauth;
    if (!pending) {
      return { status: 400, html: callbackPage(false, "No connection attempt is in progress — go back to the dashboard and click Connect again.") };
    }
    if (!code) {
      this.pendingOauth = null;
      return { status: 400, html: callbackPage(false, error ?? "Robinhood returned no authorization code.") };
    }
    // CSRF check: the callback must echo the state this flow started with.
    const expectedState = pending.provider.consumeState();
    if (expectedState && state !== expectedState) {
      this.pendingOauth = null;
      return {
        status: 400,
        html: callbackPage(false, "State mismatch — this callback doesn't belong to the current connection attempt. Click Connect again."),
      };
    }
    try {
      await pending.transport.finishAuth(code);
      // Verify with a fresh connection and find the agentic account.
      const verifyProvider = new FileOAuthProvider(this.settings.paths.robinhoodOauth);
      const client = new Client(MCP_CLIENT_INFO);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.settings.robinhood.url), {
          authProvider: verifyProvider,
        }),
      );
      const masked = await fetchAgenticAccountMasked(client);
      this.storeDisplayAccount(masked);
      this.audit.write("connection_changed", { service: "robinhood", action: "connected" });
      this.pendingOauth = null;
      return {
        status: 200,
        html: callbackPage(
          true,
          masked
            ? `Connected to agentic account ${masked}. Return to the dashboard and restart the engine to use it.`
            : "Connected — but no agentic-enabled account was found. Create and fund one in the Robinhood app (Investing → Agentic trading), then reconnect.",
        ),
      };
    } catch (err) {
      this.pendingOauth = null;
      log.error("Robinhood OAuth callback failed", err);
      return { status: 502, html: callbackPage(false, String(err)) };
    }
  }

  disconnectRobinhood(): { status: number; body: unknown } {
    if (existsSync(this.settings.paths.robinhoodOauth)) {
      unlinkSync(this.settings.paths.robinhoodOauth);
    }
    this.pendingOauth = null;
    this.audit.write("connection_changed", { service: "robinhood", action: "disconnected" });
    return { status: 200, body: { ok: true, restartRequired: true, status: this.status() } };
  }

  // --- helpers ---

  private shadowAlphaUrl(): string {
    for (const source of this.settings.sources) {
      if ("url" in source) return source.url;
    }
    return "https://shadowalpha.ai/mcp";
  }

  private robinhoodDisplayAccount(): string | null {
    try {
      const doc = JSON.parse(readFileSync(this.settings.paths.robinhoodOauth, "utf8")) as {
        display?: { agenticAccountMasked?: string };
      };
      return doc.display?.agenticAccountMasked ?? null;
    } catch {
      return null;
    }
  }

  /** Patch the (0600) oauth file with a display-only masked account label. */
  private storeDisplayAccount(masked: string | null): void {
    if (!masked) return;
    const path = this.settings.paths.robinhoodOauth;
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      doc.display = { agenticAccountMasked: masked, connectedAt: new Date().toISOString() };
      writeJsonAtomic(path, doc, { mode: 0o600 });
    } catch {
      // Display metadata is a nicety; never fail the connection over it.
    }
  }
}

async function fetchAgenticAccountMasked(client: Client): Promise<string | null> {
  const result = await client.callTool({ name: "get_accounts", arguments: {} });
  const agentic = findAgenticAccount(result);
  const accountNumber = typeof agentic?.account_number === "string" ? agentic.account_number : null;
  return accountNumber ? `••••${accountNumber.slice(-4)}` : null;
}

function callbackPage(ok: boolean, message: string): string {
  return (
    "<!doctype html><body style='font-family:system-ui;padding:3rem;max-width:40rem'>" +
    `<h2>${ok ? "Shadow Cortex is connected to Robinhood." : "Connection failed."}</h2>` +
    `<p>${message.replace(/</g, "&lt;")}</p>` +
    "<p>You can close this tab.</p></body>"
  );
}
