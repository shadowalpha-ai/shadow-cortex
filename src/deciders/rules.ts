/**
 * The deterministic rules decider — the DEFAULT. Long-only: bearish signals
 * mean "don't buy", never "short".
 *
 * All qualification logic lives in src/entry/rules.ts as rule cards — the one
 * entry-qualification model. This decider owns only the trade mechanics: skip held symbols and the blocklist,
 * price the candidate, size the order, emit the Proposal.
 */

import type { DecisionContext, Decider, Proposal, Signal } from "../core/types.js";
import { evaluateRulesForSymbol } from "../entry/rules.js";
import { makeId, minutesFromNow, roundMoney } from "../core/normalize.js";
import { sizeShares } from "../core/sizing.js";

export class RulesDecider implements Decider {
  readonly name = "rules";

  async decide(ctx: DecisionContext): Promise<Proposal[]> {
    const { settings, now } = ctx;
    const rules = settings.entry.rules;
    const blocked = new Set(settings.entry.symbolBlocklist.map((s) => s.toUpperCase()));
    const held = new Set(ctx.positions.map((p) => p.symbol));

    const skip = (symbol: string, reason: string) => ctx.onSkip?.({ symbol, reason });

    const bySymbol = new Map<string, Signal[]>();
    for (const signal of ctx.signals) {
      if (signal.direction !== "bullish") continue;
      if (held.has(signal.symbol)) continue; // routine — not worth an audit line
      if (blocked.has(signal.symbol)) {
        skip(signal.symbol, "symbol is on the blocklist");
        continue;
      }
      const list = bySymbol.get(signal.symbol) ?? [];
      list.push(signal);
      bySymbol.set(signal.symbol, list);
    }

    // Min reward/risk gate: target distance ÷ stop distance must clear the
    // bar. Needs both a target and a hard stop — if either is off while the
    // gate is set, ALL entries are refused (fail closed, reported per symbol).
    const minRR = settings.entry.minRewardRiskRatio;
    if (minRR !== null) {
      const target = settings.exit.takeProfitPct;
      const stop = settings.exit.stopLossPct;
      const refusal =
        target === null || stop === null
          ? "min R/R ratio is set but take-profit or stop-loss is off — cannot compute R/R, refusing all entries (fail closed)"
          : target / stop < minRR
            ? `configured take-profit/stop-loss give R/R ${(target / stop).toFixed(2)} < required ${minRR} — refusing all entries`
            : null;
      if (refusal !== null) {
        for (const symbol of bySymbol.keys()) skip(symbol, refusal);
        return [];
      }
    }

    const proposals: Proposal[] = [];
    for (const [symbol, signals] of bySymbol) {
      const match = evaluateRulesForSymbol(symbol, signals, rules, now, ctx.enrichment?.[symbol]);
      if (!match) {
        skip(symbol, `none of the ${rules.length} entry rule card(s) matched`);
        continue;
      }

      const quote = ctx.quotes[symbol];
      if (!quote) {
        skip(symbol, "no quote available this tick");
        continue;
      }

      const shares = sizeShares(quote.price, settings.sizing, ctx.equity);
      if (shares === 0) {
        skip(symbol, `sizing produced 0 shares at $${quote.price} (order too small for current sizing/equity)`);
        continue;
      }

      const stopLossPct = settings.exit.stopLossPct;
      proposals.push({
        id: makeId("prop"),
        symbol,
        action: "buy",
        direction: "bullish",
        decider: this.name,
        contributingSignals: match.contributing.map((s) => s.dedupeKey),
        suggestedShares: shares,
        referencePrice: quote.price,
        protectiveStop:
          stopLossPct !== null ? roundMoney(quote.price * (1 - stopLossPct / 100)) : undefined,
        rationale: `rule "${match.rule.label}" matched`,
        createdAt: now.toISOString(),
        expiresAt: minutesFromNow(settings.executionBehavior.proposalTtlMinutes, now),
        priceBandPct: settings.executionBehavior.priceBandPct,
      });
    }
    return proposals;
  }
}
