/**
 * The ONE validation path for settings documents. The boot loader, the
 * dashboard API, and the validate-profile CLI all call these — so a profile
 * that any of them accepts is a profile the engine will actually run, and a
 * profile any of them rejects is rejected everywhere with the same words.
 */

import { SettingsSchema, type Settings } from "./schema.js";
import { hasRobinhoodTokens } from "../execution/robinhood-oauth.js";
import { enrichmentNeeds } from "../enrichment/catalog.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; settings: Settings }
  | { ok: false; issues: ValidationIssue[] };

/**
 * zod validation plus the raw-key rules that zod can't express:
 * - Preset precedence: scenario 1/2 documents must carry explicit `mode` and
 *   `execution` keys — a preset never enables automation silently.
 * - Scenario 2 must keep a programmatic stop — deterministic exits are that
 *   scenario's safety mechanism.
 * Operates on the RAW document because preset precedence reads raw keys.
 */
export function parseSettingsDocument(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: "(root)", message: "profile must be a JSON object" }] };
  }

  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }

  const settings = parsed.data;
  const rawObj = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  if (settings.scenario === 1 || settings.scenario === 2) {
    for (const field of ["mode", "execution"] as const) {
      if (!(field in rawObj)) {
        issues.push({
          path: field,
          message:
            `Scenario ${settings.scenario} profile must set "${field}" explicitly — ` +
            `a preset never enables automation silently (fail closed).`,
        });
      }
    }
  }

  if (
    settings.scenario === 2 &&
    settings.exit.stopLossPct === null &&
    settings.exit.trailingStopPct === null
  ) {
    issues.push({
      path: "exit",
      message:
        `Scenario 2 requires a programmatic stop (exit.stopLossPct or exit.trailingStopPct) — ` +
        `deterministic exits are this scenario's safety mechanism (fail closed).`,
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}

/** Boot-viability refusal texts — single source of truth, reused by the orchestrator. */
export const LIVE_MODE_REQUIRES_BROKER =
  'mode "live" requires "liveBroker": "robinhood" — refusing to run rather than ' +
  "silently paper-trading (fail closed).";

export const LIVE_MODE_NOT_CONNECTED =
  'mode "live" with the Robinhood broker needs an authorized connection — run ' +
  "`npm run robinhood:connect` once (browser + Robinhood app approval), then restart.";

export const BROKER_QUOTES_REQUIRE_LIVE_BROKER =
  'quoteSource "broker" prices positions through the live broker — it requires ' +
  '"mode": "live" with a connected "liveBroker". Use fixture or shadowalpha otherwise.';

export const TA_ROBINHOOD_NOT_CONNECTED =
  'enrichment.ta.provider "robinhood" needs an authorized Robinhood connection — ' +
  "connect Robinhood in the dashboard (Settings → Connections) or run `npm run robinhood:connect`.";

export const LIVE_TA_FIXTURE =
  "entry rules use ta.* fields but the TA provider is demo data — live mode must not " +
  'decide on fixture indicators. Set "Computed by" to Robinhood in Data sources.';

const SHADOWALPHA_RATE_BUDGET = (callsPerMin: number, minPollMs: number): string =>
  `this configuration polls ShadowAlpha ~${callsPerMin} times/minute, but the API allows 30 — ` +
  `it WILL be rate-limited all day (each portfolio costs one call per intake poll). ` +
  `Raise cadence.intakePollMs to at least ${minPollMs} or follow fewer portfolios.`;

export const DECIDER_CLAUDE_NO_KEY =
  'decider "claude" is selected but ANTHROPIC_API_KEY is not set in the ' +
  "engine's environment, so the engine will run the deterministic rules " +
  "decider instead (fail closed). Export the key in the shell that LAUNCHES " +
  "the engine; the dashboard's Restart button reuses the launch environment, " +
  "so a key exported in a new terminal needs a full stop + relaunch.";

export const LIVE_SA_ENRICHMENT_FIXTURE =
  "entry rules use conviction.*/predictions.* fields but ShadowAlpha enrichment is on " +
  "demo data — live mode must not decide on fixture analysis. Switch the ShadowAlpha " +
  "connection's Data setting to live.";

/**
 * Would this validated document actually boot? Mirrors the orchestrator's
 * construction-time refusals so a saved profile can never strand the user at
 * the next restart. NOTE: deliberately filesystem-dependent — the Robinhood
 * check reads whether the OAuth token file exists, because that IS whether
 * the document boots on this machine.
 */
export function runnableIssues(settings: Settings): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const robinhoodConnected =
    settings.liveBroker === "robinhood" && hasRobinhoodTokens(settings.paths.robinhoodOauth);

  if (settings.mode === "live") {
    if (settings.liveBroker === null) {
      issues.push({ path: "liveBroker", message: LIVE_MODE_REQUIRES_BROKER });
    } else if (!robinhoodConnected) {
      issues.push({ path: "liveBroker", message: LIVE_MODE_NOT_CONNECTED });
    }
  }
  if (settings.quoteSource === "broker" && (settings.mode !== "live" || !robinhoodConnected)) {
    issues.push({ path: "quoteSource", message: BROKER_QUOTES_REQUIRE_LIVE_BROKER });
  }
  const needs = enrichmentNeeds(settings);
  if (
    settings.enrichment.ta.provider === "robinhood" &&
    needs.taSpecs.length > 0 &&
    !hasRobinhoodTokens(settings.paths.robinhoodOauth)
  ) {
    issues.push({ path: "enrichment.ta.provider", message: TA_ROBINHOOD_NOT_CONNECTED });
  }
  // Live-mode honesty: real-money decisions must not run on fixture analysis.
  if (settings.mode === "live") {
    if (needs.rulesTaSpecs.length > 0 && settings.enrichment.ta.provider === "fixture") {
      issues.push({ path: "enrichment.ta.provider", message: LIVE_TA_FIXTURE });
    }
    if (
      (needs.conviction || needs.symbolPredictions) &&
      settings.enrichment.shadowalpha.transport === "fixture"
    ) {
      issues.push({ path: "enrichment.shadowalpha.transport", message: LIVE_SA_ENRICHMENT_FIXTURE });
    }
  }

  // Rate budget: ShadowAlpha allows 30 requests/minute. A config that polls
  // faster than that doesn't crash — it degrades into an all-day throttling
  // storm (learned the hard way), so refuse it with the exact fix.
  const callsPerPoll = settings.sources.reduce((sum, s) => {
    if (!("transport" in s) || s.transport !== "live") return sum;
    return sum + (s.type === "shadowalpha-portfolio" ? Math.max(1, s.portfolios.length) : 1);
  }, 0);
  if (callsPerPoll > 0) {
    const callsPerMin = Math.round((callsPerPoll * 60_000) / settings.cadence.intakePollMs);
    if (callsPerMin > 30) {
      // 30/min budget → each call needs 2s of interval; round up to a whole second.
      const minPollMs = Math.ceil((callsPerPoll * 2_000) / 1000) * 1000;
      issues.push({
        path: "cadence.intakePollMs",
        message: SHADOWALPHA_RATE_BUDGET(callsPerMin, minPollMs),
      });
    }
  }
  return issues;
}

/**
 * Non-blocking heads-ups: true about this machine right now, but not worth
 * refusing to run over (the engine has a safe fallback). Shown by the
 * dashboard, the validate CLI, and get_strategy.
 */
export function runnableWarnings(settings: Settings): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  if (settings.decider === "claude" && !process.env.ANTHROPIC_API_KEY) {
    warnings.push({ path: "decider", message: DECIDER_CLAUDE_NO_KEY });
  }
  return warnings;
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
