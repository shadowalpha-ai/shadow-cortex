/**
 * ShadowAlpha portfolio source tests — pinned against the live tool shapes
 * captured 2026-07-15 (list_portfolios + get_portfolio_signals).
 */

import { describe, expect, it } from "vitest";
import {
  ShadowAlphaPortfolioSource,
  portfolioFieldCatalog,
} from "../src/sources/shadowalpha-portfolio.js";
import { FixtureMcpClient, type McpToolClient } from "../src/sources/mcp-client.js";

const FIXTURE = new URL("../fixtures/portfolio-signals.json", import.meta.url).pathname;

function fixtureSource(portfolios: string[] = ["Momentum"]): ShadowAlphaPortfolioSource {
  return new ShadowAlphaPortfolioSource(new FixtureMcpClient(FIXTURE), {
    portfolios,
    listRefreshMinutes: 15,
  });
}

describe("normalization", () => {
  it("maps entries to bullish curation signals and exits to bearish, skipping non-equities", async () => {
    const signals = await fixtureSource().poll();
    // Fixture: NVDA + PLTR entries, BTC-USD (skipped), TSLA option leg (skipped), HOOD exit.
    expect(signals.map((s) => `${s.symbol}:${s.direction}`)).toEqual([
      "NVDA:bullish",
      "PLTR:bullish",
      "HOOD:bearish",
    ]);
    const nvda = signals[0]!;
    expect(nvda.type).toBe("curation");
    expect(nvda.source).toBe("shadowalpha-portfolio");
    expect(nvda.strength).toBe(0.8);
    expect(nvda.dedupeKey).toBe("shadowalpha-portfolio:entry:41");
    expect(nvda.fields.portfolioName).toBe("Momentum");
    expect(nvda.fields.portfolioId).toBe(12);
    expect(nvda.fields.entryPrice).toBe(186.2);
    expect(nvda.fields.upstreamStatus).toBe("open");
    expect(nvda.fields.portfolioWinRatePct).toBe(63.2);
    expect(nvda.fields.portfolioReturnPct).toBe(24.8);
    const exit = signals[2]!;
    expect(exit.dedupeKey).toBe("shadowalpha-portfolio:exit:39");
    expect(exit.fields.upstreamStatus).toBe("closed");
  });

  it("publishes only declared fields (catalog honesty)", async () => {
    const declared = new Set(portfolioFieldCatalog(["Momentum"]).map((f) => f.name));
    for (const signal of await fixtureSource().poll()) {
      for (const key of Object.keys(signal.fields)) {
        expect(declared.has(key), `undeclared field ${key}`).toBe(true);
      }
    }
  });

  it("exposes configured portfolios as the portfolioName enumeration", () => {
    const catalog = fixtureSource(["Momentum", "Steady Growth"]).fieldCatalog;
    const nameField = catalog.find((f) => f.name === "portfolioName")!;
    expect(nameField.values).toEqual(["Momentum", "Steady Growth"]);
  });

  it("maps analyst shorts by their own direction and skips short-covers", async () => {
    // Real regression: a live curation SHORT entry was once emitted as
    // bullish — a buy signal for a stock the analyst was shorting.
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "list_portfolios") return { portfolios: [] };
        return {
          portfolio: { id: 1, name: "Momentum" },
          new_entries: [
            { id: 61, symbol: "AI", direction: "bullish" },
            { id: 62, symbol: "ASTS", direction: "bearish" }, // analyst short
            { id: 63, symbol: "ADBE" }, // direction absent → bullish (older payloads)
          ],
          new_exits: [
            { id: 58, symbol: "BABA", direction: "bullish" }, // long closed → advisory
            { id: 59, symbol: "GME", direction: "bearish" }, // short covered → no action
          ],
        };
      },
    };
    const source = new ShadowAlphaPortfolioSource(mcp, { portfolios: ["X"], listRefreshMinutes: 15 });
    const signals = await source.poll();
    expect(signals.map((s) => `${s.symbol}:${s.direction}`)).toEqual([
      "AI:bullish",
      "ASTS:bearish",
      "ADBE:bullish",
      "BABA:bearish",
    ]);
  });

  it("skips rows without an id and never throws on malformed rows", async () => {
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "list_portfolios") return { portfolios: [] };
        return {
          new_entries: [
            { symbol: "NVDA", direction: "bullish" }, // no id
            { id: 7, symbol: null }, // no symbol
            { id: 8, symbol: "MSFT", entry_price: "abc" }, // bad numerics still map
          ],
          new_exits: [],
        };
      },
    };
    const source = new ShadowAlphaPortfolioSource(mcp, { portfolios: ["X"], listRefreshMinutes: 15 });
    const signals = await source.poll();
    expect(signals.map((s) => s.symbol)).toEqual(["MSFT"]);
    expect(signals[0]!.fields.entryPrice).toBeUndefined();
  });
});

