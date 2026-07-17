/**
 * QuoteProvider implementations. The management loop cannot run stops without
 * prices, so REAL paper trading (as opposed to the fixture demo) requires a
 * live quote source.
 *
 * - fixture:      replayable per-symbol price series; powers the
 *                 zero-credential dev demo (advances one step per tick).
 * - shadowalpha:  live prices via the ShadowAlpha MCP `get_price` tool.
 * - broker:       the transactable broker price, through the live Robinhood
 *                 adapter's batched quote call. Requires mode "live" with a
 *                 connected liveBroker (validation refuses it otherwise).
 */

import { readFileSync } from "node:fs";
import type { Quote, QuoteProvider } from "../core/types.js";
import type { McpToolClient } from "../sources/mcp-client.js";

export class QuoteError extends Error {}

export class FixtureQuoteProvider implements QuoteProvider {
  readonly name = "fixture";
  private readonly series: Record<string, number[]>;
  private index = 0;

  constructor(fixturePath: string) {
    this.series = JSON.parse(readFileSync(fixturePath, "utf8"));
  }

  /** Called once per management tick so the replay moves through time. */
  advance(): void {
    this.index += 1;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const prices = this.series[symbol.toUpperCase()];
    if (!prices || prices.length === 0) {
      throw new QuoteError(`No fixture prices for ${symbol}`);
    }
    const price = prices[Math.min(this.index, prices.length - 1)]!;
    return { symbol: symbol.toUpperCase(), price, asOf: new Date().toISOString() };
  }
}

/** The one method BrokerQuoteProvider needs — RobinhoodBroker satisfies it. */
interface BatchQuoteBroker {
  getQuotes(symbols: string[]): Promise<Map<string, number>>;
}

/** The transactable price, straight from the live broker's quote feed. */
export class BrokerQuoteProvider implements QuoteProvider {
  readonly name = "broker";

  constructor(private readonly broker: BatchQuoteBroker) {}

  async getQuote(symbol: string): Promise<Quote> {
    const prices = await this.broker.getQuotes([symbol.toUpperCase()]);
    const price = prices.get(symbol.toUpperCase());
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new QuoteError(`Broker returned no usable price for ${symbol}`);
    }
    return { symbol: symbol.toUpperCase(), price, asOf: new Date().toISOString() };
  }
}

/** Live quotes from the ShadowAlpha MCP. Client is injected — testable offline. */
export class ShadowAlphaQuoteProvider implements QuoteProvider {
  readonly name = "shadowalpha";

  constructor(private readonly mcp: McpToolClient) {}

  async getQuote(symbol: string): Promise<Quote> {
    const result = (await this.mcp.callTool("get_price", { symbol })) as {
      symbol?: string;
      price?: number | string;
      as_of?: string;
    };
    const price = Number(result?.price);
    // Never trust upstream data: a null rendered as 0.0 must not become a price.
    if (!Number.isFinite(price) || price <= 0) {
      throw new QuoteError(`ShadowAlpha returned no usable price for ${symbol}`);
    }
    return {
      symbol: symbol.toUpperCase(),
      price,
      asOf: result?.as_of ?? new Date().toISOString(),
    };
  }
}
