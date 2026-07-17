import { describe, expect, it } from "vitest";
import { evaluateExit } from "../src/exits/policies.js";
import type { Position } from "../src/core/types.js";
import { makePosition, makeSettings } from "./helpers.js";

const exit = makeSettings().exit; // stop 5% / trail 7% / take-profit 15% / 72h

describe("exit policies", () => {
  it("fires the hard stop-loss off cost basis", () => {
    const decision = evaluateExit(
      makePosition({ costBasis: 100, currentPrice: 94.9, highWaterMark: 101 }),
      exit,
    );
    expect(decision?.rule).toBe("stop-loss");
  });

  it("fires the trailing stop off the high-water mark", () => {
    const decision = evaluateExit(
      makePosition({ costBasis: 68, currentPrice: 67.9, highWaterMark: 73.1 }),
      exit,
    );
    expect(decision?.rule).toBe("trailing-stop");
  });

  it("fires take-profit at the target", () => {
    const decision = evaluateExit(
      makePosition({ costBasis: 100, currentPrice: 115.1, highWaterMark: 115.1 }),
      exit,
    );
    expect(decision?.rule).toBe("take-profit");
  });

  it("fires max-hold after the holding period", () => {
    const decision = evaluateExit(
      makePosition({
        costBasis: 100,
        currentPrice: 101,
        highWaterMark: 102,
        openedAt: new Date(Date.now() - 73 * 3_600_000).toISOString(),
      }),
      exit,
    );
    expect(decision?.rule).toBe("max-hold");
  });

  it("stop-loss beats take-profit when both could apply (risk wins)", () => {
    // Degenerate config: stop and target overlap. The stop must win.
    const decision = evaluateExit(
      makePosition({ costBasis: 100, currentPrice: 94, highWaterMark: 130 }),
      { stopLossPct: 5, trailingStopPct: null, trailActivationPct: null, takeProfitPct: null, maxHoldDays: null, atrStopMultiplier: null, atrPeriod: 14, breakevenDays: null, breakevenMinMovePct: null, partialTpPct: null, partialCloseFraction: 0.5 },
    );
    expect(decision?.rule).toBe("stop-loss");
  });

  it("returns null when nothing fires", () => {
    const decision = evaluateExit(
      makePosition({ costBasis: 100, currentPrice: 102, highWaterMark: 103 }),
      exit,
    );
    expect(decision).toBeNull();
  });

  it("disabled rules (null) never fire — the user owns every cap", () => {
    const decision = evaluateExit(
      makePosition({ costBasis: 100, currentPrice: 50, highWaterMark: 100 }),
      { stopLossPct: null, trailingStopPct: null, trailActivationPct: null, takeProfitPct: null, maxHoldDays: null, atrStopMultiplier: null, atrPeriod: 14, breakevenDays: null, breakevenMinMovePct: null, partialTpPct: null, partialCloseFraction: 0.5 },
    );
    expect(decision).toBeNull();
  });
});

describe("expanded exit rules", () => {
  const base = {
    stopLossPct: null,
    trailingStopPct: null,
    trailActivationPct: null,
    takeProfitPct: null,
    maxHoldDays: null,
    atrStopMultiplier: null,
    atrPeriod: 14,
    breakevenDays: null,
    breakevenMinMovePct: null,
    partialTpPct: null,
    partialCloseFraction: 0.5,
  };
  const pos = (over: Partial<Position> = {}): Position => ({
    symbol: "NVDA",
    shares: 10,
    costBasis: 100,
    currentPrice: 100,
    unrealizedPnlPct: 0,
    highWaterMark: 100,
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  });

  it("trail activation: the trail stays disarmed until the position has been up enough", () => {
    const exit = { ...base, trailingStopPct: 2, trailActivationPct: 4 };
    // Peak only +2% → trail not armed, even though price fell 2% off peak.
    expect(evaluateExit(pos({ highWaterMark: 102, currentPrice: 99.9 }), exit)).toBeNull();
    // Peak reached +4% → armed; a 2% drop off the peak fires.
    const fired = evaluateExit(pos({ highWaterMark: 104, currentPrice: 101.9 }), exit);
    expect(fired?.rule).toBe("trailing-stop");
    // Armed but price holding above the trail → no exit.
    expect(evaluateExit(pos({ highWaterMark: 104, currentPrice: 102.5 }), exit)).toBeNull();
  });

  it("ATR stop fires off the peak scaled by volatility, and is skipped without ATR", () => {
    const exit = { ...base, atrStopMultiplier: 1.1, atrPeriod: 14 };
    // ATR 2.0 → stop = 104 − 2.2 = 101.8
    expect(
      evaluateExit(pos({ highWaterMark: 104, currentPrice: 101.7 }), exit, new Date(), { atr: 2 })?.rule,
    ).toBe("atr-stop");
    expect(
      evaluateExit(pos({ highWaterMark: 104, currentPrice: 101.9 }), exit, new Date(), { atr: 2 }),
    ).toBeNull();
    // No ATR available → rule skipped entirely (fail closed on the DATA, not the position).
    expect(
      evaluateExit(pos({ highWaterMark: 104, currentPrice: 90 }), exit, new Date(), { atr: null }),
    ).toBeNull();
  });

  it("partial take-profit fires once with the configured fraction", () => {
    const exit = { ...base, partialTpPct: 10, partialCloseFraction: 0.5 };
    const decision = evaluateExit(pos({ currentPrice: 111, highWaterMark: 111 }), exit);
    expect(decision?.rule).toBe("partial-take-profit");
    expect(decision?.fraction).toBe(0.5);
    // Already taken → never again for this position.
    expect(
      evaluateExit(pos({ currentPrice: 120, highWaterMark: 120 }), exit, new Date(), { partialTaken: true }),
    ).toBeNull();
  });

  it("partial fires before the full take-profit when both are configured", () => {
    const exit = { ...base, partialTpPct: 10, takeProfitPct: 15, partialCloseFraction: 0.5 };
    expect(evaluateExit(pos({ currentPrice: 116, highWaterMark: 116 }), exit)?.rule).toBe("partial-take-profit");
    // With the partial already taken, the full target owns the exit.
    expect(
      evaluateExit(pos({ currentPrice: 116, highWaterMark: 116 }), exit, new Date(), { partialTaken: true })?.rule,
    ).toBe("take-profit");
  });

  it("breakeven/dead-money frees capital that hasn't moved", () => {
    const exit = { ...base, breakevenDays: 5, breakevenMinMovePct: 2 };
    const old = new Date(Date.now() - 6 * 86_400_000).toISOString();
    expect(
      evaluateExit(pos({ openedAt: old, currentPrice: 101, unrealizedPnlPct: 1 }), exit)?.rule,
    ).toBe("breakeven");
    // Moved enough → keeps running.
    expect(
      evaluateExit(pos({ openedAt: old, currentPrice: 103, unrealizedPnlPct: 3 }), exit),
    ).toBeNull();
    // Too young → not judged yet.
    expect(evaluateExit(pos({ currentPrice: 100, unrealizedPnlPct: 0 }), exit)).toBeNull();
  });

  it("maxHoldDays fires on age", () => {
    const exit = { ...base, maxHoldDays: 3 };
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString();
    expect(evaluateExit(pos({ openedAt: old }), exit)?.rule).toBe("max-hold");
    expect(evaluateExit(pos(), exit)).toBeNull();
  });

  it("risk stops outrank targets: stop-loss beats a simultaneous partial", () => {
    // Contrived but pins the order: price breached the hard stop AND the
    // partial target math (via a stale peak) — the stop must win.
    const exit = { ...base, stopLossPct: 5, partialTpPct: 10 };
    expect(evaluateExit(pos({ currentPrice: 94, highWaterMark: 112 }), exit)?.rule).toBe("stop-loss");
  });
});