describe("cursors", () => {
  function trackingMcp(latestTradeId: number | undefined) {
    const calls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
    const mcp: McpToolClient = {
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "list_portfolios") {
          if (latestTradeId === undefined) throw new Error("listing down");
          return {
            portfolios: [{ id: 12, name: "Momentum", status: "active", latest_trade_id: latestTradeId }],
          };
        }
        return {
          portfolio: { id: 12, name: "Momentum" },
          new_entries: [],
          new_exits: [],
          cursors: { last_id: 50, last_exit_date: "2026-07-15T15:00:00Z" },
        };
      },
    };
    return { mcp, calls };
  }

  it("seeds after_id from latest_trade_id, then advances from response cursors", async () => {
    const { mcp, calls } = trackingMcp(40);
    const source = new ShadowAlphaPortfolioSource(mcp, { portfolios: ["Momentum"], listRefreshMinutes: 15 });
    await source.poll();
    const first = calls.find((c) => c.name === "get_portfolio_signals");
    expect(first?.args?.after_id).toBe(40); // seeded, not 0
    await source.poll();
    const second = calls.filter((c) => c.name === "get_portfolio_signals")[1];
    expect(second?.args?.after_id).toBe(50); // advanced from cursors.last_id
    expect(second?.args?.exited_after).toBe("2026-07-15T15:00:00Z");
  });

  it("falls back to after_id 0 when the listing is unavailable", async () => {
    const { mcp, calls } = trackingMcp(undefined);
    const source = new ShadowAlphaPortfolioSource(mcp, { portfolios: ["Momentum"], listRefreshMinutes: 15 });
    await source.poll();
    const first = calls.find((c) => c.name === "get_portfolio_signals");
    expect(first?.args?.after_id).toBe(0);
  });

  it("never moves a cursor backward on a malformed payload", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    let malformed = false;
    const mcp: McpToolClient = {
      callTool: async (name, args) => {
        if (name === "list_portfolios") {
          return { portfolios: [{ id: 12, name: "Momentum", latest_trade_id: 40 }] };
        }
        calls.push(args);
        return malformed
          ? { new_entries: [], new_exits: [], cursors: { last_id: 3 } } // stale/bogus
          : { new_entries: [], new_exits: [], cursors: { last_id: 50 } };
      },
    };
    const source = new ShadowAlphaPortfolioSource(mcp, { portfolios: ["Momentum"], listRefreshMinutes: 15 });
    await source.poll(); // → 50
    malformed = true;
    await source.poll(); // upstream says 3 — ignore
    await source.poll();
    expect(calls[2]?.after_id).toBe(50);
  });

  it("one portfolio failing does not sink the poll", async () => {
    const mcp: McpToolClient = {
      callTool: async (name, args) => {
        if (name === "list_portfolios") return { portfolios: [] };
        if ((args as { portfolio?: string })?.portfolio === "Broken") throw new Error("boom");
        return {
          portfolio: { id: 1, name: "Good" },
          new_entries: [{ id: 5, symbol: "NVDA", direction: "bullish" }],
          new_exits: [],
        };
      },
    };
    const source = new ShadowAlphaPortfolioSource(mcp, {
      portfolios: ["Broken", "Good"],
      listRefreshMinutes: 15,
    });
    const signals = await source.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.symbol).toBe("NVDA");
  });
});

describe("listPortfolios", () => {
  it("serves the fixture listing (feeds /api/portfolios)", async () => {
    const listing = await fixtureSource().listPortfolios();
    expect(listing.map((p) => p.name)).toEqual(["Momentum", "Paused Experiments"]);
    expect(listing[0]!.performance?.win_rate_pct).toBe(63.2);
  });
});
