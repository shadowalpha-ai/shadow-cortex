/**
 * Display metadata + default config blocks for the data-source catalog.
 * Engine-side each feed is its own source adapter, but conceptually feeds and
 * enrichment are DATA TYPES of a connection (ShadowAlpha, Robinhood) — the
 * UI groups them that way. The `source` string on signals and rule cards
 * stays the adapter id.
 */

import type { Settings } from "../../types";

type SourceConfig = Settings["sources"][number];

export const FEED_INFO: Record<string, { title: string; blurb: string; provider: string }> = {
  shadowalpha: {
    provider: "ShadowAlpha",
    title: "Stock ideas (buzz scanner)",
    blurb:
      "Market-wide scanner — symbols getting unusual analyst attention become consensus/buzz signals. Fields: analystRating, spikeRatio, buzz, opp…",
  },
  "shadowalpha-predictions": {
    provider: "ShadowAlpha",
    title: "Analyst predictions",
    blurb:
      "Every tracked analyst call becomes a signal, with the analyst's rating and win rate joined on. Fields: analystHandle, confidence, targetPrice, analystRatingScore, analystBlendedWinRate…",
  },
  "shadowalpha-portfolio": {
    provider: "ShadowAlpha",
    title: "Portfolios / curations",
    blurb:
      "Trades made by the ShadowAlpha portfolios you follow become buy signals (closes become bearish advisories). Fields: portfolioName, portfolioWinRatePct, entryPrice…",
  },
};

/** "shadowalpha-portfolio" → "Portfolios / curations" */
export function feedLabel(sourceId: string): string {
  return FEED_INFO[sourceId]?.title ?? sourceId;
}

/** "shadowalpha-portfolio" → "Portfolios / curations — ShadowAlpha" */
export function feedLabelWithProvider(sourceId: string): string {
  const info = FEED_INFO[sourceId];
  return info ? `${info.title} — ${info.provider}` : sourceId;
}

/** Full default config block for enabling a feed from the UI. */
export function defaultFeedBlock(
  type: "shadowalpha" | "shadowalpha-predictions" | "shadowalpha-portfolio",
  transport: "fixture" | "live",
): SourceConfig {
  const url = "https://shadowalpha.ai/mcp";
  switch (type) {
    case "shadowalpha":
      return { type, transport, url, minStrength: 0.3 };
    case "shadowalpha-predictions":
      return { type, transport, url, lookbackDays: 3, joinAnalystStats: true, statsRefreshMinutes: 60 };
    case "shadowalpha-portfolio":
      return { type, transport, url, portfolios: [], listRefreshMinutes: 15 };
  }
}

