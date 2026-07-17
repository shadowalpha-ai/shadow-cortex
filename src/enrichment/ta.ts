/**
 * TA enrichment — technical-indicator fields (`ta.*`) as entry criteria.
 *
 * Signals say "someone likes this symbol"; enrichment says "and here is what
 * the chart looks like right now." The intake loop enriches the symbols under
 * decision with the configured indicators, and rule cards constrain them like
 * any other field (`ta.rsi14 <= 70`). Resolution is per-symbol, so a `ta.*`
 * constraint works under any card source.
 *
 * Fail-closed by construction: no provider data for a symbol (error, unknown
 * symbol, indicators off) means the `ta.*` constraint fails — a rule never
 * fires on chart data you don't have. With `indicators: []` (the default,
 * incl. SAFE_DEFAULTS) enrichment is off: no calls, no catalog fields, no
 * behavior change.
 *
 * Field names derive deterministically from the indicator spec:
 *   rsi{period:14}                → ta.rsi14
 *   sma{period:50}                → ta.sma50
 *   macd{12,26,9}                 → ta.macdHist (the histogram — the one
 *                                   load-bearing MACD value; add more only
 *                                   when a rule needs them)
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { FieldDef } from "../core/types.js";
import { log } from "../core/log.js";

// --- indicator specs (imported by the settings schema) ---
// The grammar itself (spec type, menu, name derivation and its inverse)
// lives dependency-free in ta-grammar.ts so the dashboard shares it 1:1.

import {
  STANDARD_TA_MENU,
  specForTaField,
  taFieldNames,
  type IndicatorSpec,
} from "./ta-grammar.js";

export * from "./ta-grammar.js";

export const IndicatorSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rsi"), period: z.number().int().positive().default(14) }),
  z.object({ type: z.literal("sma"), period: z.number().int().positive().default(50) }),
  z.object({ type: z.literal("ema"), period: z.number().int().positive().default(12) }),
  z.object({
    type: z.literal("macd"),
    fastPeriod: z.number().int().positive().default(12),
    slowPeriod: z.number().int().positive().default(26),
    signalPeriod: z.number().int().positive().default(9),
  }),
  z.object({
    type: z.literal("bollinger"),
    period: z.number().int().positive().default(20),
    numStd: z.number().positive().default(2),
  }),
]);

// Compile-time pin: the zod schema and ta-grammar's hand-written type must
// stay equivalent in BOTH directions, or these two casts stop typechecking.
type SchemaSpec = z.infer<typeof IndicatorSpecSchema>;
const _grammarCoversSchema = (s: SchemaSpec): IndicatorSpec => s;
const _schemaCoversGrammar = (s: IndicatorSpec): SchemaSpec => s;
void _grammarCoversSchema;
void _schemaCoversGrammar;

/** The indicator specs a set of rule fields requires (deduped by output names). */
export function taSpecsFromRuleFields(fields: string[]): IndicatorSpec[] {
  const specs: IndicatorSpec[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.startsWith("ta.")) continue;
    const spec = specForTaField(field);
    if (!spec) continue;
    const key = taFieldNames(spec).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(spec);
  }
  return specs;
}

/** Catalog entries for the configured indicators — feeds the rule builder. */
export function taFieldDefs(indicators: IndicatorSpec[]): FieldDef[] {
  const defs: FieldDef[] = [];
  const seen = new Set<string>();
  for (const spec of indicators) {
    for (const name of taFieldNames(spec)) {
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push(taFieldDef(name, spec));
    }
  }
  return defs;
}

