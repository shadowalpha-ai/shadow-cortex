/**
 * WebConfirmChannel — scenario 3's human gate, answered from the dashboard
 * instead of the terminal. The router awaits ask(); a browser click on
 * Confirm/Reject resolves it. An ask that nobody answers times out at the
 * proposal's expiresAt and resolves false (recorded as rejected — the safe
 * default is always "don't trade").
 */

import type { Proposal } from "../core/types.js";
import type { ConfirmChannel } from "../engine/confirm.js";

export interface AwaitingConfirm {
  proposal: Proposal;
  narrated: string;
}

interface PendingAsk extends AwaitingConfirm {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class WebConfirmChannel implements ConfirmChannel {
  private readonly pending = new Map<string, PendingAsk>();

  ask(proposal: Proposal, narrated: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ttlMs = Math.max(0, Date.parse(proposal.expiresAt) - Date.now());
      const timer = setTimeout(() => this.resolve(proposal.id, false), ttlMs);
      timer.unref();
      this.pending.set(proposal.id, { proposal, narrated, resolve, timer });
    });
  }

  /** Open confirmations, for the dashboard to render. */
  list(): AwaitingConfirm[] {
    return [...this.pending.values()].map(({ proposal, narrated }) => ({ proposal, narrated }));
  }

  /** Returns false if the id is unknown (already resolved or expired). */
  resolve(proposalId: string, approved: boolean): boolean {
    const ask = this.pending.get(proposalId);
    if (!ask) return false;
    clearTimeout(ask.timer);
    this.pending.delete(proposalId);
    ask.resolve(approved);
    return true;
  }
}
