/**
 * ShadowAlpha MCP adapter (reference poller).
 *
 * NORMALIZATION ASSUMPTIONS (sanity-check these without reading the code):
 * - `get_stock_ideas` rows carry `opp` in −100..100, signed by direction.
 *   direction = sign(opp); consensus strength = |opp| / 100.
 * - Consensus confidence = the row's `avg_confidence` (0..1) when present;
 *   otherwise `buy_zone_active` maps to 0.9 / 0.6 as a coarse fallback.
 * - `spike_ratio >= 6` is meaningful buzz (per ShadowAlpha docs); it becomes a
 *   SEPARATE "buzz" signal with strength = spike_ratio / 20, clamped to 0..1
 *   (so ratio 6 → 0.3, ratio 20+ → 1.0). Buzz direction comes from
 *   bullish_count vs bearish_count, falling back to sign(opp).
 * - The row's other facts are published verbatim as rule-constrainable fields
 *   (see SHADOWALPHA_FIELDS below) — `analystRating` is the row's
 *   `avg_analyst_rating` (ShadowScore 0–100 of the analysts behind the idea).
 * - Rows missing a usable symbol or opp are skipped, never guessed
 *   (null-rendered-as-0.0 traps: an opp of exactly 0 is treated as no signal).
 */

import type { FieldDef, FieldValue, Signal, SignalSource } from "../core/types.js";
import {
  clampStrength,
  directionFromSign,
  makeDedupeKey,
} from "../core/normalize.js";
import type { McpToolClient } from "./mcp-client.js";

interface StockIdeaRow {
  symbol?: string;
  sector?: string | null;
  opp?: number | string | null;
  buzz?: number | string | null;
  spike_ratio?: number | string | null;
  bullish_count?: number | null;
  bearish_count?: number | null;
  avg_confidence?: number | string | null;
  avg_analyst_rating?: number | string | null;
  recent_3d_sources?: number | null;
  day_pct?: number | string | null;
  buy_zone_active?: boolean | null;
  is_new_entrant?: boolean | null;
  most_recent?: string | null;
  timestamp?: string | null;
}

const SOURCE = "shadowalpha";

/** Published on every signal; imported by the rule builder. */
export const SHADOWALPHA_FIELDS: FieldDef[] = [
  { name: "opp", kind: "number", description: "Opportunity score, −100..100, signed by direction" },
  { name: "spikeRatio", kind: "number", description: "3-day distinct-analyst count vs 30-day baseline (≥6 = buzzing)" },
  { name: "buzz", kind: "number", description: "ShadowAlpha buzz score" },
  { name: "bullishCount", kind: "number", description: "Bullish analyst calls behind the idea" },
  { name: "bearishCount", kind: "number", description: "Bearish analyst calls behind the idea" },
  { name: "avgConfidence", kind: "number", description: "Average confidence across the calls, 0..1" },
  { name: "analystRating", kind: "number", description: "Avg ShadowScore (0–100) of the analysts behind the idea" },
  { name: "recent3dSources", kind: "number", description: "Distinct analysts in the last 3 days" },
  { name: "dayPct", kind: "number", description: "Today's price change % (can be a 0.0 placeholder off-hours)" },
  { name: "buyZone", kind: "boolean", description: "ShadowAlpha buy-zone flag" },
  { name: "isNewEntrant", kind: "boolean", description: "First time on the buzz scanner recently" },
  { name: "sector", kind: "string", description: "Sector label, e.g. Energy, AI/Software" },
];

export class ShadowAlphaSource implements SignalSource {
  readonly name = SOURCE;
  readonly fieldCatalog = SHADOWALPHA_FIELDS;

  constructor(
    private readonly mcp: McpToolClient,
    private readonly minStrength: number,
    private readonly dedupeWindowMinutes: number,
  ) {}

  async poll(): Promise<Signal[]> {
    const result = await this.mcp.callTool("get_stock_ideas", {});
    const rows = this.extractRows(result);
    const signals: Signal[] = [];
    for (const row of rows) {
      signals.push(...this.normalizeRow(row));
    }
    return signals.filter((s) => s.strength >= this.minStrength);
  }

  /** Handle partial/varied response shapes without throwing out of the loop. */
  private extractRows(result: unknown): StockIdeaRow[] {
    if (Array.isArray(result)) return result as StockIdeaRow[];
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      for (const key of ["ideas", "rows", "data", "results"]) {
        if (Array.isArray(obj[key])) return obj[key] as StockIdeaRow[];
      }
    }
    return [];
  }

  private normalizeRow(row: StockIdeaRow): Signal[] {
    const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : null;
    const opp = Number(row.opp);
    if (!symbol || !Number.isFinite(opp) || opp === 0) return [];

    const timestamp = row.most_recent ?? row.timestamp ?? new Date().toISOString();
    const spike = Number(row.spike_ratio);
    const avgConfidence = Number(row.avg_confidence);

    // The field dictionary rules can constrain — only facts we actually have.
    const fields: Record<string, FieldValue> = { opp };
    const addNumber = (name: string, value: unknown): void => {
      const n = Number(value);
      if (value !== null && value !== undefined && Number.isFinite(n)) fields[name] = n;
    };
    addNumber("spikeRatio", row.spike_ratio);
    addNumber("buzz", row.buzz);
    addNumber("bullishCount", row.bullish_count);
    addNumber("bearishCount", row.bearish_count);
    addNumber("avgConfidence", row.avg_confidence);
    addNumber("analystRating", row.avg_analyst_rating);
    addNumber("recent3dSources", row.recent_3d_sources);
    addNumber("dayPct", row.day_pct);
    if (typeof row.buy_zone_active === "boolean") fields.buyZone = row.buy_zone_active;
    if (typeof row.is_new_entrant === "boolean") fields.isNewEntrant = row.is_new_entrant;
    if (typeof row.sector === "string" && row.sector.length > 0) fields.sector = row.sector;

    const signals: Signal[] = [];
    signals.push({
      symbol,
      type: "consensus",
      direction: directionFromSign(opp),
      strength: clampStrength(Math.abs(opp) / 100),
      source: SOURCE,
      timestamp,
      confidence: Number.isFinite(avgConfidence)
        ? clampStrength(avgConfidence)
        : row.buy_zone_active
          ? 0.9
          : 0.6,
      fields,
      dedupeKey: makeDedupeKey(SOURCE, symbol, "consensus", timestamp, this.dedupeWindowMinutes),
      raw: row,
    });

    if (Number.isFinite(spike) && spike >= 6) {
      const bullish = row.bullish_count ?? 0;
      const bearish = row.bearish_count ?? 0;
      const direction =
        bullish !== bearish ? (bullish > bearish ? "bullish" : "bearish") : directionFromSign(opp);
      signals.push({
        symbol,
        type: "buzz",
        direction,
        strength: clampStrength(spike / 20),
        source: SOURCE,
        timestamp,
        fields,
        dedupeKey: makeDedupeKey(SOURCE, symbol, "buzz", timestamp, this.dedupeWindowMinutes),
        raw: row,
      });
    }

    return signals;
  }
}
