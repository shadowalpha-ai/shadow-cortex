/**
 * The chat-AI control surface: a REAL MCP client talks to the engine's MCP
 * server over linked in-memory transports, proxying to a live UiServer —
 * the exact path Claude Desktop uses (minus stdio framing).
 */

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, startLivenessHeartbeat } from "../src/tools/mcp-server.js";
import { UiServer } from "../src/ui/server.js";
import { WebConfirmChannel } from "../src/ui/confirm.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { ProfileStore } from "../src/settings/profile-store.js";
import { MockQuoteProvider, makeSettings, newAudit, newStore, tempDir } from "./helpers.js";
import { join } from "node:path";

let ui: UiServer | null = null;

afterEach(() => {
  ui?.stop();
  ui = null;
});

async function setup() {
  const dir = tempDir();
  const settings = makeSettings({ ui: { enabled: true, port: 0 } });
  const store = newStore(dir);
  const quotes = new MockQuoteProvider({ NVDA: 100 });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const audit = newAudit(dir);
  ui = new UiServer({
    settings,
    store,
    broker,
    gate: new ExecutionGate(settings, broker, quotes, audit),
    sources: [],
    profile: new ProfileStore(join(dir, "profile.json")),
    audit,
    auditPath: join(dir, "audit.jsonl"),
    confirm: new WebConfirmChannel(),
  });
  const port = await ui.start();

  const server = buildServer(`http://127.0.0.1:${port}`);
  const client = new Client({ name: "test-desktop", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

function firstText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.find((c) => c.type === "text")!.text;
}

describe("shadow-cortex MCP server", () => {
  it("exposes the full control surface", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        "confirm_proposal",
        "get_audit",
        "get_connections",
        "get_positions",
        "get_proposals",
        "get_status",
        "get_strategy",
        "get_transactions",
        "list_portfolios",
        "reject_proposal",
        "restart_engine",
        "save_strategy",
        "start_engine",
        "validate_strategy",
      ].sort(),
    );
  });

  it("get_status returns the live account snapshot", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "get_status", arguments: {} });
    const body = JSON.parse(firstText(result));
    expect(body.status.mode).toBe("paper");
    expect(body.account.cash).toBe(10_000);
    expect(body.awaitingConfirmation).toEqual([]);
  });

  it("validate_strategy round-trips the fail-closed validation path", async () => {
    const { client } = await setup();
    const ok = await client.callTool({
      name: "validate_strategy",
      arguments: { settings: { scenario: 3, mode: "paper", execution: "off", marketHoursOnly: false } },
    });
    expect(JSON.parse(firstText(ok)).ok).toBe(true);
    const bad = await client.callTool({
      name: "validate_strategy",
      arguments: { settings: { mode: "yolo" } },
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain("mode");
  });

  it("reject_proposal on an unknown id reports the error instead of throwing", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "reject_proposal", arguments: { id: "prop_nope" } });
    expect(result.isError).toBe(true);
  });

  it("an unreachable engine yields an actionable error naming start_engine", async () => {
    const server = buildServer("http://127.0.0.1:1"); // nothing listens there
    const client = new Client({ name: "test", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: "get_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("start_engine");
  });
});

describe("paste-a-link connector (/mcp over streamable HTTP)", () => {
  it("streamable HTTP client end-to-end against the UiServer", async () => {
    const dir = tempDir();
    const settings = makeSettings({ ui: { enabled: true, port: 0 } });
    const store = newStore(dir);
    const quotes = new MockQuoteProvider({ NVDA: 100 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    const audit = newAudit(dir);
    ui = new UiServer({
      settings,
      store,
      broker,
      gate: new ExecutionGate(settings, broker, quotes, audit),
      sources: [],
      profile: new ProfileStore(join(dir, "profile.json")),
      audit,
      auditPath: join(dir, "audit.jsonl"),
      confirm: new WebConfirmChannel(),
    });
    const port = await ui.start();

    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "connector-sim", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("get_status");
    const result = await client.callTool({ name: "get_status", arguments: {} });
    const body = JSON.parse(firstText(result));
    expect(body.account.cash).toBe(10_000);
    await client.close();

    // The connector traffic marks the Local AI row active.
    const conn = (await (await fetch(`http://127.0.0.1:${port}/api/connections`)).json()) as any;
    expect(conn.localAi.lastSeenAt).not.toBeNull();
    expect(conn.localAi.connectorUrl).toContain("/mcp");
  });

  it("the liveness heartbeat marks the row active with zero tool calls", async () => {
    const dir = tempDir();
    const settings = makeSettings({ ui: { enabled: true, port: 0 } });
    const store = newStore(dir);
    const quotes = new MockQuoteProvider({ NVDA: 100 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    const server = new UiServer({
      settings,
      store,
      broker,
      gate: new ExecutionGate(settings, broker, quotes, newAudit(dir)),
      sources: [],
      profile: new ProfileStore(join(dir, "profile.json")),
      audit: newAudit(dir),
      auditPath: join(dir, "audit.jsonl"),
      confirm: new WebConfirmChannel(),
    });
    const port = await server.start();
    const timer = startLivenessHeartbeat(`http://127.0.0.1:${port}`, 60_000);
    try {
      let lastSeenAt: string | null = null;
      for (let i = 0; i < 40 && !lastSeenAt; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const conn = (await (await fetch(`http://127.0.0.1:${port}/api/connections`)).json()) as any;
        lastSeenAt = conn.localAi.lastSeenAt;
      }
      expect(lastSeenAt).not.toBeNull();
    } finally {
      clearInterval(timer);
      server.stop();
    }
  });

  it("MCP liveness survives an engine restart (persisted in state)", async () => {
    const dir = tempDir();
    const settings = makeSettings({ ui: { enabled: true, port: 0 } });
    const store = newStore(dir);
    const quotes = new MockQuoteProvider({ NVDA: 100 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    const deps = {
      settings,
      broker,
      gate: new ExecutionGate(settings, broker, quotes, newAudit(dir)),
      sources: [],
      profile: new ProfileStore(join(dir, "profile.json")),
      audit: newAudit(dir),
      auditPath: join(dir, "audit.jsonl"),
      confirm: new WebConfirmChannel(),
    };
    const first = new UiServer({ ...deps, store });
    const port = await first.start();
    await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
      headers: { "x-shadow-cortex-client": "mcp" },
    });
    await first.stop();

    // "Restart": a fresh store read from the same state file, a fresh server.
    const second = new UiServer({ ...deps, store: newStore(dir) });
    const port2 = await second.start();
    const conn = (await (await fetch(`http://127.0.0.1:${port2}/api/connections`)).json()) as any;
    await second.stop();
    expect(conn.localAi.lastSeenAt).not.toBeNull();
  });
});
