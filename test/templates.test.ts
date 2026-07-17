/**
 * Rule-template validation — the smoke suite for the strategy library.
 *
 * Three guarantees, all offline against the shipped fixtures:
 *  1. VALIDITY — every template (with default answers) builds a card the
 *     schema accepts, and ALL templates together form a profile that loads
 *     and boots (paper mode).
 *  2. FIRING — each template fires on data that should match and stays
 *     silent on data that shouldn't (positive + negative per template).
 *  3. CONJUNCTION — with every template active at once, the real decider +
 *     composite enricher over the real fixture adapters propose exactly the
 *     symbols the fixture world justifies.
 */

import { describe, expect, it } from "vitest";
import { RULE_TEMPLATES, type RuleTemplate } from "../src/entry/templates.js";
import { EntryRuleSchema, evaluateRulesForSymbol, type EntryRule } from "../src/entry/rules.js";
import { parseSettingsDocument, runnableIssues } from "../src/settings/validate.js";
import { enrichmentNeeds } from "../src/enrichment/catalog.js";
import { FixtureTAProvider, TAEnricher } from "../src/enrichment/ta.js";
import { ShadowAlphaEnricher } from "../src/enrichment/shadowalpha.js";
import { CompositeEnricher } from "../src/enrichment/enricher.js";
import { ShadowAlphaSource } from "../src/sources/shadowalpha.js";
import { ShadowAlphaPredictionsSource } from "../src/sources/shadowalpha-predictions.js";
import { ShadowAlphaPortfolioSource } from "../src/sources/shadowalpha-portfolio.js";
import { RulesDecider } from "../src/deciders/rules.js";
import { FixtureMcpClient } from "../src/sources/mcp-client.js";
import { makeSettings, makeSignal } from "./helpers.js";
import type { Quote } from "../src/core/types.js";

const fx = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

/** Default answers per template (the wizard's initial state). */
function defaultAnswers(template: RuleTemplate): Record<string, number | string> {
  return Object.fromEntries(
    template.questions.map((q) => [
      q.id,
      q.type === "portfolio" ? "Momentum" : q.defaultValue,
    ]),
  );
}

function cardFor(id: string, answers: Record<string, number | string> = {}): EntryRule {
  const template = RULE_TEMPLATES.find((t) => t.id === id)!;
  return template.build({ ...defaultAnswers(template), ...answers });
}

const ALL_CARDS = RULE_TEMPLATES.map((t) => cardFor(t.id));

describe("1. validity", () => {
  it("every template builds a schema-valid card with default answers", () => {
    for (const template of RULE_TEMPLATES) {
      const card = cardFor(template.id);
      expect(() => EntryRuleSchema.parse(card), template.id).not.toThrow();
    }
  });

  it("all templates together form a loadable, bootable paper profile", () => {
    const document = {
      scenario: 3,
      mode: "paper",
      execution: "off",
      marketHoursOnly: false,
      sources: [
        { type: "shadowalpha", transport: "fixture" },
        { type: "shadowalpha-predictions", transport: "fixture" },
        { type: "shadowalpha-portfolio", transport: "fixture", portfolios: ["Momentum"] },
      ],
      entry: { rules: ALL_CARDS },
    };
    const parsed = parseSettingsDocument(document);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(runnableIssues(parsed.settings)).toEqual([]);
  });

  it("the combined rules derive every enrichment they need", () => {
    const settings = makeSettings({ entry: { rules: ALL_CARDS } });
    const needs = enrichmentNeeds(settings);
    const fields = needs.taSpecs.map((s) => s.type).sort();
    expect(fields).toEqual(["macd", "rsi", "sma"]); // momentum + oversold templates
    expect(needs.conviction).toBe(true); // conviction-zone template
    expect(needs.symbolPredictions).toBe(true); // crowd-favorite template
  });
});

