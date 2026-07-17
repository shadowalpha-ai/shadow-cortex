/**
 * The engine's single local state file — everything the broker cannot give
 * back: per-position high-water marks, seen dedupe keys, pending proposals,
 * the daily-loss anchor, and the PaperBroker's book.
 *
 * Boot sequence: load state → reconcile against broker → resume. A position
 * discovered at boot with no recorded high-water mark initializes to
 * max(costBasis, currentPrice).
 */

import { readFileSync, existsSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-write.js";
import type { BrokerPosition, PendingProposal, Position } from "./types.js";
import { roundMoney } from "./normalize.js";

export interface PaperBook {
  cash: number;
  positions: Record<
    string,
    { shares: number; costBasis: number; openedAt: string }
  >;
  /** Realized P&L accumulated during the current trading day. */
  realizedToday: number;
  realizedDate: string;
}

export interface EngineState {
  /**
   * Which book this state's day-scoped bookkeeping belongs to ("paper" or
   * "live:robinhood"). Set at boot; a mismatch means the engine switched
   * books and anchors/open proposals from the old book are meaningless (or
   * dangerous) against the new one — see StateStore.switchBook.
   */
  book?: string;
  highWaterMarks: Record<string, number>;
  /** dedupeKey -> ISO timestamp first seen. Pruned past the dedupe window. */
  seenDedupeKeys: Record<string, string>;
  pendingProposals: PendingProposal[];
  /** Equity at the first tick of the trading day; resets at market open. */
  dailyLossAnchor: { date: string; equity: number } | null;
  /**
   * symbol → openedAt of the position whose partial take-profit already
   * fired. Keyed on openedAt so a NEW position in the same symbol gets a
   * fresh partial. Cleared by reconcile when the broker stops reporting the
   * position (or reports a different one).
   */
  partialTaken: Record<string, string>;
  paper: PaperBook | null;
  /**
   * Last time a local AI client (x-shadow-cortex-client) called the API.
   * Persisted so the Connections "Local AI" chip survives engine restarts
   * instead of resetting to "Not connected yet".
   */
  localAiLastSeenAt?: string;
}

/** The book identity day-scoped bookkeeping is valid for. */
export function bookId(settings: { mode: string; liveBroker: string | null }): string {
  return settings.mode === "live" ? `live:${settings.liveBroker ?? "unknown"}` : "paper";
}

function emptyState(): EngineState {
  return {
    highWaterMarks: {},
    seenDedupeKeys: {},
    pendingProposals: [],
    dailyLossAnchor: null,
    partialTaken: {},
    paper: null,
  };
}

export class StateStore {
  readonly state: EngineState;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      this.state = { ...emptyState(), ...JSON.parse(readFileSync(path, "utf8")) };
    } else {
      this.state = emptyState();
    }
  }

  /** Atomic write (tmp + rename), so a crash never truncates state. */
  save(): void {
    writeJsonAtomic(this.path, this.state);
  }

  /**
   * Called at boot. If the engine is running against a different book than
   * this state was written under (paper ⇄ live), reset what must not carry
   * over: the daily-loss anchor (old book's equity scale is meaningless —
   * against a real account it would misreport P&L AND falsely trip the
   * daily-loss halt) and any OPEN proposals (a proposal created against the
   * old book must never become executable against the new one). High-water
   * marks self-heal via reconcile(); the paper ledger is deliberately kept
   * so switching back to paper resumes it.
   *
   * Returns the number of open proposals expired, or -1 if no switch happened.
   */
  switchBook(book: string, now: Date = new Date()): number {
    if (this.state.book === book) return -1;
    this.state.book = book;
    this.state.dailyLossAnchor = null;
    let expired = 0;
    for (const p of this.state.pendingProposals) {
      if (p.status !== "open") continue;
      p.status = "expired";
      p.resolvedAt = now.toISOString();
      p.resolution = `account book changed to ${book} — proposal belonged to the previous book`;
      expired += 1;
    }
    this.save();
    return expired;
  }

  // --- dedupe / idempotency ---

  isSeen(dedupeKey: string): boolean {
    return dedupeKey in this.state.seenDedupeKeys;
  }

  markSeen(dedupeKey: string, at: Date = new Date()): void {
    this.state.seenDedupeKeys[dedupeKey] = at.toISOString();
  }

  pruneSeen(windowMinutes: number, now: Date = new Date()): void {
    // Keep keys for 2x the dedupe window so bucket boundaries can't double-fire.
    const cutoff = now.getTime() - windowMinutes * 2 * 60_000;
    for (const [key, seenAt] of Object.entries(this.state.seenDedupeKeys)) {
      if (Date.parse(seenAt) < cutoff) delete this.state.seenDedupeKeys[key];
    }
  }

  // --- high-water marks & reconciliation (broker wins) ---

  /**
   * Reconcile internal state to the broker's reported positions. Removes
   * high-water marks for positions the broker no longer reports, initializes
   * marks for newly discovered positions, and ratchets marks upward.
   */
  reconcile(brokerPositions: BrokerPosition[]): Position[] {
    const live = new Set(brokerPositions.map((p) => p.symbol));
    for (const symbol of Object.keys(this.state.highWaterMarks)) {
      if (!live.has(symbol)) delete this.state.highWaterMarks[symbol];
    }
    const openedAtBySymbol = new Map(brokerPositions.map((p) => [p.symbol, p.openedAt]));
    for (const [symbol, openedAt] of Object.entries(this.state.partialTaken)) {
      if (openedAtBySymbol.get(symbol) !== openedAt) delete this.state.partialTaken[symbol];
    }
    return brokerPositions.map((p) => {
      const prior = this.state.highWaterMarks[p.symbol];
      const hwm = Math.max(prior ?? Math.max(p.costBasis, p.currentPrice), p.currentPrice);
      this.state.highWaterMarks[p.symbol] = hwm;
      const unrealizedPnlPct =
        p.costBasis > 0 ? roundMoney(((p.currentPrice - p.costBasis) / p.costBasis) * 100) : 0;
      return { ...p, highWaterMark: hwm, unrealizedPnlPct };
    });
  }

  // --- pending proposals ---

  openProposalFor(symbol: string, now: Date = new Date()): PendingProposal | undefined {
    return this.state.pendingProposals.find(
      (p) =>
        p.status === "open" &&
        p.proposal.symbol === symbol &&
        Date.parse(p.proposal.expiresAt) > now.getTime(),
    );
  }

  /**
   * The most recent REJECTED proposal for a symbol+action — the basis for the
   * rejection cooldowns. Action-matched: a rejected buy never cools down
   * sells, and vice versa. Rejected entries are retained for 24h (see
   * expireStaleProposals), which caps how far back this can see.
   */
  lastRejectionFor(symbol: string, action: "buy" | "sell"): PendingProposal | undefined {
    let latest: PendingProposal | undefined;
    for (const p of this.state.pendingProposals) {
      if (p.status !== "rejected" || !p.resolvedAt) continue;
      if (p.proposal.symbol !== symbol || p.proposal.action !== action) continue;
      if (!latest || Date.parse(p.resolvedAt) > Date.parse(latest.resolvedAt!)) latest = p;
    }
    return latest;
  }

  expireStaleProposals(now: Date = new Date()): PendingProposal[] {
    const expired: PendingProposal[] = [];
    for (const p of this.state.pendingProposals) {
      if (p.status === "open" && Date.parse(p.proposal.expiresAt) <= now.getTime()) {
        p.status = "expired";
        p.resolvedAt = now.toISOString();
        expired.push(p);
      }
    }
    // Keep the ledger bounded: drop resolved proposals older than a day.
    const cutoff = now.getTime() - 24 * 60 * 60_000;
    this.state.pendingProposals = this.state.pendingProposals.filter(
      (p) => p.status === "open" || Date.parse(p.resolvedAt ?? p.proposal.createdAt) > cutoff,
    );
    return expired;
  }
}
