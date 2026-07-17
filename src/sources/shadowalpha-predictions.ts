/**
 * ShadowAlpha analyst-predictions feed (poller) — every tracked analyst
 * prediction becomes a signal, with the analyst's track record joined on so
 * rule cards can demand quality ("confidence >= 0.7 AND analystRating >= 60").
 *
 * NORMALIZATION ASSUMPTIONS (sanity-check without reading the code):
 * - One `search_predictions` call per poll (recent window, all analysts).
 * - Each prediction row → one signal of type "prediction"; direction from the
 *   row; strength = the analyst's stated confidence (0..1), falling back to
 *   0.5 when absent.
 * - Dedupe: rows carry a stable upstream id (`source_id`/`id`) — exact event
 *   identity beats time-bucketing.
 * - Timestamps arrive as "YYYY-MM-DD HH:MM:SS+00:00" or ISO — normalized.
 *   Rows without a usable symbol or direction are skipped, never guessed.
 *
 * ANALYST-STATS JOIN: with `joinAnalystStats` on, the adapter fetches
 * `get_analyst` once per distinct handle (cached `statsRefreshMinutes`) and
 * stamps `analystRatingScore` / `analystBlendedWinRate` onto that analyst's
 * signals — the leaderboard data, joined where it's useful. A failed profile
 * fetch just leaves those fields absent (constraints on them fail closed).
 *
 * RATE BUDGET (ShadowAlpha: 30 req/min): 1 search per poll + up to one
 * get_analyst per NEW handle per stats window. Fine at minutes-scale cadence.
 */

import type { FieldDef, FieldValue, Signal, SignalSource } from "../core/types.js";
import { clampStrength, normalizeTimestamp } from "../core/normalize.js";
import { log } from "../core/log.js";
import type { McpToolClient } from "./mcp-client.js";

interface PredictionRow {
  id?: number | string;
  source_id?: string | null;
  channel_handle?: string | null;
  post_timestamp?: string | null;
  symbol?: string | null;
  direction?: string | null;
  target_price?: number | string | null;
  entry_price?: number | string | null;
  confidence?: number | string | null;
  specificity_tier?: number | null;
}

interface AnalystProfile {
  rating_score?: number | null;
  blended_win_rate?: number | null;
}

const SOURCE = "shadowalpha-predictions";

/** Published on every signal; imported by the rule builder. */
export const PREDICTION_FIELDS: FieldDef[] = [
  { name: "analystHandle", kind: "string", description: "The analyst who made the call" },
  { name: "specificityTier", kind: "number", description: "How specific the call is (upstream tiering)" },
  { name: "hasTargetPrice", kind: "boolean", description: "Whether the call names a price target" },
  { name: "targetPrice", kind: "number", description: "The named price target (absent when none)" },
  { name: "entryPrice", kind: "number", description: "Price when the call was made" },
  { name: "analystRatingScore", kind: "number", description: "The analyst's rating score (0\u2013100, joined from their profile). >= 60 keeps well-rated analysts.", defaultOp: ">=", defaultValue: 60 },
  { name: "analystBlendedWinRate", kind: "number", description: "The analyst's blended win rate % (joined from their profile).", defaultOp: ">=", defaultValue: 60 },
];

interface ShadowAlphaPredictionsConfig {
  lookbackDays: number;
  /** Join get_analyst stats onto each signal (cached per handle). */
  joinAnalystStats: boolean;
  statsRefreshMinutes: number;
}

export class ShadowAlphaPredictionsSource implements SignalSource {
  readonly name = SOURCE;
  readonly fieldCatalog = PREDICTION_FIELDS;

  private readonly statsCache = new Map<string, { profile: AnalystProfile | null; fetchedAt: number }>();

  constructor(
    private readonly mcp: McpToolClient,
    private readonly config: ShadowAlphaPredictionsConfig,
  ) {}

  async poll(now: Date = new Date()): Promise<Signal[]> {
    const dateFrom = new Date(now.getTime() - this.config.lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let rows: PredictionRow[] = [];
    try {
      const result = (await this.mcp.callTool("search_predictions", {
        date_from: dateFrom,
        sort_by: "date_desc",
        limit: 50,
      })) as { predictions?: PredictionRow[] };
      rows = result?.predictions ?? [];
    } catch (err) {
      log.error(`${SOURCE}: search_predictions failed this poll — continuing`, err);
      return [];
    }

    const signals: Signal[] = [];
    for (const row of rows) {
      const signal = this.normalizeRow(row);
      if (!signal) continue;
      await this.joinStats(signal, row, now);
      signals.push(signal);
    }
    return signals;
  }

  private normalizeRow(row: PredictionRow): Signal | null {
    const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : null;
    const direction =
      row.direction === "bullish" || row.direction === "bearish" ? row.direction : null;
    if (!symbol || !direction) return null;

    const upstreamId = row.source_id ?? row.id;
    if (upstreamId === undefined || upstreamId === null) return null;

    const confidence = Number(row.confidence);
    const targetPrice = Number(row.target_price);
    const entryPrice = Number(row.entry_price);
    const timestamp = normalizeTimestamp(row.post_timestamp) ?? new Date().toISOString();

    const fields: Record<string, FieldValue> = {
      hasTargetPrice: Number.isFinite(targetPrice) && targetPrice > 0,
    };
    if (typeof row.channel_handle === "string") fields.analystHandle = row.channel_handle;
    if (typeof row.specificity_tier === "number") fields.specificityTier = row.specificity_tier;
    if (Number.isFinite(targetPrice) && targetPrice > 0) fields.targetPrice = targetPrice;
    if (Number.isFinite(entryPrice) && entryPrice > 0) fields.entryPrice = entryPrice;

    return {
      symbol,
      type: "prediction",
      direction,
      strength: Number.isFinite(confidence) ? clampStrength(confidence) : 0.5,
      source: SOURCE,
      timestamp,
      confidence: Number.isFinite(confidence) ? clampStrength(confidence) : undefined,
      fields,
      dedupeKey: `${SOURCE}:pred:${upstreamId}`,
      raw: row,
    };
  }

  /** Stamp cached analyst stats onto the signal; absence fails closed. */
  private async joinStats(signal: Signal, row: PredictionRow, now: Date): Promise<void> {
    if (!this.config.joinAnalystStats) return;
    const handle = typeof row.channel_handle === "string" ? row.channel_handle : null;
    if (!handle) return;

    let cached = this.statsCache.get(handle);
    if (!cached || now.getTime() - cached.fetchedAt > this.config.statsRefreshMinutes * 60_000) {
      try {
        const result = (await this.mcp.callTool("get_analyst", { handle })) as {
          analyst?: AnalystProfile;
        };
        cached = { profile: result?.analyst ?? null, fetchedAt: now.getTime() };
      } catch (err) {
        // Missing stats just means those fields stay absent (fail closed).
        log.warn(`${SOURCE}: get_analyst(${handle}) failed — stats fields absent (${String(err)})`);
        cached = { profile: null, fetchedAt: now.getTime() };
      }
      this.statsCache.set(handle, cached);
    }

    const profile = cached.profile;
    if (!profile) return;
    if (typeof profile.rating_score === "number" && Number.isFinite(profile.rating_score)) {
      signal.fields.analystRatingScore = profile.rating_score;
    }
    if (typeof profile.blended_win_rate === "number" && Number.isFinite(profile.blended_win_rate)) {
      signal.fields.analystBlendedWinRate = profile.blended_win_rate;
    }
  }
}

