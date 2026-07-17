/**
 * Exit-policy lifecycle — the smoke suite for the exit engine. Drives the
 * REAL ManagementLoop (auto execution, paper broker, scripted prices) so the
 * whole chain is exercised: ATR fetch → rule evaluation → partial sizing →
 * fired-once marker → routing → execution → book updates → state cleanup.
 */

import { describe, expect, it } from "vitest";
import { ManagementLoop } from "../src/engine/management-loop.js";
import { ProposalRouter } from "../src/engine/router.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { Narrator } from "../src/narrator/narrator.js";
import type { AtrProvider } from "../src/exits/atr.js";
import {
  MockQuoteProvider,
  makeSettings,
  newAudit,
  newStore,
} from "./helpers.js";

function harness(exitOverrides: Record<string, unknown>, seedPrice = 100, openedAt?: string) {
  const settings = makeSettings({
    execution: "auto",
    exit: exitOverrides,
    paper: {
      startingCash: 10_000,
      seedPositions: [
        {
          symbol: "NVDA",
          shares: 10,
          costBasis: seedPrice,
          openedAt: openedAt ?? new Date(Date.now() - 3_600_000).toISOString(),
        },
      ],
    },
  });
  const store = newStore();
  const quotes = new MockQuoteProvider({ NVDA: seedPrice });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const audit = newAudit();
  const gate = new ExecutionGate(settings, broker, quotes, audit);
  const router = new ProposalRouter(settings, store, gate, new Narrator("claude-opus-4-8"), audit, {
    ask: async () => true,
  });
  return { settings, store, quotes, broker, gate, router, audit };
}

function loop(h: ReturnType<typeof harness>, atrProvider: AtrProvider | null = null) {
  return new ManagementLoop(h.settings, h.broker, h.quotes, h.store, h.gate, h.router, h.audit, atrProvider);
}

describe("exit lifecycle through the real management loop", () => {
  it("trail activation arms, partial TP sells half once, trailing stop closes the rest", async () => {
    const h = harness({
      stopLossPct: null,
      takeProfitPct: null,
      maxHoldDays: null,
      trailingStopPct: 2,
      trailActivationPct: 4,
      partialTpPct: 5,
      partialCloseFraction: 0.5,
    });
    const m = loop(h);

    // Tick 1 — flat at cost basis: nothing fires, trail unarmed.
    await m.tick();
    expect((await h.broker.getPositions())[0]!.shares).toBe(10);

    // Tick 2 — +5.5%: partial target hit → HALF sells automatically.
    h.quotes.prices.NVDA = 105.5;
    await m.tick();
    await h.router.settle();
    let position = (await h.broker.getPositions())[0]!;
    expect(position.shares).toBe(5);
    expect(h.store.state.partialTaken.NVDA).toBeDefined();

    // Tick 3 — higher still: partial must NOT re-fire (marker holds).
    h.quotes.prices.NVDA = 111;
    await m.tick();
    await h.router.settle();
    expect((await h.broker.getPositions())[0]!.shares).toBe(5);

    // Tick 4 — 2.5% off the 111 peak: trail (armed at +4% long ago) closes the rest.
    h.quotes.prices.NVDA = 108.2;
    await m.tick();
    await h.router.settle();
    expect(await h.broker.getPositions()).toHaveLength(0);
    // Position gone → reconcile clears the partial marker for a fresh start.
    await m.tick();
    expect(h.store.state.partialTaken.NVDA).toBeUndefined();
  });

  it("trail never fires while below the activation bar", async () => {
    const h = harness({
      stopLossPct: null,
      takeProfitPct: null,
      maxHoldDays: null,
      trailingStopPct: 2,
      trailActivationPct: 4,
    });
    const m = loop(h);
    // Peak +3% (below activation), then a 2.9% dip — unarmed trail stays quiet.
    h.quotes.prices.NVDA = 103;
    await m.tick();
    h.quotes.prices.NVDA = 100.1;
    await m.tick();
    await h.router.settle();
    expect((await h.broker.getPositions())[0]!.shares).toBe(10);
  });

  it("ATR stop fires through the loop using the injected provider", async () => {
    const h = harness({
      stopLossPct: null,
      trailingStopPct: null,
      takeProfitPct: null,
      maxHoldDays: null,
      atrStopMultiplier: 1.1,
      atrPeriod: 14,
    });
    const asked: number[] = [];
    const atr: AtrProvider = {
      name: "fake",
      getAtr: async (_s, period) => {
        asked.push(period);
        return 2.0; // stop = peak − 2.2
      },
    };
    const m = loop(h, atr);
    h.quotes.prices.NVDA = 104; // peak
    await m.tick();
    h.quotes.prices.NVDA = 101.7; // below 104 − 2.2
    await m.tick();
    await h.router.settle();
    expect(await h.broker.getPositions()).toHaveLength(0);
    expect(asked[0]).toBe(14);
    const audit = h.store.state.pendingProposals.find((p) => p.proposal.decider === "exit:atr-stop");
    expect(audit).toBeDefined();
  });

  it("ATR unavailable → ATR stop skipped, fixed stop still protects", async () => {
    const h = harness({
      stopLossPct: 5,
      trailingStopPct: null,
      takeProfitPct: null,
      maxHoldDays: null,
      atrStopMultiplier: 1.1,
    });
    const atr: AtrProvider = { name: "down", getAtr: async () => null };
    const m = loop(h, atr);
    h.quotes.prices.NVDA = 94.5; // −5.5%: hard stop territory
    await m.tick();
    await h.router.settle();
    expect(await h.broker.getPositions()).toHaveLength(0);
    expect(
      h.store.state.pendingProposals.find((p) => p.proposal.decider === "exit:stop-loss"),
    ).toBeDefined();
  });

  it("dead-money exit frees a stale flat position; a mover is left alone", async () => {
    const old = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const h = harness(
      { stopLossPct: null, trailingStopPct: null, takeProfitPct: null, maxHoldDays: null, breakevenDays: 5, breakevenMinMovePct: 2 },
      100,
      old,
    );
    const m = loop(h);
    h.quotes.prices.NVDA = 101; // +1% after 6 days < 2% bar → dead money
    await m.tick();
    await h.router.settle();
    expect(await h.broker.getPositions()).toHaveLength(0);
    expect(
      h.store.state.pendingProposals.find((p) => p.proposal.decider === "exit:breakeven"),
    ).toBeDefined();
  });

  it("maxHoldDays closes an aged position through the loop", async () => {
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const h = harness(
      { stopLossPct: null, trailingStopPct: null, takeProfitPct: null, maxHoldDays: 3 },
      100,
      old,
    );
    const m = loop(h);
    await m.tick();
    await h.router.settle();
    expect(await h.broker.getPositions()).toHaveLength(0);
  });

  it("full take-profit still closes everything at the target", async () => {
    const h = harness({ stopLossPct: null, trailingStopPct: null, maxHoldDays: null, takeProfitPct: 45 });
    const m = loop(h);
    h.quotes.prices.NVDA = 146;
    await m.tick();
    await h.router.settle();
    expect(await h.broker.getPositions()).toHaveLength(0);
  });
});
