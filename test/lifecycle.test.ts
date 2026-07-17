/**
 * Proposal-lifecycle tests: anti-flooding rules. One open proposal per
 * symbol; TTL expiry; the router records every resolution.
 */

import { describe, expect, it } from "vitest";
import { ProposalRouter } from "../src/engine/router.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { Narrator } from "../src/narrator/narrator.js";
import {
  MockQuoteProvider,
  makeProposal,
  makeSettings,
  newAudit,
  newStore,
} from "./helpers.js";
import type { ConfirmChannel } from "../src/engine/confirm.js";

function setup(
  execution: "off" | "confirm" | "auto",
  confirmAnswer = true,
  confirmOverride?: ConfirmChannel,
) {
  const settings = makeSettings({ execution });
  const store = newStore();
  const quotes = new MockQuoteProvider({ NVDA: 100 });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const gate = new ExecutionGate(settings, broker, quotes, newAudit());
  const confirm: ConfirmChannel = confirmOverride ?? { ask: async () => confirmAnswer };
  const router = new ProposalRouter(
    settings,
    store,
    gate,
    new Narrator("claude-opus-4-8"),
    newAudit(),
    confirm,
  );
  return { router, store, broker };
}

describe("proposal lifecycle", () => {
  it("keeps one open proposal per symbol — duplicates are dropped", async () => {
    const { router, store } = setup("off");
    await router.route(makeProposal({ symbol: "NVDA" }));
    await router.route(makeProposal({ symbol: "NVDA" }));
    const open = store.state.pendingProposals.filter((p) => p.status === "open");
    expect(open).toHaveLength(1);
  });

  it("expires open proposals past their TTL", async () => {
    const { router, store } = setup("off");
    await router.route(
      makeProposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const expired = store.expireStaleProposals();
    expect(expired).toHaveLength(1);
    expect(store.state.pendingProposals[0]!.status).toBe("expired");
  });

  it("a resolved (expired) proposal frees the symbol slot for a new one", async () => {
    const { router, store } = setup("off");
    await router.route(
      makeProposal({ symbol: "NVDA", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    store.expireStaleProposals();
    await router.route(makeProposal({ symbol: "NVDA" }));
    const open = store.state.pendingProposals.filter((p) => p.status === "open");
    expect(open).toHaveLength(1);
  });

  it("execution off records the proposal but never touches the broker", async () => {
    const { router, store, broker } = setup("off");
    await router.route(makeProposal({ symbol: "NVDA", suggestedShares: 1 }));
    expect(store.state.pendingProposals[0]!.status).toBe("open");
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it("confirm mode executes on yes — without blocking the route call", async () => {
    const { router, store, broker } = setup("confirm", true);
    await router.route(makeProposal({ suggestedShares: 0.25 }));
    // route() returns while the ask is outstanding; the loops keep ticking.
    await router.settle();
    expect(store.state.pendingProposals[0]!.status).toBe("executed");
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it("confirm mode records a rejection on no and never touches the broker", async () => {
    const { router, store, broker } = setup("confirm", false);
    await router.route(makeProposal({ suggestedShares: 0.25 }));
    await router.settle();
    expect(store.state.pendingProposals[0]!.status).toBe("rejected");
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it("a slow confirmation does not block route()", async () => {
    let answer!: (approved: boolean) => void;
    const { router, store, broker } = setup("confirm", true, {
      ask: () => new Promise<boolean>((res) => (answer = res)),
    });
    await router.route(makeProposal({ suggestedShares: 0.25 }));
    // The human hasn't answered — the proposal is open, nothing executed.
    expect(store.state.pendingProposals[0]!.status).toBe("open");
    expect(await broker.getPositions()).toHaveLength(0);
    // The answer arrives later — execution happens then.
    answer(true);
    await router.settle();
    expect(store.state.pendingProposals[0]!.status).toBe("executed");
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it("an answer arriving after TTL expiry is a no-op", async () => {
    let answer!: (approved: boolean) => void;
    const { router, store, broker } = setup("confirm", true, {
      ask: () => new Promise<boolean>((res) => (answer = res)),
    });
    await router.route(
      makeProposal({ suggestedShares: 0.25, expiresAt: new Date(Date.now() + 50).toISOString() }),
    );
    await new Promise((r) => setTimeout(r, 60));
    store.expireStaleProposals(); // the engine loop expires it
    answer(true); // the stale click lands afterwards
    await router.settle();
    expect(store.state.pendingProposals[0]!.status).toBe("expired");
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it("auto mode executes within caps and records refusals beyond them", async () => {
    const { router, store, broker } = setup("auto");
    await router.route(makeProposal({ symbol: "NVDA", suggestedShares: 0.25 }));
    expect(store.state.pendingProposals[0]!.status).toBe("executed");

    // Second proposal for another symbol breaching maxSharesPerOrder → refused.
    const { router: router2, store: store2, broker: broker2 } = setup("auto");
    await router2.route(makeProposal({ symbol: "NVDA", suggestedShares: 999 }));
    expect(store2.state.pendingProposals[0]!.status).toBe("refused");
    expect(await broker2.getPositions()).toHaveLength(0);
    expect(await broker.getPositions()).toHaveLength(1);
  });
});

describe("rejection cooldown", () => {
  function rejectedAt(store: ReturnType<typeof newStore>, symbol: string, action: "buy" | "sell", agoMs: number) {
    store.state.pendingProposals.push({
      proposal: makeProposal({ symbol, action }),
      status: "rejected",
      resolvedAt: new Date(Date.now() - agoMs).toISOString(),
      resolution: "rejected",
    });
  }

  it("suppresses a buy re-proposal inside the entry cooldown window", async () => {
    const { router, store } = setup("off");
    rejectedAt(store, "NVDA", "buy", 60_000); // rejected 1 min ago; default cooldown 30 min
    await router.route(makeProposal({ symbol: "NVDA", action: "buy" }));
    expect(store.state.pendingProposals.filter((p) => p.status === "open")).toHaveLength(0);
  });

  it("allows the buy again once the window has passed", async () => {
    const { router, store } = setup("off");
    rejectedAt(store, "NVDA", "buy", 31 * 60_000);
    await router.route(makeProposal({ symbol: "NVDA", action: "buy" }));
    expect(store.state.pendingProposals.filter((p) => p.status === "open")).toHaveLength(1);
  });

  it("null disables the entry cooldown", async () => {
    const settings = makeSettings({ execution: "off", entry: { rejectionCooldownMinutes: null } });
    const store = newStore();
    const quotes = new MockQuoteProvider({ NVDA: 100 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    const gate = new ExecutionGate(settings, broker, quotes, newAudit());
    const router = new ProposalRouter(settings, store, gate, new Narrator("claude-opus-4-8"), newAudit(), {
      ask: async () => true,
    });
    rejectedAt(store, "NVDA", "buy", 1_000);
    await router.route(makeProposal({ symbol: "NVDA", action: "buy" }));
    expect(store.state.pendingProposals.filter((p) => p.status === "open")).toHaveLength(1);
  });

  it("a rejected buy never cools down a sell (action-matched)", async () => {
    const { router, store } = setup("off");
    rejectedAt(store, "NVDA", "buy", 60_000);
    await router.route(makeProposal({ symbol: "NVDA", action: "sell", direction: "bearish" }));
    expect(store.state.pendingProposals.filter((p) => p.status === "open")).toHaveLength(1);
  });

  it("exit cooldown defaults OFF: a rejected sell re-asks immediately", async () => {
    const { router, store } = setup("off");
    rejectedAt(store, "HOOD", "sell", 1_000);
    await router.route(makeProposal({ symbol: "HOOD", action: "sell", direction: "bearish" }));
    expect(store.state.pendingProposals.filter((p) => p.status === "open")).toHaveLength(1);
  });

  it("exit cooldown suppresses rejected sells when the user opts in", async () => {
    const settings = makeSettings({ execution: "off", exit: { rejectionCooldownMinutes: 30 } });
    const store = newStore();
    const quotes = new MockQuoteProvider({ HOOD: 70 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    const gate = new ExecutionGate(settings, broker, quotes, newAudit());
    const router = new ProposalRouter(settings, store, gate, new Narrator("claude-opus-4-8"), newAudit(), {
      ask: async () => true,
    });
    rejectedAt(store, "HOOD", "sell", 60_000);
    await router.route(makeProposal({ symbol: "HOOD", action: "sell", direction: "bearish" }));
    expect(store.state.pendingProposals.filter((p) => p.status === "open")).toHaveLength(0);
  });

  it("the latest rejection wins and expired/executed entries are ignored", () => {
    const store = newStore();
    const older = makeProposal({ symbol: "NVDA", action: "buy" });
    const newer = makeProposal({ symbol: "NVDA", action: "buy" });
    store.state.pendingProposals.push(
      { proposal: older, status: "rejected", resolvedAt: new Date(Date.now() - 120_000).toISOString() },
      { proposal: newer, status: "rejected", resolvedAt: new Date(Date.now() - 60_000).toISOString() },
      { proposal: makeProposal({ symbol: "NVDA", action: "buy" }), status: "expired", resolvedAt: new Date().toISOString() },
      { proposal: makeProposal({ symbol: "NVDA", action: "buy" }), status: "executed", resolvedAt: new Date().toISOString() },
    );
    expect(store.lastRejectionFor("NVDA", "buy")?.proposal.id).toBe(newer.id);
    expect(store.lastRejectionFor("NVDA", "sell")).toBeUndefined();
  });
});
