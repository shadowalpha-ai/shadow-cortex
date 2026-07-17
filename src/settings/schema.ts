/**
 * The settings schema IS the strategy surface. One validated object drives
 * scenario, mode, execution, sources, entry rules, exit policy, sizing, caps,
 * and cadence. Validation fails CLOSED: an invalid profile refuses to run.
 *
 * Caps semantics: every cap is user-owned — null disables it. When a cap is
 * in force, the execution layer enforces it and no decider can exceed it.
 * Exposure caps gate ENTRIES ONLY; risk-reducing exits are never blocked.
 */

import { z } from "zod";
import { DEFAULT_ENTRY_RULES, EntryRulesSchema } from "../entry/rules.js";
import { IndicatorSpecSchema } from "../enrichment/ta.js";

const CapsSchema = z
  .object({
    maxSharesPerOrder: z.number().positive().nullable().default(10),
    maxOpenPositions: z.number().int().positive().nullable().default(5),
    maxDollarsPerPosition: z.number().positive().nullable().default(500),
    /**
     * Daily kill-switch: realized + unrealized change since the session's
     * daily anchor. Halts NEW ENTRIES only — never exits. Resets each day.
     */
    maxDailyLoss: z.number().positive().nullable().default(100),
  })
  .default({});

const ShadowAlphaSourceSchema = z.object({
  type: z.literal("shadowalpha"),
  transport: z.enum(["fixture", "live"]).default("fixture"),
  /** Live MCP endpoint; token comes from SHADOWALPHA_MCP_TOKEN env, never inline. */
  url: z.string().default("https://shadowalpha.ai/mcp"),
  /** Ignore signals weaker than this at the adapter boundary. */
  minStrength: z.number().min(0).max(1).default(0.3),
});

const ShadowAlphaPredictionsSourceSchema = z.object({
  type: z.literal("shadowalpha-predictions"),
  transport: z.enum(["fixture", "live"]).default("fixture"),
  url: z.string().default("https://shadowalpha.ai/mcp"),
  /** How far back the per-poll prediction search looks. */
  lookbackDays: z.number().int().min(1).max(30).default(3),
  /** Join each analyst's rating/win-rate onto their signals (cached). */
  joinAnalystStats: z.boolean().default(true),
  statsRefreshMinutes: z.number().positive().default(60),
});

const ShadowAlphaPortfolioSourceSchema = z.object({
  type: z.literal("shadowalpha-portfolio"),
  transport: z.enum(["fixture", "live"]).default("fixture"),
  /** Live MCP endpoint; token comes from SHADOWALPHA_MCP_TOKEN env, never inline. */
  url: z.string().default("https://shadowalpha.ai/mcp"),
  /**
   * The portfolios/curations to follow — names or numeric ids (as strings).
   * Explicit by design: there is no "follow everything" mode. One source
   * instance handles many portfolios; configure this list, not duplicates.
   */
  portfolios: z.array(z.string()).min(1),
  /** How often the portfolio listing (metadata, cursor seeds, picker) refreshes. */
  listRefreshMinutes: z.number().positive().default(15),
});

const SourceSchema = z.discriminatedUnion("type", [
  ShadowAlphaSourceSchema,
  ShadowAlphaPredictionsSourceSchema,
  ShadowAlphaPortfolioSourceSchema,
]);

const EntrySchema = z
  .object({
    /**
     * The entry criteria: rule cards over ingested data fields
     * (see src/entry/rules.ts). Defaults to the conservative consensus /
     * strong-signal pair.
     */
    rules: EntryRulesSchema.default(DEFAULT_ENTRY_RULES),
    /** Tickers never traded, whatever the rules say. Enforced first, always. */
    symbolBlocklist: z.array(z.string()).default([]),
    /**
     * After you reject a BUY proposal for a symbol, don't re-propose buying it
     * for this many minutes. null = off. Ceiling: resolved proposals are
     * pruned after 24h, so values above 1440 behave like 1440.
     */
    rejectionCooldownMinutes: z.number().positive().nullable().default(30),
    /**
     * Minimum reward-to-risk: take-profit distance ÷ effective stop distance
     * must be at least this before an entry is proposed. Needs both a target
     * and a stop to compute — if either is off while this is set, entries are
     * REFUSED (fail closed) rather than traded ungated.
     */
    minRewardRiskRatio: z.number().positive().nullable().default(null),
  })
  .default({});

