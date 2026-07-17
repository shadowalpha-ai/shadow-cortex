/**
 * RobinhoodBroker mapping tests (experimental adapter).
 *
 * sample-payloads.json now holds REAL captured payloads (2026-07-15, scrubbed)
 * for the read tools, so these tests pin the verified realities: the
 * {data, guide} response envelope, agentic-account discovery via get_accounts,
 * required account_number scoping, string numerics, the positions↔quotes join
 * (position rows carry no price), and nested buying_power. Write-tool response
 * shapes are still best-guess — those tests pin our defensive handling.
 */

import { describe, expect, it } from "vitest";
import { RobinhoodBroker, RobinhoodError } from "../src/execution/robinhood-broker.js";
import { FixtureMcpClient, type McpToolClient } from "../src/sources/mcp-client.js";

const FIXTURE = new URL("../experimental/robinhood-mcp/sample-payloads.json", import.meta.url)
  .pathname;
const CONFIG = { refuseOnReviewWarning: true };

const ACCOUNTS = {
  data: {
    accounts: [
      { account_number: "MAIN0001", is_default: true, agentic_allowed: false, state: "active" },
      { account_number: "AGENTIC001", nickname: "Agentic", agentic_allowed: true, state: "active" },
    ],
  },
};

function fixtureBroker(): RobinhoodBroker {
  return new RobinhoodBroker(new FixtureMcpClient(FIXTURE), CONFIG);
}

describe("RobinhoodBroker account resolution (containment)", () => {
  it("discovers the agentic-enabled account from get_accounts", async () => {
    expect(await fixtureBroker().accountNumber()).toBe("AGENTIC001");
  });

  it("fails closed when no agentic account is accessible", async () => {
    const mcp: McpToolClient = {
      callTool: async () => ({
        data: { accounts: [{ account_number: "MAIN0001", agentic_allowed: false, state: "active" }] },
      }),
    };
    await expect(new RobinhoodBroker(mcp, CONFIG).accountNumber()).rejects.toThrow(RobinhoodError);
  });

  it("skips inactive/deactivated agentic accounts", async () => {
    const mcp: McpToolClient = {
      callTool: async () => ({
        data: {
          accounts: [
            { account_number: "OLD001", agentic_allowed: true, state: "active", deactivated: true },
            { account_number: "AGENTIC002", agentic_allowed: true, state: "active" },
          ],
        },
      }),
    };
    expect(await new RobinhoodBroker(mcp, CONFIG).accountNumber()).toBe("AGENTIC002");
  });

  it("honors an explicitly pinned account without calling get_accounts", async () => {
    const calls: string[] = [];
    const mcp: McpToolClient = {
      callTool: async (name) => {
        calls.push(name);
        return {};
      },
    };
    const broker = new RobinhoodBroker(mcp, { ...CONFIG, accountNumber: "PINNED01" });
    expect(await broker.accountNumber()).toBe("PINNED01");
    expect(calls).toHaveLength(0);
  });
});