/** Interpretation-bearing defs: what the number MEANS and a sane starting comparison. */
function taFieldDef(name: string, spec: IndicatorSpec): FieldDef {
  const base = { name, kind: "number" as const };
  if (name.startsWith("ta.rsi")) {
    return {
      ...base,
      description: `RSI (${"period" in spec ? spec.period : 14}-day): 0–100 momentum oscillator. Above ~70 is commonly read as overbought, below ~30 as oversold.`,
      defaultOp: "<=",
      defaultValue: 70,
    };
  }
  if (name === "ta.macdHist") {
    return {
      ...base,
      description:
        "MACD histogram (12/26/9): momentum around zero. Positive = MACD above its signal line (bullish momentum); the zero-cross is the classic trigger.",
      defaultOp: ">=",
      defaultValue: 0,
    };
  }
  if (name.startsWith("ta.priceVsSma") || name.startsWith("ta.priceVsEma")) {
    const period = "period" in spec ? spec.period : 0;
    const kindName = name.includes("Sma") ? "simple" : "exponential";
    return {
      ...base,
      description: `Percent the current price sits above (+) or below (−) its ${period}-day ${kindName} moving average. >= 0 means price is above the average (uptrend posture).`,
      defaultOp: ">=",
      defaultValue: 0,
    };
  }
  if (name.startsWith("ta.bbPercentB")) {
    return {
      ...base,
      description:
        "Bollinger %B: where price sits inside the bands — 0 = at the lower band, 100 = at the upper. <= 25 = near the lower band (potential dip); >= 100 = riding above the upper band.",
      defaultOp: "<=",
      defaultValue: 25,
    };
  }
  // Raw levels (grammar-derivable, not in the menu).
  return {
    ...base,
    description: `${describeSpec(spec)} — a raw price level in dollars; prefer the priceVs…Pct / %B variants for symbol-independent rules.`,
  };
}

function describeSpec(spec: IndicatorSpec): string {
  switch (spec.type) {
    case "rsi":
      return `Relative Strength Index (${spec.period}-period, daily)`;
    case "sma":
      return `Simple moving average (${spec.period}-day)`;
    case "ema":
      return `Exponential moving average (${spec.period}-day)`;
    case "macd":
      return `MACD histogram (${spec.fastPeriod}/${spec.slowPeriod}/${spec.signalPeriod}, daily)`;
    case "bollinger":
      return `Bollinger band (${spec.period}-day, ${spec.numStd}σ)`;
  }
}

// --- providers ---

export interface TAProvider {
  readonly name: string;
  /**
   * Values keyed by derived field name (`ta.rsi14`). Missing keys = no data
   * (fail closed downstream). `price` (the symbol's current price, when the
   * intake loop has one) lets providers compute the relative fields
   * (priceVs…Pct, %B).
   */
  getIndicators(symbol: string, specs: IndicatorSpec[], price?: number): Promise<Record<string, number>>;
}

/** Canned per-symbol values — the zero-credential demo and tests. */
export class FixtureTAProvider implements TAProvider {
  readonly name = "fixture";
  private readonly bySymbol: Record<string, Record<string, number>>;

  constructor(fixturePath: string) {
    this.bySymbol = JSON.parse(readFileSync(fixturePath, "utf8"));
  }

  async getIndicators(symbol: string, _specs: IndicatorSpec[], _price?: number): Promise<Record<string, number>> {
    return this.bySymbol[symbol.toUpperCase()] ?? {};
  }
}

// --- the enricher (cache + per-symbol failure isolation) ---

interface CacheEntry {
  values: Record<string, number>;
  fetchedAt: number;
}

export class TAEnricher {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly provider: TAProvider,
    private readonly indicators: IndicatorSpec[],
    private readonly cacheMinutes: number,
  ) {}

  /** Every ta.* field this enricher can produce (for the catalog). */
  fieldDefs(): FieldDef[] {
    return taFieldDefs(this.indicators);
  }

  /**
   * Indicator values for each symbol, from cache when fresh. A failed symbol
   * yields no entry — its ta.* constraints fail closed — and is logged once.
   */
  async enrich(
    symbols: string[],
    now: Date = new Date(),
    prices: Record<string, number> = {},
  ): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    if (this.indicators.length === 0) return out;

    const maxAgeMs = this.cacheMinutes * 60_000;
    for (const raw of symbols) {
      const symbol = raw.toUpperCase();
      const cached = this.cache.get(symbol);
      if (cached && now.getTime() - cached.fetchedAt < maxAgeMs) {
        out[symbol] = cached.values;
        continue;
      }
      try {
        const values = await this.provider.getIndicators(symbol, this.indicators, prices[symbol]);
        this.cache.set(symbol, { values, fetchedAt: now.getTime() });
        out[symbol] = values;
        this.warned.delete(symbol);
      } catch (err) {
        if (!this.warned.has(symbol)) {
          this.warned.add(symbol);
          log.error(`ta-enrichment: ${symbol} failed via ${this.provider.name} — its ta.* constraints fail closed`, err);
        }
      }
    }
    return out;
  }
}