describe("ATR computation and providers", () => {
  it("computeAtr uses true range incl. gaps", async () => {
    const { computeAtr } = await import("../src/exits/atr.js");
    // Day 2 gaps up: TR = max(2, |106-100|, |104-100|) = 6; day 3 quiet: TR = 2.
    const atr = computeAtr(
      [
        { high: 101, low: 99, close: 100 },
        { high: 106, low: 104, close: 105 },
        { high: 106, low: 104, close: 105 },
      ],
      14,
    );
    expect(atr).toBe(4); // (6 + 2) / 2
    expect(computeAtr([{ high: 1, low: 1, close: 1 }], 14)).toBeNull();
  });

  it("fixture provider approximates ATR from the replayed closes", async () => {
    const { FixtureAtrProvider } = await import("../src/exits/atr.js");
    const provider = new FixtureAtrProvider(
      new URL("../fixtures/quotes.json", import.meta.url).pathname,
    );
    const atr = await provider.getAtr("NVDA", 14);
    expect(atr).toBeGreaterThan(0);
    expect(await provider.getAtr("ZZZZ", 14)).toBeNull();
  });

  it("shadowalpha provider computes from captured-shape candles and caches", async () => {
    const { ShadowAlphaAtrProvider } = await import("../src/exits/atr.js");
    let calls = 0;
    const mcp = {
      callTool: async () => {
        calls++;
        return {
          daily_candles: [
            { date: "2026-07-13", open: 208.5, high: 210.6, low: 203.4, close: 204.4, volume: 1 },
            { date: "2026-07-14", open: 205.0, high: 212.0, low: 204.0, close: 211.8, volume: 1 },
            { date: "2026-07-15", open: 211.0, high: 213.0, low: 209.0, close: 212.5, volume: 1 },
          ],
        };
      },
    };
    const provider = new ShadowAlphaAtrProvider(mcp, 60);
    const atr = await provider.getAtr("NVDA", 14);
    expect(atr).toBeGreaterThan(0);
    await provider.getAtr("NVDA", 14);
    expect(calls).toBe(1); // cached
  });
});

describe("min reward/risk entry gate", () => {
  it("refuses entries when the configured exits can't clear the bar — or can't compute it", async () => {
    const { RulesDecider } = await import("../src/deciders/rules.js");
    const { makeSettings, makeSignal } = await import("./helpers.js");
    const decider = new RulesDecider();
    const ctx = (settings: ReturnType<typeof makeSettings>) => ({
      signals: [makeSignal({ symbol: "NVDA", strength: 0.9 })],
      positions: [],
      quotes: { NVDA: { symbol: "NVDA", price: 100, asOf: new Date().toISOString() } },
      equity: 10_000,
      settings,
      now: new Date(),
    });
    // 15% target / 5% stop = 3.0 R/R
    const passes = makeSettings({ entry: { minRewardRiskRatio: 2.5 } });
    expect(await decider.decide(ctx(passes))).toHaveLength(1);
    const fails = makeSettings({ entry: { minRewardRiskRatio: 4 } });
    expect(await decider.decide(ctx(fails))).toHaveLength(0);
    // Gate on but no stop configured → cannot compute → refuse (fail closed).
    const uncomputable = makeSettings({
      entry: { minRewardRiskRatio: 2 },
      exit: { stopLossPct: null },
    });
    expect(await decider.decide(ctx(uncomputable))).toHaveLength(0);
  });
});