describe("RobinhoodBroker reads (the Hybrid position feed)", () => {
  it("maps positions from the {data} envelope, joining prices from a batched quote call", async () => {
    const positions = await fixtureBroker().getPositions();
    expect(positions).toHaveLength(1);
    const nvda = positions[0]!;
    expect(nvda.symbol).toBe("NVDA");
    expect(nvda.shares).toBe(0.25); // fractional, coerced from "0.25"
    expect(nvda.costBasis).toBe(200); // from "200.00"
    // freshest print wins: extended-hours 211.57 (07-15) beats regular 211.79 (07-14)
    expect(nvda.currentPrice).toBe(211.57);
  });

  it("scopes position reads to the agentic account and batches one quote call", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
    const mcp: McpToolClient = {
      callTool: async (name, args) => {
        seen.push({ name, args });
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "get_equity_positions") {
          return {
            data: {
              positions: [
                { symbol: "NVDA", quantity: "1", average_buy_price: "180" },
                { symbol: "PLTR", quantity: "2", average_buy_price: "120" },
              ],
            },
          };
        }
        if (name === "get_equity_quotes") {
          return {
            data: {
              results: [
                { quote: { symbol: "NVDA", last_trade_price: "205.00" } },
                { quote: { symbol: "PLTR", last_trade_price: "130.00" } },
              ],
            },
          };
        }
        return {};
      },
    };
    const positions = await new RobinhoodBroker(mcp, CONFIG).getPositions();
    expect(positions).toHaveLength(2);
    const posCall = seen.find((s) => s.name === "get_equity_positions");
    expect(posCall?.args?.account_number).toBe("AGENTIC001");
    const quoteCalls = seen.filter((s) => s.name === "get_equity_quotes");
    expect(quoteCalls).toHaveLength(1); // one batched call, not per-position
    expect(quoteCalls[0]!.args?.symbols).toEqual(["NVDA", "PLTR"]);
  });

  it("maps the portfolio: nested buying_power is cash, total_value is equity", async () => {
    const account = await fixtureBroker().getAccount();
    expect(account).toEqual({ cash: 50, equity: 50 }); // "50.0000" / "50.00" coerced
  });

  it("skips rows missing symbol/quantity and rows with no quote (fail closed)", async () => {
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "get_equity_positions") {
          return {
            data: {
              positions: [
                { symbol: "NVDA", quantity: "0", average_buy_price: "1" }, // zero qty
                { symbol: null, quantity: "1", average_buy_price: "1" },
                { symbol: "AAPL", quantity: "abc", average_buy_price: "1" }, // NaN qty
                { symbol: "MSFT", quantity: "1", average_buy_price: "1" }, // no quote below
              ],
            },
          };
        }
        if (name === "get_equity_quotes") return { data: { results: [] } };
        return {};
      },
    };
    expect(await new RobinhoodBroker(mcp, CONFIG).getPositions()).toHaveLength(0);
  });

  it("uses current price as provisional cost basis while a position reconciles", async () => {
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "get_equity_positions") {
          // average_buy_price omitted — per the tool guide, still-reconciling rows do this
          return { data: { positions: [{ symbol: "NVDA", quantity: "1" }] } };
        }
        if (name === "get_equity_quotes") {
          return { data: { results: [{ quote: { symbol: "NVDA", last_trade_price: "205.00" } }] } };
        }
        return {};
      },
    };
    const positions = await new RobinhoodBroker(mcp, CONFIG).getPositions();
    expect(positions[0]!.costBasis).toBe(205);
  });

  it("picks the regular-session print when it is the fresher one", async () => {
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "get_equity_quotes") {
          return {
            data: {
              results: [
                {
                  quote: {
                    symbol: "NVDA",
                    last_trade_price: "210.00",
                    venue_last_trade_time: "2026-07-15T19:59:59Z",
                    last_non_reg_trade_price: "205.00",
                    venue_last_non_reg_trade_time: "2026-07-15T12:00:00Z",
                  },
                },
              ],
            },
          };
        }
        return {};
      },
    };
    const prices = await new RobinhoodBroker(mcp, CONFIG).getQuotes(["NVDA"]);
    expect(prices.get("NVDA")).toBe(210);
  });
});

describe("RobinhoodBroker writes (review-before-place, contained)", () => {
  it("reviews then places, confined to the discovered agentic account", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
    const mcp: McpToolClient = {
      callTool: async (name, args) => {
        seen.push({ name, args });
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "review_equity_order") return { review_id: "rev1", warnings: [] };
        if (name === "place_equity_order") {
          return { state: "filled", average_price: "211.80", cumulative_quantity: "0.5" };
        }
        return {};
      },
    };
    const result = await new RobinhoodBroker(mcp, CONFIG).placeOrder({
      symbol: "NVDA",
      action: "buy",
      shares: 0.5,
    });
    const orderCalls = seen.filter((s) => s.name !== "get_accounts");
    expect(orderCalls.map((s) => s.name)).toEqual(["review_equity_order", "place_equity_order"]);
    // every order call is confined to the agentic account, quantity as string
    expect(orderCalls.every((s) => s.args?.account_number === "AGENTIC001")).toBe(true);
    expect(orderCalls.every((s) => s.args?.quantity === "0.5")).toBe(true);
    // the review token is echoed into the place call
    expect(orderCalls[1]!.args?.review_id).toBe("rev1");
    expect(result.filledShares).toBe(0.5);
    expect(result.fillPrice).toBe(211.8);
  });

  it("refuses to place when the review reports a warning (refuse-by-default)", async () => {
    let placed = false;
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "review_equity_order") return { warnings: ["insufficient buying power"] };
        if (name === "place_equity_order") {
          placed = true;
          return {};
        }
        return {};
      },
    };
    await expect(
      new RobinhoodBroker(mcp, CONFIG).placeOrder({ symbol: "NVDA", action: "buy", shares: 1 }),
    ).rejects.toThrow(RobinhoodError);
    expect(placed).toBe(false);
  });

  it("catches warnings nested under the {data} envelope too", async () => {
    let placed = false;
    const mcp: McpToolClient = {
      callTool: async (name) => {
        if (name === "get_accounts") return ACCOUNTS;
        if (name === "review_equity_order") return { data: { warnings: ["market closed"] } };
        if (name === "place_equity_order") {
          placed = true;
          return {};
        }
        return {};
      },
    };
    await expect(
      new RobinhoodBroker(mcp, CONFIG).placeOrder({ symbol: "NVDA", action: "buy", shares: 1 }),
    ).rejects.toThrow(RobinhoodError);
    expect(placed).toBe(false);
  });
});