describe("2. firing matrix (positive + negative per template)", () => {
  const now = new Date();
  const run = (card: EntryRule, signal = makeSignal({ symbol: "NVDA" }), enrichment?: Record<string, number | string | boolean>) =>
    evaluateRulesForSymbol(signal.symbol, [signal], [card], now, enrichment);

  it("copy-trade fires on the chosen portfolio's entries only", () => {
    const card = cardFor("copy-trade");
    const from = (name: string) =>
      makeSignal({ source: "shadowalpha-portfolio", fields: { portfolioName: name } });
    expect(run(card, from("Momentum"))).not.toBeNull();
    expect(run(card, from("Other"))).toBeNull();
    // The win-rate gate pauses copying when the record dips below the bar.
    const gated = cardFor("copy-trade", { winRateGate: 60 });
    const withRate = (rate: number) =>
      makeSignal({
        source: "shadowalpha-portfolio",
        fields: { portfolioName: "Momentum", portfolioWinRatePct: rate },
      });
    expect(run(gated, withRate(63.2))).not.toBeNull();
    expect(run(gated, withRate(52))).toBeNull();
  });

  it("oversold-dip fires only at/below the RSI threshold", () => {
    const card = cardFor("oversold-dip");
    expect(run(card, undefined, { "ta.rsi14": 28 })).not.toBeNull();
    expect(run(card, undefined, { "ta.rsi14": 42 })).toBeNull();
    expect(run(card)).toBeNull(); // no TA data → fail closed
  });

  it("quality-picks demands confidence AND analyst rating", () => {
    const card = cardFor("quality-picks");
    const pick = (confidence: number, rating?: number) =>
      makeSignal({
        source: "shadowalpha-predictions",
        confidence,
        fields: rating === undefined ? {} : { analystRatingScore: rating },
      });
    expect(run(card, pick(0.75, 68))).not.toBeNull();
    expect(run(card, pick(0.6, 68))).toBeNull(); // low confidence
    expect(run(card, pick(0.75, 40))).toBeNull(); // weak analyst
    expect(run(card, pick(0.75))).toBeNull(); // stats join missing → fail closed
  });

  it("momentum-breakout needs MACD + trend, and the overbought guard bites", () => {
    const card = cardFor("momentum-breakout"); // 50-day + guard
    const chart = (macd: number, vsSma50: number, rsi: number) => ({
      "ta.macdHist": macd,
      "ta.priceVsSma50Pct": vsSma50,
      "ta.rsi14": rsi,
    });
    expect(run(card, undefined, chart(1.2, 2.5, 62))).not.toBeNull();
    expect(run(card, undefined, chart(-0.3, 2.5, 62))).toBeNull(); // momentum negative
    expect(run(card, undefined, chart(1.2, -1.0, 62))).toBeNull(); // below the average
    expect(run(card, undefined, chart(1.2, 2.5, 74))).toBeNull(); // overbought guard
    const both = cardFor("momentum-breakout", { average: "both" });
    expect(
      run(both, undefined, { ...chart(1.2, 2.5, 62), "ta.priceVsSma200Pct": 10 }),
    ).not.toBeNull();
    expect(run(both, undefined, chart(1.2, 2.5, 62))).toBeNull(); // 200-day missing → fail closed
  });

  it("buzzing needs the spike AND the analyst rating", () => {
    const card = cardFor("buzzing");
    const idea = (spike: number, rating: number) =>
      makeSignal({ source: "shadowalpha", type: "consensus", fields: { spikeRatio: spike, analystRating: rating } });
    expect(run(card, idea(9.5, 62.4))).not.toBeNull(); // fixture NVDA values
    expect(run(card, idea(12, 46.7))).toBeNull(); // fixture PLTR: rating too low
    expect(run(card, idea(7, 62))).toBeNull(); // spike too weak
  });

  it("conviction-zone needs the buy zone AND a broad bull case", () => {
    const card = cardFor("conviction-zone");
    expect(run(card, undefined, { "conviction.buyZoneActive": true, "conviction.bullPoints": 3 })).not.toBeNull();
    expect(run(card, undefined, { "conviction.buyZoneActive": false, "conviction.bullPoints": 5 })).toBeNull();
    expect(run(card, undefined, { "conviction.buyZoneActive": true, "conviction.bullPoints": 2 })).toBeNull();
  });

  it("crowd-favorite needs a decisive AND sizable crowd", () => {
    const card = cardFor("crowd-favorite");
    expect(run(card, undefined, { "predictions.bullishPct": 75, "predictions.count": 4 })).not.toBeNull();
    expect(run(card, undefined, { "predictions.bullishPct": 55, "predictions.count": 9 })).toBeNull();
    expect(run(card, undefined, { "predictions.bullishPct": 100, "predictions.count": 1 })).toBeNull();
  });
});

