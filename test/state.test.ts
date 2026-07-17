/**
 * State persistence and reconciliation tests. The broker is the source of
 * truth for positions; the state file is the source of truth for everything
 * the broker cannot give back (high-water marks above all).
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { StateStore, bookId } from "../src/core/state.js";
import { makeProposal, newStore, tempDir } from "./helpers.js";
import type { BrokerPosition } from "../src/core/types.js";

const brokerPos = (overrides: Partial<BrokerPosition> = {}): BrokerPosition => ({
  symbol: "HOOD",
  shares: 10,
  costBasis: 68,
  currentPrice: 70,
  openedAt: "2026-07-10T14:30:00Z",
  ...overrides,
});

describe("state store", () => {
  it("high-water marks survive a restart (trailing stops need this)", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");

    const first = new StateStore(path);
    first.reconcile([brokerPos({ currentPrice: 73.1 })]);
    expect(first.state.highWaterMarks.HOOD).toBe(73.1);
    first.save();

    // Simulate an engine restart with the price now lower.
    const second = new StateStore(path);
    const positions = second.reconcile([brokerPos({ currentPrice: 69 })]);
    expect(positions[0]!.highWaterMark).toBe(73.1); // survived, not re-derived
  });

  it("initializes a boot-discovered position to max(costBasis, currentPrice)", () => {
    const store = new StateStore(join(tempDir(), "state.json"));
    const below = store.reconcile([brokerPos({ costBasis: 68, currentPrice: 65 })]);
    expect(below[0]!.highWaterMark).toBe(68);
  });

  it("ratchets the high-water mark upward, never downward", () => {
    const store = new StateStore(join(tempDir(), "state.json"));
    store.reconcile([brokerPos({ currentPrice: 70 })]);
    store.reconcile([brokerPos({ currentPrice: 75 })]);
    const positions = store.reconcile([brokerPos({ currentPrice: 71 })]);
    expect(positions[0]!.highWaterMark).toBe(75);
  });

  it("broker wins: positions the broker no longer reports lose their state", () => {
    const store = new StateStore(join(tempDir(), "state.json"));
    store.reconcile([brokerPos()]);
    expect(store.state.highWaterMarks.HOOD).toBeDefined();
    const after = store.reconcile([]);
    expect(after).toHaveLength(0);
    expect(store.state.highWaterMarks.HOOD).toBeUndefined();
  });

  it("computes unrealized P&L from the broker's numbers", () => {
    const store = new StateStore(join(tempDir(), "state.json"));
    const positions = store.reconcile([brokerPos({ costBasis: 68, currentPrice: 71.4 })]);
    expect(positions[0]!.unrealizedPnlPct).toBe(5);
  });

  it("dedupe keys persist and prune past the window", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    const store = new StateStore(path);
    store.markSeen("a:key", new Date());
    store.markSeen("old:key", new Date(Date.now() - 3 * 3_600_000));
    store.save();

    const reloaded = new StateStore(path);
    expect(reloaded.isSeen("a:key")).toBe(true);
    reloaded.pruneSeen(30); // 30-min window → prune keys older than 60 min
    expect(reloaded.isSeen("old:key")).toBe(false);
    expect(reloaded.isSeen("a:key")).toBe(true);
  });
});

describe("book switching (paper ⇄ live)", () => {
  it("resets the daily-loss anchor and expires open proposals on a book change", () => {
    const store = newStore();
    store.state.dailyLossAnchor = { date: "2026-07-16", equity: 9999.82 };
    store.state.pendingProposals.push(
      { proposal: makeProposal({ symbol: "NVDA" }), status: "open" },
      { proposal: makeProposal({ symbol: "PLTR" }), status: "rejected", resolvedAt: new Date().toISOString() },
    );
    store.state.book = "paper";

    const expired = store.switchBook("live:robinhood");
    expect(expired).toBe(1); // only the open one
    expect(store.state.book).toBe("live:robinhood");
    expect(store.state.dailyLossAnchor).toBeNull();
    expect(store.state.pendingProposals[0]!.status).toBe("expired");
    expect(store.state.pendingProposals[0]!.resolution).toContain("book changed");
    expect(store.state.pendingProposals[1]!.status).toBe("rejected"); // untouched
  });

  it("is a no-op when the book is unchanged", () => {
    const store = newStore();
    store.state.book = "paper";
    store.state.dailyLossAnchor = { date: "2026-07-16", equity: 10_000 };
    expect(store.switchBook("paper")).toBe(-1);
    expect(store.state.dailyLossAnchor).not.toBeNull();
  });

  it("legacy state without a book field counts as a switch (one-time reset)", () => {
    const store = newStore();
    store.state.dailyLossAnchor = { date: "2026-07-16", equity: 10_000 };
    expect(store.switchBook("paper")).toBe(0);
    expect(store.state.dailyLossAnchor).toBeNull();
    expect(store.state.book).toBe("paper");
  });

  it("bookId distinguishes paper from each live broker", () => {
    expect(bookId({ mode: "paper", liveBroker: null })).toBe("paper");
    expect(bookId({ mode: "paper", liveBroker: "robinhood" })).toBe("paper");
    expect(bookId({ mode: "live", liveBroker: "robinhood" })).toBe("live:robinhood");
  });
});
