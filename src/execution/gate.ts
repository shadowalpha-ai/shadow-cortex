/**
 * The execution gate — the ONLY place orders happen, and where every guard is
 * enforced. No decider, including a full AI agent, can bypass this layer or
 * exceed an in-force cap.
 *
 * Caps semantics (load-bearing):
 * - Exposure caps (maxSharesPerOrder, maxOpenPositions, maxDollarsPerPosition)
 *   and the daily-loss halt gate ENTRIES ONLY. A risk-reducing exit is never
 *   blocked by them — a stop-loss sell must not fail because it exceeds a cap
 *   meant to limit new exposure.
 * - The market-hours gate applies to entries only; exits are always allowed.
 * - The price-band re-check applies to entries AND exits.
 */

import type { Broker, Proposal, OrderResult, QuoteProvider } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { AuditLog } from "../core/audit.js";
import { roundMoney } from "../core/normalize.js";
import { isMarketOpen } from "../engine/market-hours.js";

export type GateOutcome =
  | { ok: true; result: OrderResult }
  | { ok: false; reason: string };

export class ExecutionGate {
  /** Set by the management loop when maxDailyLoss trips. Halts entries only. */
  entriesHalted = false;

  constructor(
    private readonly settings: Settings,
    private readonly broker: Broker,
    private readonly quotes: QuoteProvider,
    private readonly audit: AuditLog,
  ) {}

  async execute(proposal: Proposal, now: Date = new Date()): Promise<GateOutcome> {
    const refuse = (reason: string): GateOutcome => {
      this.audit.write("execution_refused", { proposalId: proposal.id, reason });
      return { ok: false, reason };
    };

    if (Date.parse(proposal.expiresAt) <= now.getTime()) {
      return refuse(`proposal expired at ${proposal.expiresAt}`);
    }

    if (proposal.action === "buy") {
      const entryBlock = await this.checkEntryGuards(proposal, now);
      if (entryBlock) return refuse(entryBlock);
    }

    // Price-band re-check (entries AND exits): refuse if the market moved.
    const quote = await this.quotes.getQuote(proposal.symbol);
    const driftPct = Math.abs(
      ((quote.price - proposal.referencePrice) / proposal.referencePrice) * 100,
    );
    if (driftPct > proposal.priceBandPct) {
      return refuse(
        `price drifted ${roundMoney(driftPct)}% (ref $${proposal.referencePrice} → $${quote.price}), ` +
          `band is ${proposal.priceBandPct}%`,
      );
    }

    const result = await this.broker.placeOrder({
      symbol: proposal.symbol,
      action: proposal.action,
      shares: proposal.suggestedShares,
    });
    this.audit.write("order_executed", {
      proposalId: proposal.id,
      result,
      // Book-scopes the transactions view: paper fills never show in live mode.
      mode: this.settings.mode,
    });
    return { ok: true, result };
  }

  /** Returns a refusal reason, or null if the entry passes every in-force cap. */
  private async checkEntryGuards(proposal: Proposal, now: Date): Promise<string | null> {
    const caps = this.settings.caps;

    if (this.entriesHalted) {
      return `daily-loss halt is active (maxDailyLoss $${caps.maxDailyLoss}) — entries paused, exits still run`;
    }

    if (this.settings.marketHoursOnly && !isMarketOpen(now)) {
      return "market is closed (marketHoursOnly) — entry deferred";
    }

    if (caps.maxSharesPerOrder !== null && proposal.suggestedShares > caps.maxSharesPerOrder) {
      return `order of ${proposal.suggestedShares} shares exceeds maxSharesPerOrder (${caps.maxSharesPerOrder})`;
    }

    const dollars = roundMoney(proposal.suggestedShares * proposal.referencePrice);
    if (caps.maxDollarsPerPosition !== null && dollars > caps.maxDollarsPerPosition) {
      return `order of $${dollars} exceeds maxDollarsPerPosition ($${caps.maxDollarsPerPosition})`;
    }

    if (caps.maxOpenPositions !== null) {
      const positions = await this.broker.getPositions();
      const alreadyHeld = positions.some((p) => p.symbol === proposal.symbol);
      if (!alreadyHeld && positions.length >= caps.maxOpenPositions) {
        return `already holding ${positions.length} positions — maxOpenPositions is ${caps.maxOpenPositions}`;
      }
    }

    return null;
  }
}
