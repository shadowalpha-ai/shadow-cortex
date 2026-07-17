/**
 * ShadowAlpha symbol enrichment — conviction.* and predictions.* fields for
 * rule cards, from the per-symbol analysis tools (shapes captured live
 * 2026-07-16):
 *
 * - get_conviction → the cached AI bull/bear analysis:
 *     conviction.bullPoints / bearPoints (case sizes), consensusCount,
 *     avgShadowScore, avgConfidence, buyZoneActive
 * - get_symbol_predictions → live prediction stats over `daysBack`:
 *     predictions.count, bullishPct, avgConfidence, avgLivePnlPct
 *
 * Cache per symbol (`cacheMinutes`); a failed symbol just has no fields
 * (constraints on them fail closed) and is logged once. NOTE: this upstream
 * emits literal NaN tokens (observed live on target_price) — the injected
 * client's lenient JSON parsing turns them into null, and null never becomes
 * a field value here.
 */

import type { FieldDef, FieldValue } from "../core/types.js";
import type { McpToolClient } from "../sources/mcp-client.js";
import type { SymbolEnricher } from "./enricher.js";
import { log } from "../core/log.js";

export const CONVICTION_FIELDS: FieldDef[] = [
  { name: "conviction.bullPoints", kind: "number", description: "Distinct bull-case points in the AI conviction analysis (more = broader bull thesis).", defaultOp: ">=", defaultValue: 3 },
  { name: "conviction.bearPoints", kind: "number", description: "Distinct bear-case points in the analysis (fewer = weaker bear thesis).", defaultOp: "<=", defaultValue: 2 },
  { name: "conviction.consensusCount", kind: "number", description: "Analysts in the conviction consensus" },
  { name: "conviction.avgShadowScore", kind: "number", description: "Average ShadowScore of those analysts" },
  { name: "conviction.avgConfidence", kind: "number", description: "Their average stated confidence, 0..1.", defaultOp: ">=", defaultValue: 0.6 },
  { name: "conviction.buyZoneActive", kind: "boolean", description: "Whether the symbol's buy zone is active" },
];

export const SYMBOL_PREDICTION_FIELDS: FieldDef[] = [
  { name: "predictions.count", kind: "number", description: "Tracked predictions for the symbol in the window" },
  { name: "predictions.bullishPct", kind: "number", description: "Share of those predictions that are bullish (0\u2013100%).", defaultOp: ">=", defaultValue: 60 },
  { name: "predictions.avgConfidence", kind: "number", description: "Average stated confidence (0..1)" },
  { name: "predictions.avgLivePnlPct", kind: "number", description: "Average live P&L of those predictions (%)" },
];

interface ShadowAlphaEnrichmentConfig {
  conviction: boolean;
  symbolPredictions: boolean;
  daysBack: number;
  cacheMinutes: number;
}

interface CacheEntry {
  fields: Record<string, FieldValue>;
  fetchedAt: number;
}

export class ShadowAlphaEnricher implements SymbolEnricher {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly mcp: McpToolClient,
    private readonly config: ShadowAlphaEnrichmentConfig,
  ) {}

  fieldDefs(): FieldDef[] {
    return [
      ...(this.config.conviction ? CONVICTION_FIELDS : []),
      ...(this.config.symbolPredictions ? SYMBOL_PREDICTION_FIELDS : []),
    ];
  }

  async enrich(
    symbols: string[],
    now: Date = new Date(),
    _prices?: Record<string, number>,
  ): Promise<Record<string, Record<string, FieldValue>>> {
    const out: Record<string, Record<string, FieldValue>> = {};
    if (!this.config.conviction && !this.config.symbolPredictions) return out;

    const maxAgeMs = this.config.cacheMinutes * 60_000;
    for (const raw of symbols) {
      const symbol = raw.toUpperCase();
      const cached = this.cache.get(symbol);
      if (cached && now.getTime() - cached.fetchedAt < maxAgeMs) {
        out[symbol] = cached.fields;
        continue;
      }
      try {
        const fields: Record<string, FieldValue> = {
          ...(this.config.conviction ? await this.convictionFields(symbol) : {}),
          ...(this.config.symbolPredictions ? await this.predictionFields(symbol) : {}),
        };
        this.cache.set(symbol, { fields, fetchedAt: now.getTime() });
        out[symbol] = fields;
        this.warned.delete(symbol);
      } catch (err) {
        if (!this.warned.has(symbol)) {
          this.warned.add(symbol);
          log.error(
            `shadowalpha-enrichment: ${symbol} failed — its conviction.*/predictions.* constraints fail closed`,
            err,
          );
        }
      }
    }
    return out;
  }

  private async convictionFields(symbol: string): Promise<Record<string, FieldValue>> {
    const result = (await this.mcp.callTool("get_conviction", { symbol })) as {
      analyzed?: boolean;
      bull_case?: unknown[];
      bear_case?: unknown[];
      consensus_count?: number | null;
      avg_shadow_score?: number | null;
      avg_confidence?: number | null;
      buy_zone_active?: boolean | null;
    };
    // An unanalyzed symbol publishes nothing — constraints fail closed.
    if (!result?.analyzed) return {};
    const fields: Record<string, FieldValue> = {};
    if (Array.isArray(result.bull_case)) fields["conviction.bullPoints"] = result.bull_case.length;
    if (Array.isArray(result.bear_case)) fields["conviction.bearPoints"] = result.bear_case.length;
    setNum(fields, "conviction.consensusCount", result.consensus_count);
    setNum(fields, "conviction.avgShadowScore", result.avg_shadow_score);
    setNum(fields, "conviction.avgConfidence", result.avg_confidence);
    if (typeof result.buy_zone_active === "boolean") {
      fields["conviction.buyZoneActive"] = result.buy_zone_active;
    }
    return fields;
  }

  private async predictionFields(symbol: string): Promise<Record<string, FieldValue>> {
    const result = (await this.mcp.callTool("get_symbol_predictions", {
      symbol,
      days_back: this.config.daysBack,
      limit: 50,
    })) as {
      predictions?: Array<{
        direction?: string | null;
        confidence?: number | string | null;
        pnl_pct?: number | string | null;
      }>;
    };
    const rows = result?.predictions ?? [];
    const fields: Record<string, FieldValue> = { "predictions.count": rows.length };
    if (rows.length === 0) return fields;

    const bullish = rows.filter((r) => r.direction === "bullish").length;
    fields["predictions.bullishPct"] = round2((bullish / rows.length) * 100);

    const confidences = rows.map((r) => Number(r.confidence)).filter(Number.isFinite);
    if (confidences.length > 0) {
      fields["predictions.avgConfidence"] = round2(avg(confidences));
    }
    const pnls = rows.map((r) => Number(r.pnl_pct)).filter(Number.isFinite);
    if (pnls.length > 0) {
      fields["predictions.avgLivePnlPct"] = round2(avg(pnls));
    }
    return fields;
  }
}

function setNum(fields: Record<string, FieldValue>, name: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) fields[name] = value;
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
