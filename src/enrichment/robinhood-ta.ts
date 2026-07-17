/**
 * RobinhoodTAProvider — server-computed indicators via the Robinhood MCP's
 * `get_equity_technical_indicators` (RSI/SMA/MACD computed upstream; no
 * in-house math). Uses the same OAuth'd client as the live broker.
 *
 * STATUS: PINNED to the live shape captured 2026-07-17 (see
 * docs/robinhood-discovery.md and sample-payloads.json):
 *
 *   { data: { symbol, interval, bounds,
 *             indicators: [{ type, params: {…},
 *                            series: [{ begins_at, …values }] }] },
 *     guide }
 *
 * Per-point value keys by type: rsi/sma/ema → `value`; macd → `histogram`
 * (+ `macd`, `signal`); bollinger_bands → `lower`, `middle`, `upper`.
 * The wire name for our "bollinger" spec is `bollinger_bands` — plain
 * "bollinger" is rejected. Series is chronological; latest point wins.
 * Anything unrecognized → no value → the ta.* constraint fails closed.
 *
 * Call volume: one MCP call per (symbol, indicator spec) per cache window —
 * bounded by the enricher's cache and by "only symbols under decision".
 */

import type { McpToolClient } from "../sources/mcp-client.js";
import { taFieldNames, type IndicatorSpec, type TAProvider } from "./ta.js";
import { num, unwrap } from "../execution/robinhood-shared.js";

const LOOKBACK_DAYS = 90;

export class RobinhoodTAProvider implements TAProvider {
  readonly name = "robinhood";

  constructor(private readonly mcp: McpToolClient) {}

  async getIndicators(
    symbol: string,
    specs: IndicatorSpec[],
    price?: number,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const startTime = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

    for (const spec of specs) {
      const result = await this.mcp.callTool("get_equity_technical_indicators", {
        symbol: symbol.toUpperCase(),
        type: wireType(spec),
        interval: "day",
        start_time: startTime,
        ...("period" in spec ? { period: spec.period } : {}),
        ...(spec.type === "macd"
          ? {
              fast_period: spec.fastPeriod,
              slow_period: spec.slowPeriod,
              signal_period: spec.signalPeriod,
            }
          : {}),
        ...(spec.type === "bollinger" ? { num_std: spec.numStd } : {}),
      });
      for (const name of taFieldNames(spec)) {
        // priceVs*/%B are DERIVED from levels + current price below — never
        // raw-extracted, or a missing quote would leave a dollar level
        // masquerading under a percent-named field.
        if (name.startsWith("ta.priceVs") || name.startsWith("ta.bbPercentB")) continue;
        const value = latestValue(unwrap(result), spec, name);
        if (value !== null) out[name] = value;
      }
      deriveRelativeFields(out, spec, price);
    }
    return out;
  }
}

/**
 * The relative fields (priceVs…Pct, %B) derive from the raw levels plus the
 * current price — computed here so any provider returning levels gets them.
 */
function deriveRelativeFields(
  out: Record<string, number>,
  spec: IndicatorSpec,
  price: number | undefined,
): void {
  if (price === undefined || !Number.isFinite(price) || price <= 0) return;
  if (spec.type === "sma" || spec.type === "ema") {
    const level = out[`ta.${spec.type}${spec.period}`];
    if (level !== undefined && level > 0) {
      out[`ta.priceVs${spec.type === "sma" ? "Sma" : "Ema"}${spec.period}Pct`] =
        Math.round(((price - level) / level) * 10000) / 100;
    }
  }
  if (spec.type === "bollinger") {
    const upper = out[`ta.bbUpper${spec.period}`];
    const lower = out[`ta.bbLower${spec.period}`];
    if (upper !== undefined && lower !== undefined && upper > lower) {
      out[`ta.bbPercentB${spec.period}`] =
        Math.round(((price - lower) / (upper - lower)) * 10000) / 100;
    }
  }
}

/** Our spec name → Robinhood's wire name ("bollinger" alone is rejected). */
function wireType(spec: IndicatorSpec): string {
  return spec.type === "bollinger" ? "bollinger_bands" : spec.type;
}


/**
 * Walk the captured shape: data.indicators[] → the entry for this spec's
 * wire type → its chronological `series` → the most recent point that
 * carries the field's value key. Unrecognized anything → null (fail closed).
 */
function latestValue(data: unknown, spec: IndicatorSpec, field: string): number | null {
  if (data === null || typeof data !== "object") return null;
  const indicators = (data as { indicators?: unknown }).indicators;
  if (!Array.isArray(indicators)) return null;
  const type = wireType(spec);
  const entry = indicators.find(
    (i): i is { series?: unknown } =>
      i !== null && typeof i === "object" && (i as { type?: unknown }).type === type,
  );
  const series = entry?.series;
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const value = pointValue(series[i], spec, field);
    if (value !== null) return value;
  }
  return null;
}

function pointValue(point: unknown, spec: IndicatorSpec, field: string): number | null {
  if (point === null || typeof point !== "object") return null;
  const p = point as Record<string, unknown>;
  if (spec.type === "macd") return num(p.histogram);
  if (spec.type === "bollinger") {
    return num(field.startsWith("ta.bbUpper") ? p.upper : p.lower);
  }
  return num(p.value);
}
