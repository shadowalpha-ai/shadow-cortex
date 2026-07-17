/**
 * Engine-side Robinhood OAuth: file-backed provider persistence, fail-closed
 * engine posture, the runnable-issues gating matrix, and broker quotes.
 * No network anywhere — the provider is pure file I/O.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FileOAuthProvider,
  RobinhoodAuthRequiredError,
  hasRobinhoodTokens,
} from "../src/execution/robinhood-oauth.js";
import {
  BROKER_QUOTES_REQUIRE_LIVE_BROKER,
  LIVE_MODE_NOT_CONNECTED,
  LIVE_MODE_REQUIRES_BROKER,
  runnableIssues,
} from "../src/settings/validate.js";
import { BrokerQuoteProvider, QuoteError } from "../src/execution/quotes.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import { makeSettings, tempDir } from "./helpers.js";

const TOKENS = {
  access_token: "test-access",
  token_type: "Bearer",
  refresh_token: "test-refresh",
  expires_in: 3600,
};

function tokenFile(dir: string = tempDir()): string {
  const path = join(dir, "robinhood-oauth.json");
  writeFileSync(path, JSON.stringify({ tokens: TOKENS }));
  return path;
}

describe("FileOAuthProvider persistence", () => {
  it("round-trips client information, tokens, and the PKCE verifier", () => {
    const path = join(tempDir(), "auth.json");
    const provider = new FileOAuthProvider(path);
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();

    provider.saveClientInformation({ client_id: "abc", redirect_uris: [] });
    provider.saveTokens(TOKENS);
    provider.saveCodeVerifier("verifier123");

    // A separate instance (separate process in real life) sees the same state.
    const reread = new FileOAuthProvider(path);
    expect(reread.clientInformation()?.client_id).toBe("abc");
    expect(reread.tokens()?.access_token).toBe("test-access");
    expect(reread.codeVerifier()).toBe("verifier123");
  });

  it("writes the token file owner-only (0600)", () => {
    const path = join(tempDir(), "auth.json");
    new FileOAuthProvider(path).saveTokens(TOKENS);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("invalidateCredentials removes exactly the requested scope", () => {
    const path = join(tempDir(), "auth.json");
    const provider = new FileOAuthProvider(path);
    provider.saveClientInformation({ client_id: "abc", redirect_uris: [] });
    provider.saveTokens(TOKENS);
    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe("abc");
    provider.invalidateCredentials("all");
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("fails closed when the engine would need a browser (no onRedirect)", () => {
    const provider = new FileOAuthProvider(join(tempDir(), "auth.json"));
    expect(() => provider.redirectToAuthorization(new URL("https://example.com/authorize"))).toThrow(
      RobinhoodAuthRequiredError,
    );
  });

  it("calls onRedirect in interactive (connect CLI) mode", () => {
    let sent: string | null = null;
    const provider = new FileOAuthProvider(join(tempDir(), "auth.json"), {
      redirectUrl: "http://127.0.0.1:1234/callback",
      onRedirect: (url) => {
        sent = url.toString();
      },
    });
    provider.redirectToAuthorization(new URL("https://example.com/authorize?x=1"));
    expect(sent).toBe("https://example.com/authorize?x=1");
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:1234/callback"]);
  });

  it("hasRobinhoodTokens: missing file / broken JSON / empty token are all false", () => {
    const dir = tempDir();
    expect(hasRobinhoodTokens(join(dir, "nope.json"))).toBe(false);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(hasRobinhoodTokens(broken)).toBe(false);
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ tokens: { access_token: "" } }));
    expect(hasRobinhoodTokens(empty)).toBe(false);
    expect(hasRobinhoodTokens(tokenFile(dir))).toBe(true);
  });
});

describe("runnableIssues gating (fail closed until connected)", () => {
  it("live with no liveBroker refuses — never silently paper-trades", () => {
    const settings = makeSettings({ mode: "live", execution: "off" });
    const issues = runnableIssues(settings);
    expect(issues.map((i) => i.message)).toContain(LIVE_MODE_REQUIRES_BROKER);
  });

  it("live + robinhood without a token file refuses, naming the connect command", () => {
    const settings = makeSettings({
      mode: "live",
      execution: "off",
      liveBroker: "robinhood",
      paths: { robinhoodOauth: join(tempDir(), "missing.json") },
    });
    const issues = runnableIssues(settings);
    expect(issues.map((i) => i.message)).toContain(LIVE_MODE_NOT_CONNECTED);
    expect(LIVE_MODE_NOT_CONNECTED).toContain("robinhood:connect");
  });

  it("live + robinhood with a token file is runnable", () => {
    const settings = makeSettings({
      mode: "live",
      execution: "off",
      liveBroker: "robinhood",
      paths: { robinhoodOauth: tokenFile() },
    });
    expect(runnableIssues(settings)).toEqual([]);
  });

  it("broker quotes require the connected live broker", () => {
    const paperWithBrokerQuotes = makeSettings({ quoteSource: "broker" });
    expect(runnableIssues(paperWithBrokerQuotes).map((i) => i.message)).toContain(
      BROKER_QUOTES_REQUIRE_LIVE_BROKER,
    );
    const connected = makeSettings({
      mode: "live",
      execution: "off",
      liveBroker: "robinhood",
      quoteSource: "broker",
      paths: { robinhoodOauth: tokenFile() },
    });
    expect(runnableIssues(connected)).toEqual([]);
  });
});

describe("BrokerQuoteProvider", () => {
  it("maps the broker's batched quotes and fails closed on missing prices", async () => {
    const provider = new BrokerQuoteProvider({
      getQuotes: async (symbols) => new Map(symbols.includes("NVDA") ? [["NVDA", 211.57]] : []),
    });
    const quote = await provider.getQuote("nvda");
    expect(quote).toMatchObject({ symbol: "NVDA", price: 211.57 });
    await expect(provider.getQuote("MSFT")).rejects.toThrow(QuoteError);
  });
});

describe("live orchestrator construction (offline)", () => {
  it("constructs mode live + robinhood with a token file, touching no network", () => {
    const dir = tempDir();
    const settings = makeSettings({
      mode: "live",
      execution: "off",
      liveBroker: "robinhood",
      quoteSource: "broker",
      paths: {
        robinhoodOauth: tokenFile(dir),
        stateFile: join(dir, "state.json"),
        auditLog: join(dir, "audit.jsonl"),
      },
    });
    // Lazy MCP connect: construction must not throw or open a socket.
    expect(() => new Orchestrator(settings)).not.toThrow();
    // No token material may leak into anything the constructor wrote.
    if (existsSync(join(dir, "audit.jsonl"))) {
      expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("test-access");
    }
  });

  it("refuses construction for live mode without a connection", () => {
    const dir = tempDir();
    const settings = makeSettings({
      mode: "live",
      execution: "off",
      liveBroker: "robinhood",
      paths: {
        robinhoodOauth: join(dir, "missing.json"),
        stateFile: join(dir, "state.json"),
        auditLog: join(dir, "audit.jsonl"),
      },
    });
    expect(() => new Orchestrator(settings)).toThrow(LIVE_MODE_NOT_CONNECTED.slice(0, 40));
  });
});
