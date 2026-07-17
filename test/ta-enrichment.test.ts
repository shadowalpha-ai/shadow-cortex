/**
 * TA enrichment: deterministic field naming, the fixture provider, the
 * enricher's cache + failure isolation, fail-closed ta.* rule resolution,
 * and the provisional Robinhood provider mapping. All offline.
 */

import { describe, expect, it } from "vitest";
import {
  FixtureTAProvider,
  TAEnricher,
  taFieldDefs,
  taFieldNames,
  type IndicatorSpec,
  type TAProvider,
} from "../src/enrichment/ta.js";
import { RobinhoodTAProvider } from "../src/enrichment/robinhood-ta.js";
import { evaluateRulesForSymbol, type EntryRule } from "../src/entry/rules.js";
import { RulesDecider } from "../src/deciders/rules.js";
import type { McpToolClient } from "../src/sources/mcp-client.js";
import { makeSettings, makeSignal } from "./helpers.js";

const FIXTURE = new URL("../fixtures/ta-indicators.json", import.meta.url).pathname;
const RSI14: IndicatorSpec = { type: "rsi", period: 14 };
const SPECS: IndicatorSpec[] = [
  RSI14,
  { type: "sma", period: 50 },
  { type: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
];

describe("field naming", () => {
  it("derives deterministic names (raw + relative) that match the catalog defs", () => {
    expect(SPECS.flatMap(taFieldNames)).toEqual([
      "ta.rsi14",
      "ta.sma50",
      "ta.priceVsSma50Pct",
      "ta.macdHist",
    ]);
    expect(taFieldDefs(SPECS).map((f) => f.name)).toEqual([
      "ta.rsi14",
      "ta.sma50",
      "ta.priceVsSma50Pct",
      "ta.macdHist",
    ]);
    expect(taFieldDefs(SPECS).every((f) => f.kind === "number")).toBe(true);
    // Interpretation-bearing defaults ride along for the builder.
    const rsi = taFieldDefs(SPECS).find((f) => f.name === "ta.rsi14")!;
    expect(rsi.defaultOp).toBe("<=");
    expect(rsi.defaultValue).toBe(70);
  });

  it("relative fields parse back to their computing spec", async () => {
    const { specForTaField } = await import("../src/enrichment/ta.js");
    expect(specForTaField("ta.priceVsSma200Pct")).toMatchObject({ type: "sma", period: 200 });
    expect(specForTaField("ta.priceVsEma12Pct")).toMatchObject({ type: "ema", period: 12 });
    expect(specForTaField("ta.bbPercentB20")).toMatchObject({ type: "bollinger", period: 20 });
  });

  it("RobinhoodTAProvider derives relative fields from the current price", async () => {
    const mcp: McpToolClient = {
      callTool: async () => rhEnvelope("sma", { period: 50 }, [{ begins_at: "2026-07-16T00:00:00Z", value: 200 }]),
    };
    const values = await new RobinhoodTAProvider(mcp).getIndicators(
      "NVDA",
      [{ type: "sma", period: 50 }],
      210, // current price 5% above the average
    );
    expect(values["ta.sma50"]).toBe(200);
    expect(values["ta.priceVsSma50Pct"]).toBe(5);
  });
});

describe("FixtureTAProvider + TAEnricher", () => {
  it("round-trips fixture values; unknown symbols yield an empty map", async () => {
    const provider = new FixtureTAProvider(FIXTURE);
    expect(await provider.getIndicators("nvda", SPECS)).toMatchObject({ "ta.rsi14": 62.1 });
    expect(await provider.getIndicators("ZZZZ", SPECS)).toEqual({});
  });

  it("returns nothing when no indicators are configured (enrichment off)", async () => {
    const enricher = new TAEnricher(new FixtureTAProvider(FIXTURE), [], 15);
    expect(await enricher.enrich(["NVDA"])).toEqual({});
  });

  it("caches per symbol for cacheMinutes", async () => {
    let calls = 0;
    const provider: TAProvider = {
      name: "counting",
      getIndicators: async () => {
        calls++;
        return { "ta.rsi14": 50 };
      },
    };
    const enricher = new TAEnricher(provider, [RSI14], 15);
    const t0 = new Date("2026-07-16T14:00:00Z");
    await enricher.enrich(["NVDA"], t0);
    await enricher.enrich(["NVDA"], new Date(t0.getTime() + 5 * 60_000)); // fresh
    expect(calls).toBe(1);
    await enricher.enrich(["NVDA"], new Date(t0.getTime() + 16 * 60_000)); // stale
    expect(calls).toBe(2);
  });

  it("one failing symbol does not sink the others (fail closed per symbol)", async () => {
    const provider: TAProvider = {
      name: "flaky",
      getIndicators: async (symbol) => {
        if (symbol === "BAD") throw new Error("boom");
        return { "ta.rsi14": 42 };
      },
    };
    const enricher = new TAEnricher(provider, [RSI14], 15);
    const out = await enricher.enrich(["BAD", "NVDA"]);
    expect(out.BAD).toBeUndefined();
    expect(out.NVDA).toEqual({ "ta.rsi14": 42 });
  });
});

describe("ta.* constraints in rule cards", () => {
  const rule: EntryRule = {
    label: "not overbought",
    source: null,
    symbols: [],
    constraints: [{ field: "ta.rsi14", op: "<=", value: 70 }],
  };
  const now = new Date();

  it("passes with enrichment data, fails closed without it", () => {
    const signals = [makeSignal({ symbol: "NVDA" })];
    expect(evaluateRulesForSymbol("NVDA", signals, [rule], now, { "ta.rsi14": 62.1 })).not.toBeNull();
    expect(evaluateRulesForSymbol("NVDA", signals, [rule], now, {})).toBeNull();
    expect(evaluateRulesForSymbol("NVDA", signals, [rule], now)).toBeNull();
  });

  it("fails when the value violates the constraint", () => {
    const signals = [makeSignal({ symbol: "TSLA" })];
    expect(evaluateRulesForSymbol("TSLA", signals, [rule], now, { "ta.rsi14": 71.8 })).toBeNull();
  });

  it("gates proposals end-to-end through the rules decider", async () => {
    const settings = makeSettings({
      entry: { rules: [rule] },
    });
    const decider = new RulesDecider();
    const base = {
      signals: [makeSignal({ symbol: "NVDA" }), makeSignal({ symbol: "TSLA" })],
      positions: [],
      quotes: {
        NVDA: { symbol: "NVDA", price: 185, asOf: new Date().toISOString() },
        TSLA: { symbol: "TSLA", price: 244, asOf: new Date().toISOString() },
      },
      equity: 10_000,
      settings,
      now: new Date(),
    };
    // NVDA under 70 → proposed; TSLA over 70 → gated out.
    const proposals = await decider.decide({
      ...base,
      enrichment: { NVDA: { "ta.rsi14": 62.1 }, TSLA: { "ta.rsi14": 71.8 } },
    });
    expect(proposals.map((p) => p.symbol)).toEqual(["NVDA"]);
    // No enrichment at all → nothing qualifies (fail closed).
    expect(await decider.decide(base)).toEqual([]);
  });
});

describe("RobinhoodTAProvider (pinned to the shape captured live 2026-07-17)", () => {
  it("walks data.indicators[].series and takes the latest point", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const mcp: McpToolClient = {
      callTool: async (_name, args) => {
        seen.push(args);
        return rhEnvelope("rsi", { period: 14 }, [
          { begins_at: "2026-07-14T00:00:00Z", value: 58.2 },
          { begins_at: "2026-07-15T00:00:00Z", value: "61.9000" }, // strings coerce too
        ]);
      },
    };
    const values = await new RobinhoodTAProvider(mcp).getIndicators("nvda", [RSI14]);
    expect(values).toEqual({ "ta.rsi14": 61.9 });
    expect(seen[0]).toMatchObject({ symbol: "NVDA", type: "rsi", interval: "day", period: 14 });
  });

  it("maps the MACD histogram and passes the period trio", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const mcp: McpToolClient = {
      callTool: async (_name, args) => {
        seen.push(args);
        return rhEnvelope("macd", { fast_period: 12, slow_period: 26, signal_period: 9 }, [
          { begins_at: "2026-07-16T00:00:00Z", histogram: 0.2, macd: 1.1, signal: 0.9 },
        ]);
      },
    };
    const values = await new RobinhoodTAProvider(mcp).getIndicators("NVDA", [
      { type: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    ]);
    expect(values).toEqual({ "ta.macdHist": 0.2 });
    expect(seen[0]).toMatchObject({ type: "macd", fast_period: 12, slow_period: 26, signal_period: 9 });
  });

  it('requests "bollinger_bands" on the wire and maps lower/upper + %B', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const mcp: McpToolClient = {
      callTool: async (_name, args) => {
        seen.push(args);
        return rhEnvelope("bollinger_bands", { period: 20, num_std: 2 }, [
          { begins_at: "2026-07-16T00:00:00Z", lower: 160, middle: 180, upper: 200 },
        ]);
      },
    };
    const values = await new RobinhoodTAProvider(mcp).getIndicators(
      "NVDA",
      [{ type: "bollinger", period: 20, numStd: 2 }],
      190,
    );
    // "bollinger" alone is rejected by Robinhood — the wire name is pinned.
    expect(seen[0]).toMatchObject({ type: "bollinger_bands", period: 20, num_std: 2 });
    expect(values).toEqual({ "ta.bbUpper20": 200, "ta.bbLower20": 160, "ta.bbPercentB20": 75 });
  });

  it("without a current price, derived percent fields are ABSENT — never raw levels", async () => {
    const mcp: McpToolClient = {
      callTool: async () =>
        rhEnvelope("sma", { period: 50 }, [{ begins_at: "2026-07-16T00:00:00Z", value: 200 }]),
    };
    const values = await new RobinhoodTAProvider(mcp).getIndicators("NVDA", [
      { type: "sma", period: 50 },
    ]);
    expect(values).toEqual({ "ta.sma50": 200 }); // no ta.priceVsSma50Pct key at all
  });

  it("yields no value on an unrecognized shape or mismatched indicator type (fail closed)", async () => {
    const wrongShape: McpToolClient = {
      callTool: async () => ({ data: { something: "unexpected" } }),
    };
    expect(await new RobinhoodTAProvider(wrongShape).getIndicators("NVDA", [RSI14])).toEqual({});
    const wrongType: McpToolClient = {
      callTool: async () =>
        rhEnvelope("sma", { period: 14 }, [{ begins_at: "2026-07-16T00:00:00Z", value: 55 }]),
    };
    expect(await new RobinhoodTAProvider(wrongType).getIndicators("NVDA", [RSI14])).toEqual({});
  });
});

