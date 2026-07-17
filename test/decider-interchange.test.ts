/**
 * Decider interchangeability: any Decider implementation flows through the
 * same router + gate path, and the gate enforces caps identically regardless
 * of which decider proposed the trade.
 */

import { describe, expect, it } from "vitest";
import type { Decider, DecisionContext, Proposal } from "../src/core/types.js";
import { RulesDecider } from "../src/deciders/rules.js";
import { buildDecider } from "../src/deciders/registry.js";
import { ProposalRouter } from "../src/engine/router.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { Narrator } from "../src/narrator/narrator.js";
import {
  MockQuoteProvider,
  makeProposal,
  makeSettings,
  makeSignal,
  newAudit,
  newStore,
} from "./helpers.js";

/** A deliberately reckless stand-in for an AI decider. */
class GreedyStubDecider implements Decider {
  readonly name = "greedy-stub";
  async decide(_ctx: DecisionContext): Promise<Proposal[]> {
    return [
      makeProposal({ symbol: "NVDA", suggestedShares: 0.25, decider: this.name }),
      makeProposal({ symbol: "PLTR", suggestedShares: 9999, decider: this.name, referencePrice: 50 }),
    ];
  }
}

function harness() {
  const settings = makeSettings({ execution: "auto" });
  const store = newStore();
  const quotes = new MockQuoteProvider({ NVDA: 100, PLTR: 50 });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const gate = new ExecutionGate(settings, broker, quotes, newAudit());
  const router = new ProposalRouter(
    settings,
    store,
    gate,
    new Narrator("claude-opus-4-8"),
    newAudit(),
    { ask: async () => true },
  );
  const ctx: DecisionContext = {
    signals: [makeSignal({ strength: 0.9 })],
    positions: [],
    quotes: {
      NVDA: { symbol: "NVDA", price: 100, asOf: new Date().toISOString() },
      PLTR: { symbol: "PLTR", price: 50, asOf: new Date().toISOString() },
    },
    equity: 10_000,
    settings,
    now: new Date(),
  };
  return { settings, store, broker, router, ctx };
}

describe("decider interchangeability", () => {
  it("rules decider proposals execute through the shared path", async () => {
    const { router, broker, ctx } = harness();
    const proposals = await new RulesDecider().decide(ctx);
    for (const p of proposals) await router.route(p);
    expect((await broker.getPositions()).map((p) => p.symbol)).toEqual(["NVDA"]);
  });

  it("a different decider takes the identical path — and cannot exceed a cap", async () => {
    const { router, broker, store, ctx } = harness();
    const proposals = await new GreedyStubDecider().decide(ctx);
    for (const p of proposals) await router.route(p);

    // The sane proposal executed; the cap-busting one was refused by the gate.
    expect((await broker.getPositions()).map((p) => p.symbol)).toEqual(["NVDA"]);
    const byStatus = Object.fromEntries(
      store.state.pendingProposals.map((p) => [p.proposal.symbol, p.status]),
    );
    expect(byStatus).toEqual({ NVDA: "executed", PLTR: "refused" });
  });

  it('registry falls back to rules when decider "claude" has no API key (fail closed)', () => {
    const decider = buildDecider(makeSettings({ decider: "claude" }));
    expect(decider.name).toBe("rules");
  });
});

describe("silent drops are reported (entry_skipped)", () => {
  function skippy() {
    return makeSettings({
      entry: {
        rules: [
          {
            label: "impossible bar",
            source: null,
            symbols: [],
            constraints: [{ field: "strength", op: ">=", value: 0.99 }],
          },
        ],
      },
    });
  }

  async function decideWith(settings: ReturnType<typeof makeSettings>, equity = 10_000) {
    const skips: Array<{ symbol: string; reason: string }> = [];
    const proposals = await new RulesDecider().decide({
      signals: [makeSignal({ strength: 0.5 })],
      positions: [],
      quotes: { NVDA: { symbol: "NVDA", price: 100, asOf: new Date().toISOString() } },
      equity,
      settings,
      now: new Date(),
      onSkip: (s) => skips.push(s),
    });
    return { proposals, skips };
  }

  it("reports when no rule card matches — the 2026-07-16 silent-blocker class", async () => {
    const { proposals, skips } = await decideWith(skippy());
    expect(proposals).toEqual([]);
    expect(skips).toEqual([
      { symbol: "NVDA", reason: "none of the 1 entry rule card(s) matched" },
    ]);
  });

  it("reports the min-R/R fail-closed refusal per symbol", async () => {
    const settings = makeSettings({
      entry: { minRewardRiskRatio: 2 },
      exit: { takeProfitPct: 45, stopLossPct: null },
    });
    const { proposals, skips } = await decideWith(settings);
    expect(proposals).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toContain("fail closed");
  });

  it("reports blocklist hits and zero-share sizing", async () => {
    const blocked = makeSettings({ entry: { symbolBlocklist: ["nvda"] } });
    expect((await decideWith(blocked)).skips[0]!.reason).toContain("blocklist");

    const tiny = makeSettings({
      entry: { rules: [{ label: "match all", source: null, symbols: [], constraints: [] }] },
      sizing: { mode: "percentOfEquity", value: 1, allowFractionalShares: false },
    });
    // 1% of $100 equity = $1 at a $100 price → 0 whole shares.
    const { skips } = await decideWith(tiny, 100);
    expect(skips[0]!.reason).toContain("0 shares");
  });
});
