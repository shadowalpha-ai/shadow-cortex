/**
 * Entry-rule templates — the default way to add a rule. Each template is a
 * tiny wizard: a couple of plain-English questions whose answers fill in a
 * complete, correct rule card (and enable any feed the card depends on).
 * "Custom" (a blank card) stays available at the bottom of the list.
 *
 * Templates only use datapoints the engine actually serves (validated by test/templates.test.ts); thresholds
 * default to each field's declared sensible starting point.
 */

import type { EntryRule } from "./rules.js";
import type { Settings } from "../settings/schema.js";

type FeedType = Settings["sources"][number]["type"];

export interface TemplateQuestion {
  id: string;
  label: string;
  help?: string;
  type: "number" | "select" | "portfolio";
  options?: Array<{ value: number | string; label: string }>;
  defaultValue: number | string;
}

export interface RuleTemplate {
  id: string;
  title: string;
  description: string;
  /** Feeds this rule needs enabled (auto-enabled on apply). */
  requiresFeeds: FeedType[];
  questions: TemplateQuestion[];
  build(answers: Record<string, number | string>): EntryRule;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "copy-trade",
    title: "Copy-trade a portfolio",
    description:
      "Mirror the buys of one of your ShadowAlpha portfolios/curations. When it opens a position, the engine proposes the same symbol.",
    requiresFeeds: ["shadowalpha-portfolio"],
    questions: [
      {
        id: "portfolio",
        label: "Which portfolio should be copied?",
        type: "portfolio",
        defaultValue: "",
      },
      {
        id: "winRateGate",
        label: "Require a minimum track record?",
        help: "Pauses copying automatically if the portfolio's closed-trade win rate falls below the bar.",
        type: "select",
        options: [
          { value: 0, label: "No — mirror everything it buys" },
          { value: 50, label: "Only while its win rate is ≥ 50%" },
          { value: 60, label: "Only while its win rate is ≥ 60%" },
          { value: 70, label: "Only while its win rate is ≥ 70%" },
        ],
        defaultValue: 0,
      },
    ],
    build(a) {
      const constraints: EntryRule["constraints"] = [
        { field: "portfolioName", op: "==", value: String(a.portfolio) },
      ];
      if (Number(a.winRateGate) > 0) {
        constraints.push({ field: "portfolioWinRatePct", op: ">=", value: Number(a.winRateGate) });
      }
      return {
        label: `Copy-trade: ${a.portfolio}`,
        source: "shadowalpha-portfolio",
        symbols: [],
        constraints,
      };
    },
  },
  {
    id: "oversold-dip",
    title: "Oversold dip buy (low RSI)",
    description:
      "Buy on any signal whose chart looks oversold — RSI at or below your threshold. Computed live per symbol.",
    requiresFeeds: [],
    questions: [
      {
        id: "rsi",
        label: "How oversold? RSI at or below…",
        help: "RSI runs 0–100. Below ~30 is the classic oversold reading; 35 is looser, 25 stricter.",
        type: "number",
        defaultValue: 30,
      },
    ],
    build(a) {
      return {
        label: `Oversold dip (RSI ≤ ${a.rsi})`,
        source: null,
        symbols: [],
        constraints: [{ field: "ta.rsi14", op: "<=", value: Number(a.rsi) }],
      };
    },
  },
  {
    id: "quality-picks",
    title: "Quality analyst picks",
    description:
      "Follow tracked analyst predictions, but only confident calls from well-rated analysts (rating and win rate join automatically).",
    requiresFeeds: ["shadowalpha-predictions"],
    questions: [
      {
        id: "confidence",
        label: "Minimum stated confidence (0–1)?",
        type: "number",
        defaultValue: 0.7,
      },
      {
        id: "rating",
        label: "Minimum analyst rating score (0–100)?",
        help: "The analyst's ShadowAlpha rating, joined from their profile.",
        type: "number",
        defaultValue: 60,
      },
    ],
    build(a) {
      return {
        label: "Quality analyst picks",
        source: "shadowalpha-predictions",
        symbols: [],
        constraints: [
          { field: "confidence", op: ">=", value: Number(a.confidence) },
          { field: "analystRatingScore", op: ">=", value: Number(a.rating) },
        ],
      };
    },
  },
  {
    id: "momentum-breakout",
    title: "Momentum breakout",
    description:
      "Buy signals only when the chart agrees: bullish MACD momentum with price above its moving average.",
    requiresFeeds: [],
    questions: [
      {
        id: "average",
        label: "Price must be above which average?",
        type: "select",
        options: [
          { value: "50", label: "50-day (medium-term trend)" },
          { value: "200", label: "200-day (long-term trend)" },
          { value: "both", label: "Both" },
        ],
        defaultValue: "50",
      },
      {
        id: "guard",
        label: "Skip already-overbought charts?",
        type: "select",
        options: [
          { value: "yes", label: "Yes — require RSI ≤ 70" },
          { value: "no", label: "No — momentum only" },
        ],
        defaultValue: "yes",
      },
    ],
    build(a) {
      const constraints: EntryRule["constraints"] = [
        { field: "ta.macdHist", op: ">=", value: 0 },
      ];
      if (a.average === "50" || a.average === "both") {
        constraints.push({ field: "ta.priceVsSma50Pct", op: ">=", value: 0 });
      }
      if (a.average === "200" || a.average === "both") {
        constraints.push({ field: "ta.priceVsSma200Pct", op: ">=", value: 0 });
      }
      if (a.guard === "yes") {
        constraints.push({ field: "ta.rsi14", op: "<=", value: 70 });
      }
      return { label: "Momentum breakout", source: null, symbols: [], constraints };
    },
  },
  {
    id: "buzzing",
    title: "Buzzing stock (unusual attention)",
    description:
      "The ShadowAlpha buzz scanner: symbols suddenly getting outsized analyst attention, backed by a decent analyst rating.",
    requiresFeeds: ["shadowalpha"],
    questions: [
      {
        id: "spike",
        label: "Minimum attention spike ratio?",
        help: "How many times above the symbol's normal chatter level. 8 = strong spike.",
        type: "number",
        defaultValue: 8,
      },
      {
        id: "rating",
        label: "Minimum analyst rating (0–100)?",
        type: "number",
        defaultValue: 55,
      },
    ],
    build(a) {
      return {
        label: "Buzzing + analyst-backed",
        source: "shadowalpha",
        symbols: [],
        constraints: [
          { field: "type", op: "==", value: "consensus" },
          { field: "spikeRatio", op: ">=", value: Number(a.spike) },
          { field: "analystRating", op: ">=", value: Number(a.rating) },
        ],
      };
    },
  },
  {
    id: "conviction-zone",
    title: "AI conviction buy zone",
    description:
      "Only buy when ShadowAlpha's AI analysis has the symbol in an active buy zone with a broad bull case.",
    requiresFeeds: [],
    questions: [
      {
        id: "bullPoints",
        label: "Minimum distinct bull-case points?",
        help: "More points = a broader bull thesis in the analysis.",
        type: "number",
        defaultValue: 3,
      },
    ],
    build(a) {
      return {
        label: "AI conviction buy zone",
        source: null,
        symbols: [],
        constraints: [
          { field: "conviction.buyZoneActive", op: "==", value: true },
          { field: "conviction.bullPoints", op: ">=", value: Number(a.bullPoints) },
        ],
      };
    },
  },
  {
    id: "crowd-favorite",
    title: "Crowd favorite",
    description:
      "Only buy symbols where the tracked-prediction crowd is decisively bullish — with enough predictions to mean something.",
    requiresFeeds: [],
    questions: [
      {
        id: "bullishPct",
        label: "Minimum share of bullish predictions (%)?",
        type: "number",
        defaultValue: 70,
      },
      {
        id: "count",
        label: "Minimum number of predictions in the window?",
        help: "Guards against 'one guy was bullish' counting as a crowd.",
        type: "number",
        defaultValue: 3,
      },
    ],
    build(a) {
      return {
        label: "Crowd favorite",
        source: null,
        symbols: [],
        constraints: [
          { field: "predictions.bullishPct", op: ">=", value: Number(a.bullishPct) },
          { field: "predictions.count", op: ">=", value: Number(a.count) },
        ],
      };
    },
  },
];
