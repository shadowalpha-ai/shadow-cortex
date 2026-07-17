/**
 * Connections API: token save/validate/disconnect (ShadowAlpha), status
 * precedence (env wins over file), Robinhood status from the oauth file,
 * the restart route, and credential hygiene (0600 files, no token echo).
 * The live validator is injected — no network.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UiServer } from "../src/ui/server.js";
import { ConnectionsApi } from "../src/ui/connections-api.js";
import { WebConfirmChannel } from "../src/ui/confirm.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { ProfileStore } from "../src/settings/profile-store.js";
import {
  resolveShadowAlphaToken,
  shadowAlphaTokenSource,
} from "../src/settings/credentials.js";
import { MockQuoteProvider, makeSettings, newAudit, newStore, tempDir } from "./helpers.js";
import type { Settings } from "../src/settings/schema.js";

let server: UiServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
  delete process.env.SHADOWALPHA_MCP_TOKEN;
});

function settingsIn(dir: string): Settings {
  return makeSettings({
    ui: { enabled: true, port: 0 },
    paths: {
      shadowalphaToken: join(dir, "shadowalpha-token.json"),
      robinhoodOauth: join(dir, "robinhood-oauth.json"),
      stateFile: join(dir, "state.json"),
      auditLog: join(dir, "audit.jsonl"),
    },
  });
}

async function setup(opts: {
  validator?: (url: string, token: string) => Promise<void>;
  requestRestart?: () => void;
  dir?: string;
} = {}) {
  const dir = opts.dir ?? tempDir();
  const settings = settingsIn(dir);
  const store = newStore(dir);
  const quotes = new MockQuoteProvider({ NVDA: 100 });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const audit = newAudit(dir);
  server = new UiServer({
    settings,
    store,
    broker,
    gate: new ExecutionGate(settings, broker, quotes, audit),
    sources: [],
    profile: new ProfileStore(join(dir, "profile.json")),
    audit,
    auditPath: settings.paths.auditLog,
    confirm: new WebConfirmChannel(),
    requestRestart: opts.requestRestart,
    connections: new ConnectionsApi(settings, audit, opts.validator ?? (async () => {})),
  });
  const port = await server.start();
  return { base: `http://127.0.0.1:${port}`, settings, dir };
}

describe("ShadowAlpha connection", () => {
  it("validates the token live, saves it 0600, and the engine resolves it", async () => {
    const validated: string[] = [];
    const { base, settings } = await setup({
      validator: async (_url, token) => {
        validated.push(token);
      },
    });
    const res = await fetch(`${base}/api/connections/shadowalpha`, {
      method: "POST",
      body: JSON.stringify({ token: "  sa-token-123  " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.restartRequired).toBe(true);
    expect(body.status.shadowalpha).toEqual({ connected: true, source: "file" });
    expect(validated).toEqual(["sa-token-123"]); // trimmed before validation
    expect(statSync(settings.paths.shadowalphaToken).mode & 0o777).toBe(0o600);
    expect(resolveShadowAlphaToken(settings.paths.shadowalphaToken)).toBe("sa-token-123");
    // The response body never echoes the token.
    expect(JSON.stringify(body)).not.toContain("sa-token-123");
  });

  it("a rejected token writes nothing", async () => {
    const { base, settings } = await setup({
      validator: async () => {
        throw new Error("401 unauthorized");
      },
    });
    const res = await fetch(`${base}/api/connections/shadowalpha`, {
      method: "POST",
      body: JSON.stringify({ token: "bad" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(settings.paths.shadowalphaToken)).toBe(false);
  });

  it("disconnect removes the file; env-sourced tokens refuse with guidance", async () => {
    const { base, settings } = await setup();
    await fetch(`${base}/api/connections/shadowalpha`, {
      method: "POST",
      body: JSON.stringify({ token: "sa-1" }),
    });
    const del = await fetch(`${base}/api/connections/shadowalpha`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(settings.paths.shadowalphaToken)).toBe(false);

    process.env.SHADOWALPHA_MCP_TOKEN = "env-token";
    const envDel = await fetch(`${base}/api/connections/shadowalpha`, { method: "DELETE" });
    expect(envDel.status).toBe(409);
    expect(shadowAlphaTokenSource(settings.paths.shadowalphaToken)).toBe("env");
  });

  it("env var wins over the saved file", () => {
    const dir = tempDir();
    const path = join(dir, "shadowalpha-token.json");
    writeFileSync(path, JSON.stringify({ token: "file-token" }));
    process.env.SHADOWALPHA_MCP_TOKEN = "env-token";
    expect(resolveShadowAlphaToken(path)).toBe("env-token");
    expect(shadowAlphaTokenSource(path)).toBe("env");
    delete process.env.SHADOWALPHA_MCP_TOKEN;
    expect(resolveShadowAlphaToken(path)).toBe("file-token");
  });
});

describe("Robinhood connection status", () => {
  it("reports connected + masked account from the oauth file, and disconnect deletes it", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "robinhood-oauth.json"),
      JSON.stringify({
        tokens: { access_token: "tok", token_type: "Bearer" },
        display: { agenticAccountMasked: "••••4242" },
      }),
    );
    const { base, settings } = await setup({ dir });
    const status = (await (await fetch(`${base}/api/connections`)).json()) as any;
    expect(status.robinhood).toEqual({ connected: true, account: "••••4242" });
    // No token material in the status payload.
    expect(JSON.stringify(status)).not.toContain("tok");

    const del = await fetch(`${base}/api/connections/robinhood`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(settings.paths.robinhoodOauth)).toBe(false);
  });

  it("callback with no pending flow is a clear 400 page", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/connections/robinhood/callback?code=abc`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No connection attempt is in progress");
  });
});

describe("engine restart route", () => {
  it("responds ok then invokes the restart hook", async () => {
    let restarted = false;
    const { base } = await setup({
      requestRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(`${base}/api/engine/restart`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).restarting).toBe(true);
    await new Promise((r) => setTimeout(r, 350)); // hook fires after the response flushes
    expect(restarted).toBe(true);
  });

  it("returns 501 when no supervisor hook is wired", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/engine/restart`, { method: "POST" });
    expect(res.status).toBe(501);
  });
});