/** The exact envelope captured live on 2026-07-17 (docs/robinhood-discovery.md). */
function rhEnvelope(
  type: string,
  params: Record<string, number>,
  series: Array<Record<string, unknown>>,
) {
  return {
    data: { symbol: "NVDA", interval: "day", bounds: "regular", indicators: [{ type, params, series }] },
    guide: "(elided)",
  };
}

describe("rules-derived enrichment (config follows the strategy)", () => {
  it("specForTaField inverts taFieldNames across the grammar", async () => {
    const { specForTaField, taFieldNames } = await import("../src/enrichment/ta.js");
    for (const [field, expected] of [
      ["ta.rsi14", { type: "rsi", period: 14 }],
      ["ta.rsi21", { type: "rsi", period: 21 }],
      ["ta.sma200", { type: "sma", period: 200 }],
      ["ta.ema26", { type: "ema", period: 26 }],
      ["ta.macdHist", { type: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }],
      ["ta.bbUpper20", { type: "bollinger", period: 20, numStd: 2 }],
      ["ta.bbLower50", { type: "bollinger", period: 50, numStd: 2 }],
    ] as const) {
      const spec = specForTaField(field);
      expect(spec).toMatchObject(expected as Record<string, unknown>);
      expect(taFieldNames(spec!)).toContain(field);
    }
    expect(specForTaField("ta.bogus")).toBeNull();
    expect(specForTaField("ta.rsi")).toBeNull();
  });

  it("enrichmentNeeds derives specs and flags from the rules", async () => {
    const { enrichmentNeeds } = await import("../src/enrichment/catalog.js");
    const settings = makeSettings({
      entry: {
        rules: [
          {
            label: "r",
            source: null,
            symbols: [],
            constraints: [
              { field: "ta.sma200", op: ">=", value: 0 },
              { field: "ta.bbUpper20", op: ">=", value: 0 },
              { field: "ta.bbLower20", op: "<=", value: 0 }, // same spec as bbUpper20
              { field: "conviction.buyZoneActive", op: "==", value: true },
              { field: "strength", op: ">=", value: 0.5 },
            ],
          },
        ],
      },
    });
    const needs = enrichmentNeeds(settings);
    expect(needs.rulesTaSpecs).toHaveLength(2); // sma200 + bollinger20 (deduped)
    expect(needs.conviction).toBe(true);
    expect(needs.symbolPredictions).toBe(false);
  });

  it("live mode refuses to run rules on fixture enrichment", async () => {
    const { runnableIssues, LIVE_TA_FIXTURE, LIVE_SA_ENRICHMENT_FIXTURE } = await import(
      "../src/settings/validate.js"
    );
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tempDir } = await import("./helpers.js");
    const dir = tempDir();
    const oauth = join(dir, "oauth.json");
    writeFileSync(oauth, JSON.stringify({ tokens: { access_token: "t" } }));
    const settings = makeSettings({
      mode: "live",
      execution: "off",
      liveBroker: "robinhood",
      paths: { robinhoodOauth: oauth },
      entry: {
        rules: [
          {
            label: "r",
            source: null,
            symbols: [],
            constraints: [
              { field: "ta.rsi14", op: "<=", value: 70 },
              { field: "predictions.bullishPct", op: ">=", value: 60 },
            ],
          },
        ],
      },
    });
    const messages = runnableIssues(settings).map((i) => i.message);
    expect(messages).toContain(LIVE_TA_FIXTURE);
    expect(messages).toContain(LIVE_SA_ENRICHMENT_FIXTURE);
    // Paper mode: same rules, no refusal — fixtures are fine for practice.
    const paper = makeSettings({ entry: settings.entry });
    expect(runnableIssues(paper)).toEqual([]);
  });
});