const ExitSchema = z
  .object({
    /** Hard stop, % below cost basis. */
    stopLossPct: z.number().positive().nullable().default(5),
    /** Trail % off the per-position high-water mark. */
    trailingStopPct: z.number().positive().nullable().default(7),
    /**
     * The trailing stop arms only after the position is up this % from cost
     * basis — prevents ordinary entry noise from trailing you straight out.
     * null = the trail is live immediately.
     */
    trailActivationPct: z.number().positive().nullable().default(null),
    /** Fixed profit target, % above cost basis. */
    takeProfitPct: z.number().positive().nullable().default(15),
    /** Time-based exit, in days. */
    maxHoldDays: z.number().positive().nullable().default(3),
    /**
     * Volatility stop (chandelier-style): exit when price falls
     * atrStopMultiplier × ATR(atrPeriod) below the position's high-water
     * mark. Scales stop distance to how much the symbol actually moves.
     * If ATR data is unavailable for a symbol, this stop is SKIPPED (warned
     * once) — the fixed stops above keep protecting.
     */
    atrStopMultiplier: z.number().positive().nullable().default(null),
    atrPeriod: z.number().int().min(2).max(60).default(14),
    /**
     * Dead-money exit: after breakevenDays, if the position hasn't gained at
     * least breakevenMinMovePct (default 0 = breakeven), exit and free the
     * capital. null days = off.
     */
    breakevenDays: z.number().positive().nullable().default(null),
    breakevenMinMovePct: z.number().nullable().default(null),
    /**
     * Partial take-profit: at +partialTpPct, sell partialCloseFraction of
     * the position ONCE; the remainder keeps running under the other exits.
     * null = off.
     */
    partialTpPct: z.number().positive().nullable().default(null),
    partialCloseFraction: z.number().min(0.05).max(0.95).default(0.5),
    /**
     * After you reject a SELL proposal for a symbol, don't re-propose selling
     * it for this many minutes. null = off (the default): a rejected stop-loss
     * suggestion re-asks promptly, because exit proposals reduce risk. Turn
     * this on only if the re-asks bother you — and know a falling position
     * stays quiet for the whole window. Same 24h retention ceiling as the
     * entry cooldown.
     */
    rejectionCooldownMinutes: z.number().positive().nullable().default(null),
  })
  .default({});

const SizingSchema = z
  .object({
    mode: z.enum(["fixedDollar", "fixedShares", "percentOfEquity"]).default("fixedDollar"),
    /** Dollars, shares, or percent depending on mode. */
    value: z.number().positive().default(25),
    /** Fractional sizing is what makes tiny-account live testing possible. */
    allowFractionalShares: z.boolean().default(true),
  })
  .default({});

const PaperSchema = z
  .object({
    startingCash: z.number().positive().default(10_000),
    seedPositions: z
      .array(
        z.object({
          symbol: z.string(),
          shares: z.number().positive(),
          costBasis: z.number().positive(),
          openedAt: z.string(),
        }),
      )
      .default([]),
  })
  .default({});

