import { describe, expect, it } from "vitest";
import { PaperBroker, OrderError } from "../src/execution/paper-broker.js";
import { MockQuoteProvider, makeSettings, newStore } from "./helpers.js";

function setup(prices: Record<string, number> = { NVDA: 100 }, paperOverrides = {}) {
  const settings = makeSettings({ paper: { startingCash: 1000, ...paperOverrides } });
  const store = newStore();
  const quotes = new MockQuoteProvider(prices);
  return { broker: new PaperBroker(store, quotes, settings.paper), quotes, store };
}

describe("paper broker", () => {
  it("fills a fractional buy and debits cash", async () => {
    const { broker } = setup();
    const result = await broker.placeOrder({ symbol: "NVDA", action: "buy", shares: 0.25 });
    expect(result.fillPrice).toBe(100);
    const account = await broker.getAccount();
    expect(account.cash).toBe(975);
    expect(account.equity).toBe(1000);
  });

  it("weights cost basis across multiple buys", async () => {
    const { broker, quotes } = setup();
    await broker.placeOrder({ symbol: "NVDA", action: "buy", shares: 1 });
    quotes.prices.NVDA = 110;
    await broker.placeOrder({ symbol: "NVDA", action: "buy", shares: 1 });
    const [position] = await broker.getPositions();
    expect(position!.costBasis).toBe(105);
    expect(position!.shares).toBe(2);
  });

  it("rejects a buy beyond available cash", async () => {
    const { broker } = setup();
    await expect(
      broker.placeOrder({ symbol: "NVDA", action: "buy", shares: 11 }),
    ).rejects.toThrow(OrderError);
  });

  it("is long-only: selling an unheld symbol is an error", async () => {
    const { broker } = setup();
    await expect(
      broker.placeOrder({ symbol: "NVDA", action: "sell", shares: 1 }),
    ).rejects.toThrow(/long-only/);
  });

  it("clamps a sell to the held quantity and books realized P&L", async () => {
    const { broker, quotes, store } = setup();
    await broker.placeOrder({ symbol: "NVDA", action: "buy", shares: 2 });
    quotes.prices.NVDA = 110;
    const result = await broker.placeOrder({ symbol: "NVDA", action: "sell", shares: 5 });
    expect(result.filledShares).toBe(2); // clamped — an exit never over-sells
    expect(store.state.paper!.realizedToday).toBe(20);
    expect(await broker.getPositions()).toHaveLength(0);
    const account = await broker.getAccount();
    expect(account.cash).toBe(1020);
  });

  it("persists its book in the state store across restarts", async () => {
    const settings = makeSettings({ paper: { startingCash: 1000 } });
    const store = newStore();
    const quotes = new MockQuoteProvider({ NVDA: 100 });
    const broker = new PaperBroker(store, quotes, settings.paper);
    await broker.placeOrder({ symbol: "NVDA", action: "buy", shares: 1 });
    store.save();

    const reborn = new PaperBroker(store, quotes, settings.paper);
    const positions = await reborn.getPositions();
    expect(positions[0]!.shares).toBe(1);
  });

  it("seeds positions from the profile on first run only", async () => {
    const { broker } = setup(
      { HOOD: 70 },
      {
        seedPositions: [
          { symbol: "HOOD", shares: 10, costBasis: 68, openedAt: "2026-07-10T14:30:00Z" },
        ],
      },
    );
    const positions = await broker.getPositions();
    expect(positions[0]).toMatchObject({ symbol: "HOOD", shares: 10, costBasis: 68 });
  });
});
