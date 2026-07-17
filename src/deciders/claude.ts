/**
 * Minimal Claude-backed reference decider — the "AI" in AI-managed, behind
 * the exact same Decider interface as the rules decider.
 *
 * Key-gated and fail-closed: with no ANTHROPIC_API_KEY the factory returns
 * null and the registry falls back to deterministic rules. The model only
 * PROPOSES — every proposal still passes through the execution gate, so no
 * decision here can exceed an in-force cap or skip the confirm gate.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DecisionContext, Decider, Proposal } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { makeId, minutesFromNow, roundMoney, roundShares } from "../core/normalize.js";
import { sizeShares } from "../core/sizing.js";
import { log } from "../core/log.js";

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          action: { type: "string", enum: ["buy", "sell", "hold"] },
          reasoning: { type: "string" },
        },
        required: ["symbol", "action", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are the decision component of a long-only equity trading engine.
Given fresh normalized signals, open positions, and current quotes, propose trades.
Rules you must follow:
- Long-only: "buy" opens/adds exposure, "sell" closes an existing position. Never propose selling a symbol that is not held.
- Only propose trades justified by the provided signals and positions. "hold" is always acceptable.
- One decision per symbol at most. Keep reasoning to one sentence.
Your proposals are suggestions: a deterministic execution layer enforces the user's caps and may refuse them.`;

interface ClaudeDecision {
  symbol: string;
  action: "buy" | "sell" | "hold";
  reasoning: string;
}

type ClaudeConfig = Settings["claude"];

export class ClaudeDecider implements Decider {
  readonly name = "claude";
  private readonly client: Anthropic;
  /** Cost-brake state — in-memory, resets on restart (documented in schema). */
  private lastCallMs = 0;
  private deferred = false;
  private dayKey = "";
  private callsToday = 0;
  private budgetWarned = false;

  constructor(
    private readonly config: ClaudeConfig,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  /** True when a min-interval deferral is ready — the intake loop re-decides. */
  wantsRetry(now: Date = new Date()): boolean {
    if (!this.deferred) return false;
    const min = this.config.minSecondsBetweenCalls;
    return min === null || now.getTime() - this.lastCallMs >= min * 1000;
  }

  async decide(ctx: DecisionContext): Promise<Proposal[]> {
    if (ctx.signals.length === 0 && ctx.positions.length === 0) return [];
    if (!this.passesCostBrakes(ctx)) return [];

    const payload = {
      now: ctx.now.toISOString(),
      signals: ctx.signals.map((s) => ({
        symbol: s.symbol,
        type: s.type,
        direction: s.direction,
        strength: s.strength,
        source: s.source,
        confidence: s.confidence,
        ageMinutes: Math.round((ctx.now.getTime() - Date.parse(s.timestamp)) / 60_000),
      })),
      positions: ctx.positions.map((p) => ({
        symbol: p.symbol,
        shares: p.shares,
        costBasis: p.costBasis,
        currentPrice: p.currentPrice,
        unrealizedPnlPct: p.unrealizedPnlPct,
      })),
      quotes: ctx.quotes,
    };

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: DECISION_SCHEMA } },
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });

    if (response.stop_reason !== "end_turn") {
      log.warn(`Claude decider stopped with "${response.stop_reason}" — no proposals this tick.`);
      return [];
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text) return [];

    const { decisions } = JSON.parse(text.text) as { decisions: ClaudeDecision[] };
    return this.toProposals(decisions, ctx);
  }

  /**
   * The user-owned LLM cost brakes. A burst inside minSecondsBetweenCalls is
   * DEFERRED: signals stay in the window and the loop retries via
   * wantsRetry(), so bursts collapse into one batched call instead of many.
   * A spent maxCallsPerDay budget skips LOUDLY: each blocked symbol lands in
   * the Event feed as entry_skipped, and AI decisions resume next UTC day.
   */
  private passesCostBrakes(ctx: DecisionContext): boolean {
    const nowMs = ctx.now.getTime();
    const day = ctx.now.toISOString().slice(0, 10);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.callsToday = 0;
      this.budgetWarned = false;
    }

    const budget = this.config.maxCallsPerDay;
    if (budget !== null && this.callsToday >= budget) {
      this.deferred = false; // nothing to retry until the day rolls over
      if (!this.budgetWarned) {
        log.warn(
          `Claude decider daily call budget (${budget}) exhausted — no AI decisions until tomorrow (UTC). Raise claude.maxCallsPerDay to change this.`,
        );
        this.budgetWarned = true;
      }
      for (const symbol of new Set(
        ctx.signals.filter((s) => s.direction === "bullish").map((s) => s.symbol),
      )) {
        ctx.onSkip?.({
          symbol,
          reason: `AI decider daily call budget (${budget}) exhausted — resumes next UTC day`,
        });
      }
      return false;
    }

    const min = this.config.minSecondsBetweenCalls;
    if (min !== null && this.lastCallMs !== 0 && nowMs - this.lastCallMs < min * 1000) {
      this.deferred = true; // the loop retries once the interval passes
      return false;
    }

    this.deferred = false;
    this.lastCallMs = nowMs;
    this.callsToday += 1;
    return true;
  }

  /** Long-only mapping enforced in code — the model cannot talk its way around it. */
  private toProposals(decisions: ClaudeDecision[], ctx: DecisionContext): Proposal[] {
    const held = new Map(ctx.positions.map((p) => [p.symbol, p]));
    const proposals: Proposal[] = [];
    const seen = new Set<string>();

    for (const d of decisions) {
      const symbol = d.symbol.toUpperCase();
      if (d.action === "hold" || seen.has(symbol)) continue;
      seen.add(symbol);

      const quote = ctx.quotes[symbol];
      const position = held.get(symbol);

      if (d.action === "buy") {
        if (position || !quote) continue;
        const shares = sizeShares(quote.price, ctx.settings.sizing, ctx.equity);
        if (shares === 0) continue;
        const stopLossPct = ctx.settings.exit.stopLossPct;
        proposals.push(
          this.buildProposal(ctx, symbol, "buy", shares, quote.price, d.reasoning, {
            protectiveStop:
              stopLossPct !== null
                ? roundMoney(quote.price * (1 - stopLossPct / 100))
                : undefined,
          }),
        );
      } else {
        if (!position) continue;
        proposals.push(
          this.buildProposal(
            ctx,
            symbol,
            "sell",
            roundShares(position.shares),
            position.currentPrice,
            d.reasoning,
            {},
          ),
        );
      }
    }
    return proposals;
  }

  private buildProposal(
    ctx: DecisionContext,
    symbol: string,
    action: "buy" | "sell",
    shares: number,
    referencePrice: number,
    reasoning: string,
    extra: { protectiveStop?: number },
  ): Proposal {
    return {
      id: makeId("prop"),
      symbol,
      action,
      direction: action === "buy" ? "bullish" : "bearish",
      decider: this.name,
      suggestedShares: shares,
      referencePrice,
      protectiveStop: extra.protectiveStop,
      rationale: reasoning,
      createdAt: ctx.now.toISOString(),
      expiresAt: minutesFromNow(ctx.settings.executionBehavior.proposalTtlMinutes, ctx.now),
      priceBandPct: ctx.settings.executionBehavior.priceBandPct,
    };
  }
}

/** Key-gated factory: no API key → null (caller falls back to rules; fail closed). */
export function createClaudeDecider(config: ClaudeConfig): ClaudeDecider | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new ClaudeDecider(config);
}
