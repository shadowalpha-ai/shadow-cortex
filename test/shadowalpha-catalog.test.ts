/**
 * The expanded ShadowAlpha catalog: the analyst-predictions feed (with the
 * analyst-stats join) and the conviction./predictions. symbol enrichment —
 * pinned against fixtures shaped like live captures (2026-07-16).
 */

import { describe, expect, it } from "vitest";
import { ShadowAlphaPredictionsSource } from "../src/sources/shadowalpha-predictions.js";
import { ShadowAlphaEnricher } from "../src/enrichment/shadowalpha.js";
import { CompositeEnricher } from "../src/enrichment/enricher.js";
import { FixtureMcpClient, type McpToolClient } from "../src/sources/mcp-client.js";

const PRED_FIXTURE = new URL("../fixtures/shadowalpha-predictions.json", import.meta.url).pathname;
const ENRICH_FIXTURE = new URL("../fixtures/shadowalpha-enrichment.json", import.meta.url).pathname;

function predictionsSource(join = true): ShadowAlphaPredictionsSource {
  return new ShadowAlphaPredictionsSource(new FixtureMcpClient(PRED_FIXTURE), {
    lookbackDays: 3,
    joinAnalystStats: join,
    statsRefreshMinutes: 60,
  });
}

describe("shadowalpha-predictions feed", () => {
  it("normalizes rows and joins analyst stats", async () => {
    const signals = await predictionsSource().poll();
    expect(signals.map((s) => `${s.symbol}:${s.direction}`)).toEqual([
      "NVDA:bullish",
      "PLTR:bullish",
      "TSLA:bearish",
    ]);
    const nvda = signals[0]!;
    expect(nvda.type).toBe("prediction");
    expect(nvda.strength).toBe(0.75);
    expect(nvda.fields.analystHandle).toBe("KawzInvests");
    expect(nvda.fields.targetPrice).toBe(240);
    expect(nvda.fields.hasTargetPrice).toBe(true);
    // joined from get_analyst (fixture returns one canned profile)
    expect(nvda.fields.analystRatingScore).toBe(68.4);
    expect(nvda.fields.analystBlendedWinRate).toBe(86.1);
    expect(nvda.dedupeKey).toBe("shadowalpha-predictions:pred:fixture-pred-1");
  });

  it("publishes only declared fields (catalog honesty)", async () => {
    const source = predictionsSource();
    const declared = new Set(source.fieldCatalog.map((f) => f.name));
    for (const signal of await source.poll()) {
      for (const key of Object.keys(signal.fields)) {
        expect(declared.has(key), `undeclared field ${key}`).toBe(true);
      }
    }
  });

  it("a failed analyst-profile fetch leaves stats fields absent, never sinks the poll", async () => {
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "get_analyst") throw new Error("rate limited");
        return {
          predictions: [
            { id: 1, symbol: "NVDA", direction: "bullish", confidence: 0.7, channel_handle: "X" },
          ],
        };
      },
    };
    const source = new ShadowAlphaPredictionsSource(mcp, {
      lookbackDays: 3,
      joinAnalystStats: true,
      statsRefreshMinutes: 60,
    });
    const signals = await source.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.fields.analystRatingScore).toBeUndefined();
  });

  it("caches analyst profiles across a poll (one fetch per handle)", async () => {
    const calls: string[] = [];
    const mcp: McpToolClient = {
      callTool: async (name, args) => {
        if (name === "get_analyst") {
          calls.push(String((args as { handle?: string })?.handle));
          return { analyst: { rating_score: 50, blended_win_rate: 60 } };
        }
        return {
          predictions: [
            { id: 1, symbol: "A", direction: "bullish", channel_handle: "same" },
            { id: 2, symbol: "B", direction: "bullish", channel_handle: "same" },
          ],
        };
      },
    };
    const source = new ShadowAlphaPredictionsSource(mcp, {
      lookbackDays: 3,
      joinAnalystStats: true,
      statsRefreshMinutes: 60,
    });
    await source.poll();
    expect(calls).toEqual(["same"]);
  });
});