describe("3. conjunction — every template active, real fixture pipeline", () => {
  it("all templates together propose exactly what the fixture world justifies", async () => {
    const settings = makeSettings({
      entry: { rules: ALL_CARDS },
      sources: [
        { type: "shadowalpha", transport: "fixture" },
        { type: "shadowalpha-predictions", transport: "fixture" },
        { type: "shadowalpha-portfolio", transport: "fixture", portfolios: ["Momentum"] },
      ],
    });

    // Real fixture adapters — the same signals the demo engine ingests.
    const sources = [
      new ShadowAlphaSource(new FixtureMcpClient(fx("shadowalpha-ideas.json")), 0.3, 30),
      new ShadowAlphaPredictionsSource(new FixtureMcpClient(fx("shadowalpha-predictions.json")), {
        lookbackDays: 3,
        joinAnalystStats: true,
        statsRefreshMinutes: 60,
      }),
      new ShadowAlphaPortfolioSource(new FixtureMcpClient(fx("portfolio-signals.json")), {
        portfolios: ["Momentum"],
        listRefreshMinutes: 15,
      }),
    ];
    const signals = (await Promise.all(sources.map((s) => s.poll()))).flat();

    // Real composite enricher over the fixture providers, driven by the
    // exact needs the combined rules derive.
    const needs = enrichmentNeeds(settings);
    const enricher = new CompositeEnricher([
      new TAEnricher(new FixtureTAProvider(fx("ta-indicators.json")), needs.taSpecs, 15),
      new ShadowAlphaEnricher(new FixtureMcpClient(fx("shadowalpha-enrichment.json")), {
        conviction: needs.conviction,
        symbolPredictions: needs.symbolPredictions,
        daysBack: 30,
        cacheMinutes: 30,
      }),
    ]);
    const symbols = [...new Set(signals.map((s) => s.symbol))];
    const quotesRaw = JSON.parse(
      (await import("node:fs")).readFileSync(fx("quotes.json"), "utf8"),
    ) as Record<string, number[]>;
    const prices = Object.fromEntries(
      Object.entries(quotesRaw).map(([sym, series]) => [sym, series[0]!]),
    );
    const enrichment = await enricher.enrich(symbols, new Date(), prices);

    const quotes: Record<string, Quote> = Object.fromEntries(
      Object.entries(prices).map(([sym, price]) => [
        sym,
        { symbol: sym, price, asOf: new Date().toISOString() },
      ]),
    );

    const proposals = await new RulesDecider().decide({
      signals,
      positions: [],
      quotes,
      equity: 10_000,
      enrichment,
      settings,
      now: new Date(),
    });

    // The fixture world justifies exactly NVDA (buzzing + quality picks +
    // conviction…) and PLTR (copy-trade Momentum). TSLA is the everything-
    // refuses-it case: its ideas and prediction signals are BEARISH (long-
    // only skips them), its portfolio row is an option leg (skipped at
    // ingestion), its RSI is overbought and MACD negative. HOOD appears only
    // as a bearish portfolio exit. Neither may ever propose a buy.
    const proposed = proposals.map((p) => p.symbol).sort();
    expect(proposed).toEqual(["NVDA", "PLTR"]);
    for (const p of proposals) {
      expect(p.action).toBe("buy");
      expect(p.rationale).toContain("rule");
    }
  });
});
