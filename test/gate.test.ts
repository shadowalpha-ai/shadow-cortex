/**
 * Execution-gate tests: the cap-enforcement suite. No decider exceeds an
 * in-force cap — and exits are NEVER blocked by caps or the daily-loss halt.
 */

import { describe, expect, it } from "vitest";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import {
  MockQuoteProvider,
  makeProposal,
  makeSettings,
  newAudit,
  newStore,
} from "./helpers.js";
import type { Settings } from "../src/settings/schema.js";

function setup(settingsOverrides: Record<string, unknown> = {}, prices: Record<string, number> = {}) {
  const settings: Settings = makeSettings(settingsOverrides);
  const store = newStore();
  const quotes = new MockQuoteProvider({ NVDA: 100, HOOD: 70, ...prices });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const gate = new ExecutionGate(settings, broker, quotes, newAudit());
  return { settings, store, quotes, broker, gate };
}

const HOOD_SEED = {
  paper: {
    startingCash: 10_000,
    seedPositions: [
      { symbol: "HOOD", shares: 100, costBasis: 68, openedAt: "2026-07-10T14:30:00Z" },
    ],
  },
};

describe("entry caps (enforced for every decider)", () => {
  it("refuses an entry above maxSharesPerOrder", async () => {
    const { gate } = setup({ caps: { maxSharesPerOrder: 10 } });
    const outcome = await gate.execute(makeProposal({ suggestedShares: 11 }));
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("maxSharesPerOrder");
  });

  it("refuses an entry above maxDollarsPerPosition", async () => {
    const { gate } = setup({ caps: { maxDollarsPerPosition: 500 } });
    const outcome = await gate.execute(
      makeProposal({ suggestedShares: 6, referencePrice: 100 }),
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("maxDollarsPerPosition");
  });

  it("refuses a new-symbol entry at maxOpenPositions", async () => {
    const { gate } = setup({ caps: { maxOpenPositions: 1 }, ...HOOD_SEED });
    const outcome = await gate.execute(makeProposal({ symbol: "NVDA" }));
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("maxOpenPositions");
  });

  it("refuses entries while the daily-loss halt is active", async () => {
    const { gate } = setup();
    gate.entriesHalted = true;
    const outcome = await gate.execute(makeProposal());
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("daily-loss halt");
  });

  it("a disabled cap (null) is not enforced — the user owns the fence", async () => {
    const { gate } = setup({
      caps: {
        maxSharesPerOrder: null,
        maxDollarsPerPosition: null,
        maxOpenPositions: null,
        maxDailyLoss: null,
      },
    });
    const outcome = await gate.execute(
      makeProposal({ suggestedShares: 50, referencePrice: 100 }),
    );
    expect(outcome.ok).toBe(true);
  });

  it("executes an in-band, in-cap entry", async () => {
    const { gate, broker } = setup();
    const outcome = await gate.execute(makeProposal({ suggestedShares: 0.25 }));
    expect(outcome.ok).toBe(true);
    const positions = await broker.getPositions();
    expect(positions.find((p) => p.symbol === "NVDA")?.shares).toBeCloseTo(0.25);
  });
});

describe("exits are never blocked by entry caps", () => {
  it("executes a stop-loss sell that exceeds every exposure cap, during a daily-loss halt", async () => {
    const { gate } = setup(
      { caps: { maxSharesPerOrder: 1, maxDollarsPerPosition: 10, maxOpenPositions: 1 }, ...HOOD_SEED },
    );
    gate.entriesHalted = true; // worst case: positions bleeding, halt active
    const outcome = await gate.execute(
      makeProposal({ symbol: "HOOD", action: "sell", suggestedShares: 100, referencePrice: 70 }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.filledShares).toBe(100);
  });

  it("exits skip the market-hours gate (entries only)", async () => {
    const { gate } = setup({ marketHoursOnly: true, ...HOOD_SEED });
    const sunday = new Date("2026-07-12T15:00:00Z");
    const outcome = await gate.execute(
      makeProposal({ symbol: "HOOD", action: "sell", suggestedShares: 10, referencePrice: 70 }),
      sunday,
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("shared guards (entries AND exits)", () => {
  it("refuses when the price drifted beyond the band", async () => {
    const { gate } = setup({}, { NVDA: 102 });
    const outcome = await gate.execute(
      makeProposal({ referencePrice: 100, priceBandPct: 1 }),
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("drifted");
  });

  it("refuses an expired proposal", async () => {
    const { gate } = setup();
    const outcome = await gate.execute(
      makeProposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("expired");
  });

  it("blocks entries outside market hours when marketHoursOnly is set", async () => {
    const { gate } = setup({ marketHoursOnly: true });
    const sunday = new Date("2026-07-12T15:00:00Z");
    const outcome = await gate.execute(makeProposal(), sunday);
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("market is closed");
  });

  it("allows entries during regular hours when marketHoursOnly is set", async () => {
    const { gate } = setup({ marketHoursOnly: true });
    const wednesdayOpen = new Date("2026-07-15T15:00:00Z"); // 11:00 ET
    const outcome = await gate.execute(
      makeProposal({
        suggestedShares: 0.25,
        expiresAt: new Date(wednesdayOpen.getTime() + 30 * 60_000).toISOString(),
      }),
      wednesdayOpen,
    );
    expect(outcome.ok).toBe(true);
  });
});
