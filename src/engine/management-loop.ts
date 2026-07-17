/**
 * Management loop — the closed loop that makes this a trading engine rather
 * than a signal generator. Every tick:
 *
 *   1. Read back positions from the broker (the broker is the source of truth).
 *   2. Reconcile internal state (high-water marks) to what the broker reports.
 *   3. Check the daily-loss kill-switch (halts NEW ENTRIES only, never exits).
 *   4. Evaluate the exit policy against each live position and route sell
 *      proposals through the same router and gate as entries — except that
 *      exposure caps do not apply to exits (see the execution gate).
 */

import type { Broker, Position, Proposal, QuoteProvider } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { StateStore } from "../core/state.js";
import type { AuditLog } from "../core/audit.js";
import type { ExecutionGate } from "../execution/gate.js";
import type { ProposalRouter } from "./router.js";
import { evaluateExit, type ExitDecision } from "../exits/policies.js";
import type { AtrProvider } from "../exits/atr.js";
import { makeId, minutesFromNow, roundShares } from "../core/normalize.js";
import { log } from "../core/log.js";

export class ManagementLoop {
  constructor(
    private readonly settings: Settings,
    private readonly broker: Broker,
    private readonly quotes: QuoteProvider,
    private readonly store: StateStore,
    private readonly gate: ExecutionGate,
    private readonly router: ProposalRouter,
    private readonly audit: AuditLog,
    private readonly atrProvider: AtrProvider | null = null,
  ) {}

  private readonly atrWarned = new Set<string>();

  async tick(now: Date = new Date()): Promise<void> {
    this.quotes.advance?.();

    const positions = this.store.reconcile(await this.broker.getPositions());
    this.checkDailyLoss(await this.broker.getAccount(), now);

    const exitPolicyActive = Object.values(this.settings.exit).some((v) => v !== null);
    if (exitPolicyActive) {
      for (const position of positions) {
        try {
          // ATR fetched only when the ATR stop is configured (provider caches).
          let atr: number | null = null;
          if (this.settings.exit.atrStopMultiplier !== null && this.atrProvider) {
            atr = await this.atrProvider.getAtr(position.symbol, this.settings.exit.atrPeriod);
            if (atr === null && !this.atrWarned.has(position.symbol)) {
              this.atrWarned.add(position.symbol);
              log.warn(
                `No ATR for ${position.symbol} — the ATR stop is skipped for it (fixed stops still run).`,
              );
            }
          }
          const decision = evaluateExit(position, this.settings.exit, now, {
            atr,
            partialTaken: this.store.state.partialTaken[position.symbol] === position.openedAt,
          });
          if (!decision) continue;
          // Already proposed and unresolved — don't re-trigger every tick.
          if (this.store.openProposalFor(position.symbol, now)) continue;
          if (decision.fraction !== undefined) {
            // Mark BEFORE routing: one partial per position, even if the
            // proposal is later declined (you can always sell by hand).
            this.store.state.partialTaken[position.symbol] = position.openedAt;
          }
          this.audit.write("exit_triggered", {
            symbol: position.symbol,
            rule: decision.rule,
            detail: decision.detail,
          });
          await this.router.route(this.exitProposal(position, decision, now), now);
        } catch (err) {
          log.error(`Exit evaluation failed for ${position.symbol} — continuing`, err);
          this.audit.write("error", { where: `exit:${position.symbol}`, message: String(err) });
        }
      }
    }

    for (const expired of this.store.expireStaleProposals(now)) {
      this.audit.write("proposal_expired", { proposalId: expired.proposal.id });
    }
    this.store.save();
  }

  /**
   * maxDailyLoss: realized + unrealized change since the day's first tick.
   * Anchor resets each day. Trips → entries halt; exits keep running.
   */
  private checkDailyLoss(account: { equity: number }, now: Date): void {
    const cap = this.settings.caps.maxDailyLoss;
    const today = now.toISOString().slice(0, 10);
    const anchor = this.store.state.dailyLossAnchor;
    if (!anchor || anchor.date !== today) {
      this.store.state.dailyLossAnchor = { date: today, equity: account.equity };
      if (this.gate.entriesHalted) {
        this.gate.entriesHalted = false;
        log.info("New trading day — daily-loss halt cleared.");
      }
      return;
    }
    if (cap === null) return;
    const loss = anchor.equity - account.equity;
    if (loss >= cap && !this.gate.entriesHalted) {
      this.gate.entriesHalted = true;
      this.audit.write("entries_halted", { loss, cap, anchorEquity: anchor.equity });
      log.warn(
        `Daily loss $${loss.toFixed(2)} reached maxDailyLoss ($${cap}) — ` +
          "new entries halted for the day. Exits still run.",
      );
    }
  }

  private exitProposal(position: Position, decision: ExitDecision, now: Date): Proposal {
    const shares =
      decision.fraction !== undefined
        ? roundShares(position.shares * decision.fraction)
        : roundShares(position.shares);
    return {
      id: makeId("exit"),
      symbol: position.symbol,
      action: "sell",
      direction: "bearish",
      decider: `exit:${decision.rule}`,
      suggestedShares: shares,
      referencePrice: position.currentPrice,
      rationale: decision.detail,
      createdAt: now.toISOString(),
      expiresAt: minutesFromNow(this.settings.executionBehavior.proposalTtlMinutes, now),
      priceBandPct: this.settings.executionBehavior.priceBandPct,
    };
  }
}
