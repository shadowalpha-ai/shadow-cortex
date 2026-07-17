/**
 * File-backed OAuth provider for the Robinhood agentic-trading MCP.
 *
 * Implements the MCP SDK's OAuthClientProvider so the ENGINE holds its own
 * connection (Claude Code's token is not reusable — different OAuth client).
 * One JSON document persists the dynamically-registered client information,
 * the tokens, and the in-flight PKCE verifier:
 *
 *   state/robinhood-oauth.json   (state/ is gitignored; file mode 0600)
 *
 * Two postures share this class:
 * - The connect CLI (`npm run robinhood:connect`) passes `onRedirect` and a
 *   loopback `redirectUrl` — the interactive, browser-opening flow.
 * - The engine passes NEITHER: with valid tokens the SDK silently refreshes;
 *   when interaction would be required it fails CLOSED with an actionable
 *   error naming the connect command. The engine never opens a browser.
 *
 * SECURITY: tokens never go in profiles, logs, or the repo. This module logs
 * nothing but presence/absence.
 */

import { writeJsonAtomic } from "../core/atomic-write.js";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CONNECT_HINT =
  "no usable Robinhood connection — run `npm run robinhood:connect` to authorize the engine (one-time, browser + Robinhood app approval)";

export class RobinhoodAuthRequiredError extends Error {}

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** OAuth state parameter for the in-flight flow (CSRF check at callback). */
  oauthState?: string;
}

interface FileOAuthProviderOptions {
  /** The loopback callback URL (connect CLI only). */
  redirectUrl?: string;
  /** Where to send the user's browser (connect CLI only). Absent = fail closed. */
  onRedirect?: (url: URL) => void;
}

export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly filePath: string,
    private readonly options: FileOAuthProviderOptions = {},
  ) {}

  get redirectUrl(): string | undefined {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "shadow-cortex",
      redirect_uris: this.options.redirectUrl ? [this.options.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: no secret; PKCE carries the proof.
      token_endpoint_auth_method: "none",
    };
  }

  /**
   * Fresh state per flow, persisted for the callback's CSRF check. Also flow
   * glue: some authorization pages (SPAs) misbehave when state is absent.
   */
  state(): string {
    const value = randomUUID();
    this.update((doc) => {
      doc.oauthState = value;
    });
    return value;
  }

  /** The state the current flow was started with (cleared on consume). */
  consumeState(): string | undefined {
    const value = this.load().oauthState;
    this.update((doc) => {
      delete doc.oauthState;
    });
    return value;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.load().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.update((doc) => {
      doc.clientInformation = clientInformation;
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.update((doc) => {
      doc.tokens = tokens;
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.options.onRedirect) {
      this.options.onRedirect(authorizationUrl);
      return;
    }
    // The unattended engine can't send anyone to a browser — fail closed
    // with the action instead.
    throw new RobinhoodAuthRequiredError(CONNECT_HINT);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update((doc) => {
      doc.codeVerifier = codeVerifier;
    });
  }

  codeVerifier(): string {
    const verifier = this.load().codeVerifier;
    if (!verifier) throw new RobinhoodAuthRequiredError(CONNECT_HINT);
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    this.update((doc) => {
      if (scope === "all" || scope === "tokens") delete doc.tokens;
      if (scope === "all" || scope === "client") delete doc.clientInformation;
      if (scope === "all" || scope === "verifier") delete doc.codeVerifier;
    });
  }

  // --- persistence (atomic, owner-only) ---

  private load(): StoredAuth {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StoredAuth;
    } catch {
      return {};
    }
  }

  private update(mutate: (doc: StoredAuth) => void): void {
    const doc = this.load();
    mutate(doc);
    writeJsonAtomic(this.filePath, doc, { mode: 0o600 });
  }
}

/**
 * The one predicate boot validation and the settings API use: is there a
 * stored access token at all? (Says nothing about expiry — the SDK refreshes
 * expired tokens itself; a dead refresh surfaces as a fail-closed
 * RobinhoodAuthRequiredError at runtime.)
 */
export function hasRobinhoodTokens(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const doc = JSON.parse(readFileSync(filePath, "utf8")) as StoredAuth;
    return typeof doc.tokens?.access_token === "string" && doc.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}