export const SettingsSchema = z.object({
  /** Preset selecting axis defaults. Never sets mode or execution. */
  scenario: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
  mode: z.enum(["paper", "live"]).default("paper"),
  /**
   * Which real broker `mode: "live"` uses. Must be set explicitly — live mode
   * with no broker refuses to run rather than silently paper-trading.
   */
  liveBroker: z.enum(["robinhood"]).nullable().default(null),
  /** Robinhood agentic-trading MCP (the Hybrid live broker). */
  robinhood: z
    .object({
      url: z.string().default("https://agent.robinhood.com/mcp/trading"),
      /** null = the adapter discovers the agentic-enabled account itself. */
      accountNumber: z.string().nullable().default(null),
      /** Refuse to place when the pre-trade review reports any warning. */
      refuseOnReviewWarning: z.boolean().default(true),
    })
    .default({}),
  /** One knob: off = log proposals only; confirm = user approves; auto = within caps. */
  execution: z.enum(["off", "confirm", "auto"]).default("off"),
  caps: CapsSchema,
  cadence: z
    .object({
      intakePollMs: z.number().int().min(250).default(60_000),
      managementPollMs: z.number().int().min(250).default(30_000),
    })
    .default({}),
  /** Basic weekday + regular-hours ET gate (no holiday calendar — documented limitation). */
  marketHoursOnly: z.boolean().default(true),
  signalTtlMinutes: z.number().positive().default(60),
  dedupeWindowMinutes: z.number().positive().default(30),
  sources: z.array(SourceSchema).default([{ type: "shadowalpha", transport: "fixture" }]),
  /**
   * Symbol enrichment for entry criteria. The engine computes whatever the
   * entry rules reference (ta.*, conviction.*, predictions.*) — these blocks
   * only choose providers/transports and tuning; `ta.indicators` is optional
   * manual extras on top of the rules-derived set.
   */
  enrichment: z
    .object({
      ta: z
        .object({
          provider: z.enum(["fixture", "robinhood"]).default("fixture"),
          indicators: z.array(IndicatorSpecSchema).default([]),
          /** How long fetched indicator values stay fresh per symbol. */
          cacheMinutes: z.number().positive().default(15),
        })
        .default({}),
      /**
       * conviction.* / predictions.* fields from the ShadowAlpha per-symbol
       * tools. Activated automatically when entry rules reference them.
       */
      shadowalpha: z
        .object({
          transport: z.enum(["fixture", "live"]).default("fixture"),
          url: z.string().default("https://shadowalpha.ai/mcp"),
          daysBack: z.number().int().min(1).max(365).default(30),
          cacheMinutes: z.number().positive().default(30),
        })
        .default({}),
    })
    .default({}),
  decider: z.enum(["rules", "claude"]).default("rules"),
  entry: EntrySchema,
  exit: ExitSchema,
  sizing: SizingSchema,
  executionBehavior: z
    .object({
      /** Refuse execution if price drifted beyond this % from referencePrice. */
      priceBandPct: z.number().positive().default(1),
      proposalTtlMinutes: z.number().positive().default(30),
    })
    .default({}),
  quoteSource: z.enum(["fixture", "shadowalpha", "broker"]).default("fixture"),
  paper: PaperSchema,
  claude: z
    .object({
      model: z.string().default("claude-opus-4-8"),
    })
    .default({}),
  /**
   * Local monitoring dashboard (React app in ui/). Binds to 127.0.0.1 ONLY —
   * the confirm endpoint is an order-execution surface and must never listen
   * on the network. Off in SAFE_DEFAULTS.
   */
  ui: z
    .object({
      enabled: z.boolean().default(false),
      /** 0 = ephemeral (the OS picks a free port; used by tests). */
      port: z.number().int().min(0).max(65535).default(7777),
    })
    .default({}),
  paths: z
    .object({
      stateFile: z.string().default("state/engine-state.json"),
      auditLog: z.string().default("state/audit.jsonl"),
      quotesFixture: z.string().default("fixtures/quotes.json"),
      signalsFixture: z.string().default("fixtures/shadowalpha-ideas.json"),
      portfolioFixture: z.string().default("fixtures/portfolio-signals.json"),
      predictionsFixture: z.string().default("fixtures/shadowalpha-predictions.json"),
      enrichmentFixture: z.string().default("fixtures/shadowalpha-enrichment.json"),
      /** OAuth tokens from `npm run robinhood:connect` or the dashboard (0600; state/ is gitignored). */
      robinhoodOauth: z.string().default("state/robinhood-oauth.json"),
      /** ShadowAlpha token saved by the dashboard's Connections panel; env var wins over it. */
      shadowalphaToken: z.string().default("state/shadowalpha-token.json"),
      taFixture: z.string().default("fixtures/ta-indicators.json"),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
