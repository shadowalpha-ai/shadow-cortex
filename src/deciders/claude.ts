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

export class ClaudeDecider implements Decider {
  readonly name = "claude";
  private readonly client = new Anthropic();

  constructor(private readonly model: string) {}

  async decide(ctx: DecisionContext): Promise<Proposal[]> {
    if (ctx.signals.length === 0 && ctx.positions.length === 0) return [];

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
      model: this.model,
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
export function createClaudeDecider(model: string): ClaudeDecider | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new ClaudeDecider(model);
}
