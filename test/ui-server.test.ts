/**
 * Dashboard API tests: the snapshot endpoint, the confirm/reject round-trip
 * through the WebConfirmChannel, and the not-found path. The server binds
 * 127.0.0.1 on an ephemeral port.
 */

import { afterEach, describe, expect, it } from "vitest";
import { UiServer } from "../src/ui/server.js";
import { WebConfirmChannel } from "../src/ui/confirm.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { ProfileStore } from "../src/settings/profile-store.js";
import { ShadowAlphaPortfolioSource } from "../src/sources/shadowalpha-portfolio.js";
import { FixtureMcpClient } from "../src/sources/mcp-client.js";
import {
  MockQuoteProvider,
  makeProposal,
  makeSettings,
  newAudit,
  newStore,
  tempDir,
} from "./helpers.js";
import { join } from "node:path";

let server: UiServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

async function setup() {
  const settings = makeSettings({
    ui: { enabled: true, port: 0 },
    paper: {
      startingCash: 10_000,
      seedPositions: [
        { symbol: "HOOD", shares: 10, costBasis: 68, openedAt: "2026-07-10T14:30:00Z" },
      ],
    },
  });
  const store = newStore();
  const quotes = new MockQuoteProvider({ HOOD: 70, NVDA: 100 });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const gate = new ExecutionGate(settings, broker, quotes, newAudit());
  const confirm = new WebConfirmChannel();
  server = new UiServer({
    settings,
    store,
    broker,
    gate,
    sources: [],
    profile: new ProfileStore(join(tempDir(), "profile.json")),
    audit: newAudit(),
    auditPath: join(tempDir(), "audit.jsonl"),
    confirm,
  });
  const port = await server.start();
  return { base: `http://127.0.0.1:${port}`, confirm, store, gate };
}

describe("dashboard API", () => {
  it("serves a full snapshot", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/snapshot`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Record<string, any>;
    expect(snap.status.mode).toBe("paper");
    expect(snap.account.equity).toBe(10_700);
    expect(snap.positions[0]).toMatchObject({ symbol: "HOOD", shares: 10 });
    expect(snap.positions[0].highWaterMark).toBe(70);
    expect(Array.isArray(snap.audit)).toBe(true);
  });

  it("confirm endpoint resolves a pending ask as approved", async () => {
    const { base, confirm } = await setup();
    const proposal = makeProposal({ symbol: "NVDA" });
    const answer = confirm.ask(proposal, "BUY $NVDA — test");

    const listed = (await (await fetch(`${base}/api/snapshot`)).json()) as any;
    expect(listed.awaitingConfirm).toHaveLength(1);

    const res = await fetch(`${base}/api/proposals/${proposal.id}/confirm`, { method: "POST" });
    expect(res.status).toBe(200);
    await expect(answer).resolves.toBe(true);
  });

  it("reject endpoint resolves a pending ask as declined", async () => {
    const { base, confirm } = await setup();
    const proposal = makeProposal({ symbol: "NVDA" });
    const answer = confirm.ask(proposal, "BUY $NVDA — test");
    await fetch(`${base}/api/proposals/${proposal.id}/reject`, { method: "POST" });
    await expect(answer).resolves.toBe(false);
  });

  it("answering an unknown or already-resolved proposal is a 404", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/proposals/nope/confirm`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("an unanswered ask times out at the proposal's expiry and declines", async () => {
    await setup();
    const confirm = new WebConfirmChannel();
    const proposal = makeProposal({ expiresAt: new Date(Date.now() + 30).toISOString() });
    await expect(confirm.ask(proposal, "narrated")).resolves.toBe(false);
  });

  it("serves a help page when the React app is not built into ui/dist", async () => {
    const { base } = await setup();
    const res = await fetch(base);
    const html = await res.text();
    // Depending on checkout state the built app may exist; accept either.
    expect(html).toMatch(/Shadow Cortex|<div id="root">/);
  });
});

describe("GET /api/portfolios", () => {
  it("404s with a hint when no portfolio source is configured", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/portfolios`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("no_portfolio_source");
  });

  it("serves the portfolio listing from the configured source", async () => {
    const settings = makeSettings({ ui: { enabled: true, port: 0 } });
    const store = newStore();
    const quotes = new MockQuoteProvider({ HOOD: 70 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    const gate = new ExecutionGate(settings, broker, quotes, newAudit());
    const source = new ShadowAlphaPortfolioSource(
      new FixtureMcpClient("fixtures/portfolio-signals.json"),
      { portfolios: ["Momentum"], listRefreshMinutes: 15 },
    );
    server = new UiServer({
      settings,
      store,
      broker,
      gate,
      sources: [source],
      profile: new ProfileStore(join(tempDir(), "profile.json")),
      audit: newAudit(),
      auditPath: join(tempDir(), "audit.jsonl"),
      confirm: new WebConfirmChannel(),
    });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/portfolios`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.portfolios).toEqual([
      { id: 12, name: "Momentum", status: "active", winRatePct: 63.2, returnPct: 24.8 },
      { id: 9, name: "Paused Experiments", status: "paused", winRatePct: null, returnPct: null },
    ]);
  });
});