describe("ShadowAlpha symbol enrichment", () => {
  function enricher(overrides: Partial<ConstructorParameters<typeof ShadowAlphaEnricher>[1]> = {}) {
    return new ShadowAlphaEnricher(new FixtureMcpClient(ENRICH_FIXTURE), {
      conviction: true,
      symbolPredictions: true,
      daysBack: 30,
      cacheMinutes: 30,
      ...overrides,
    });
  }

  it("publishes conviction.* and predictions.* fields from the fixtures", async () => {
    const out = await enricher().enrich(["NVDA"], new Date());
    expect(out.NVDA).toMatchObject({
      "conviction.bullPoints": 3,
      "conviction.bearPoints": 2,
      "conviction.consensusCount": 24,
      "conviction.avgShadowScore": 46.7,
      "conviction.buyZoneActive": true,
      "predictions.count": 4,
      "predictions.bullishPct": 75,
      "predictions.avgLivePnlPct": 1.15,
    });
  });

  it("fieldDefs mirror the toggles", () => {
    expect(enricher({ symbolPredictions: false }).fieldDefs().every((f) => f.name.startsWith("conviction."))).toBe(true);
    expect(enricher({ conviction: false }).fieldDefs().every((f) => f.name.startsWith("predictions."))).toBe(true);
  });

  it("a failing symbol fails closed without sinking the others", async () => {
    const mcp: McpToolClient = {
      callTool: async (_name, args) => {
        if ((args as { symbol?: string })?.symbol === "BAD") throw new Error("boom");
        return { symbol: "OK", analyzed: true, bull_case: [1], bear_case: [], consensus_count: 1 };
      },
    };
    const e = new ShadowAlphaEnricher(mcp, {
      conviction: true,
      symbolPredictions: false,
      daysBack: 30,
      cacheMinutes: 30,
    });
    const out = await e.enrich(["BAD", "OK"], new Date());
    expect(out.BAD).toBeUndefined();
    expect(out.OK).toMatchObject({ "conviction.bullPoints": 1 });
  });

  it("composite merges enrichers into one per-symbol map", async () => {
    const a = { fieldDefs: () => [], enrich: async () => ({ NVDA: { "ta.rsi14": 60 } }) };
    const b = { fieldDefs: () => [], enrich: async () => ({ NVDA: { "conviction.bullPoints": 3 } }) };
    const merged = await new CompositeEnricher([a, b]).enrich(["NVDA"], new Date());
    expect(merged.NVDA).toEqual({ "ta.rsi14": 60, "conviction.bullPoints": 3 });
  });
});

describe("enrichment fields resolve in rule cards (the full chain)", () => {
  it("conviction.* and predictions.* constraints pass with enrichment, fail closed without", async () => {
    const { evaluateRulesForSymbol } = await import("../src/entry/rules.js");
    const { makeSignal } = await import("./helpers.js");
    const rule = {
      label: "conviction-gated",
      source: null,
      symbols: [],
      constraints: [
        { field: "conviction.buyZoneActive", op: "==" as const, value: true },
        { field: "predictions.bullishPct", op: ">=" as const, value: 60 },
      ],
    };
    const signals = [makeSignal({ symbol: "NVDA" })];
    const enrichment = { "conviction.buyZoneActive": true, "predictions.bullishPct": 75 };
    expect(evaluateRulesForSymbol("NVDA", signals, [rule], new Date(), enrichment)).not.toBeNull();
    expect(evaluateRulesForSymbol("NVDA", signals, [rule], new Date())).toBeNull();
    expect(
      evaluateRulesForSymbol("NVDA", signals, [rule], new Date(), {
        "conviction.buyZoneActive": false,
        "predictions.bullishPct": 75,
      }),
    ).toBeNull();
  });
});
