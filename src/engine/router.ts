/**
 * Proposal router — the lifecycle layer between deciders/exit rules and the
 * execution gate. Anti-flooding rules live here:
 *
 * - One open proposal per symbol: while a symbol has an open, unexpired
 *   proposal, new proposals for it are dropped and logged, not queued.
 * - Rejection cooldown: after a rejection, the same symbol+action is
 *   suppressed for entry.rejectionCooldownMinutes (buys) /
 *   exit.rejectionCooldownMinutes (sells). Null disables. Nuance: a confirm
 *   ask that times out resolves as "rejected" and cools down — unless the
 *   loops' expireStaleProposals marks it "expired" first (no cooldown).
 *   Explicit rejections always cool down; silent timeouts sometimes do.
 * - Every proposal carries expiresAt; expired proposals cannot execute.
 * - Every create, drop, suppress, confirm, reject, refusal, and execution is
 *   audited.
 *
 * Execution modes:
 * - off:     narrate + print + record. Nothing executes. The open record
 *            prevents re-print spam until the proposal expires.
 * - confirm: register the ask and RETURN — the engine's loops must never
 *   block on a human. The answer (a dashboard click, a CLI keypress, or the
 *   TTL expiring as a decline) resolves later and executes then. `settle()`
 *   awaits in-flight confirmations, for tests and shutdown.
 * - auto:    straight to the gate (which enforces every in-force cap).
 */

import type { PendingProposal, Proposal } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { StateStore } from "../core/state.js";
import type { AuditLog } from "../core/audit.js";
import type { ExecutionGate } from "../execution/gate.js";
import type { Narrator } from "../narrator/narrator.js";
import type { ConfirmChannel } from "./confirm.js";
import { log } from "../core/log.js";

export class ProposalRouter {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly settings: Settings,
    private readonly store: StateStore,
    private readonly gate: ExecutionGate,
    private readonly narrator: Narrator,
    private readonly audit: AuditLog,
    private readonly confirm: ConfirmChannel,
  ) {}

  async route(proposal: Proposal, now: Date = new Date()): Promise<void> {
    const existing = this.store.openProposalFor(proposal.symbol, now);
    if (existing) {
      this.audit.write("proposal_dropped", {
        proposalId: proposal.id,
        symbol: proposal.symbol,
        reason: `open proposal ${existing.proposal.id} already exists for ${proposal.symbol}`,
      });
      return;
    }

    // Rejection cooldown — checked before narration so a suppressed proposal
    // never costs an LLM call.
    const cooldownMinutes =
      proposal.action === "buy"
        ? this.settings.entry.rejectionCooldownMinutes
        : this.settings.exit.rejectionCooldownMinutes;
    if (cooldownMinutes !== null) {
      const last = this.store.lastRejectionFor(proposal.symbol, proposal.action);
      if (last?.resolvedAt) {
        const cooldownUntil = Date.parse(last.resolvedAt) + cooldownMinutes * 60_000;
        if (cooldownUntil > now.getTime()) {
          this.audit.write("proposal_suppressed", {
            proposalId: proposal.id,
            symbol: proposal.symbol,
            action: proposal.action,
            reason: "rejection_cooldown",
            rejectedProposalId: last.proposal.id,
            cooldownUntil: new Date(cooldownUntil).toISOString(),
          });
          log.info(
            `Suppressed ${proposal.action} ${proposal.symbol} — rejected ${cooldownMinutes}min cooldown in force until ${new Date(cooldownUntil).toISOString()}.`,
          );
          return;
        }
      }
    }

    const narrated = await this.narrator.narrate(proposal);
    proposal.rationale = narrated;
    this.audit.write("proposal_created", { proposal });

    const pending: PendingProposal = { proposal, status: "open" };
    this.store.state.pendingProposals.push(pending);
    this.store.save();

    switch (this.settings.execution) {
      case "off":
        log.proposal(`${narrated}\n  (execution: off — logged only)`);
        return;
      case "confirm": {
        log.proposal(`${narrated}\n  Awaiting confirmation (dashboard Confirm/Reject, or CLI).`);
        // Deliberately NOT awaited: the answer arrives on human time.
        const settled = this.confirm
          .ask(proposal, narrated)
          .then((approved) => this.onConfirmAnswered(pending, approved))
          .catch((err) => {
            log.error(`Confirmation for ${proposal.symbol} failed`, err);
            this.resolve(pending, "refused", `confirm channel error: ${String(err)}`);
          });
        this.inFlight.add(settled);
        void settled.finally(() => this.inFlight.delete(settled));
        return;
      }
      case "auto":
        await this.execute(pending);
        return;
    }
  }

  /** Await all in-flight confirmations — used by tests and shutdown. */
  async settle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private async onConfirmAnswered(pending: PendingProposal, approved: boolean): Promise<void> {
    // The proposal may have expired (TTL) while the ask sat unanswered.
    if (pending.status !== "open") return;
    const proposal = pending.proposal;
    if (!approved) {
      this.audit.write("proposal_rejected", { proposalId: proposal.id });
      this.resolve(pending, "rejected", "rejected or not confirmed before expiry");
      log.info(`Rejected ${proposal.action} ${proposal.symbol}.`);
      return;
    }
    this.audit.write("proposal_confirmed", { proposalId: proposal.id });
    await this.execute(pending);
  }

  private async execute(pending: PendingProposal): Promise<void> {
    const proposal = pending.proposal;
    const outcome = await this.gate.execute(proposal);
    if (outcome.ok) {
      this.resolve(
        pending,
        "executed",
        `filled ${outcome.result.filledShares} @ $${outcome.result.fillPrice}`,
      );
      log.info(
        `EXECUTED ${proposal.action.toUpperCase()} ${outcome.result.filledShares} ${proposal.symbol} @ $${outcome.result.fillPrice} (${this.settings.mode})`,
      );
    } else {
      this.resolve(pending, "refused", outcome.reason);
      log.warn(`REFUSED ${proposal.action} ${proposal.symbol}: ${outcome.reason}`);
    }
  }

  private resolve(
    pending: PendingProposal,
    status: "executed" | "rejected" | "refused",
    resolution: string,
  ): void {
    pending.status = status;
    pending.resolvedAt = new Date().toISOString();
    pending.resolution = resolution;
    this.store.save();
  }
}
