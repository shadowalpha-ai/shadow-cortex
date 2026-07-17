/**
 * PaperBroker — v1's only broker. Fills instantly at the quoted price, no
 * fees, long-only, fractional-capable. Its book persists in the engine state
 * file so paper positions survive restarts.
 *
 * The live Robinhood MCP adapter lives in ./robinhood-broker.ts and
 * implements this same Broker interface — execution swaps brokers, nothing
 * upstream changes.
 */

import type {
  Broker,
  BrokerPosition,
  OrderRequest,
  OrderResult,
  QuoteProvider,
} from "../core/types.js";
import { roundMoney, roundShares } from "../core/normalize.js";
import type { StateStore, PaperBook } from "../core/state.js";
import type { Settings } from "../settings/schema.js";

export class OrderError extends Error {}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class PaperBroker implements Broker {
  readonly name = "paper";

  constructor(
    private readonly store: StateStore,
    private readonly quotes: QuoteProvider,
    paperConfig: Settings["paper"],
  ) {
    if (!this.store.state.paper) {
      const positions: PaperBook["positions"] = {};
      for (const seed of paperConfig.seedPositions) {
        positions[seed.symbol.toUpperCase()] = {
          shares: seed.shares,
          costBasis: seed.costBasis,
          openedAt: seed.openedAt,
        };
      }
      this.store.state.paper = {
        cash: paperConfig.startingCash,
        positions,
        realizedToday: 0,
        realizedDate: today(),
      };
    }
  }

  private get book(): PaperBook {
    const book = this.store.state.paper;
    if (!book) throw new OrderError("Paper book not initialized");
    if (book.realizedDate !== today()) {
      book.realizedDate = today();
      book.realizedToday = 0;
    }
    return book;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const [symbol, pos] of Object.entries(this.book.positions)) {
      const quote = await this.quotes.getQuote(symbol);
      out.push({
        symbol,
        shares: pos.shares,
        costBasis: pos.costBasis,
        currentPrice: quote.price,
        openedAt: pos.openedAt,
      });
    }
    return out;
  }

  async getAccount(): Promise<{ cash: number; equity: number }> {
    let marketValue = 0;
    for (const p of await this.getPositions()) {
      marketValue += p.shares * p.currentPrice;
    }
    const cash = this.book.cash;
    return { cash: roundMoney(cash), equity: roundMoney(cash + marketValue) };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const symbol = order.symbol.toUpperCase();
    const quote = await this.quotes.getQuote(symbol);
    const book = this.book;

    if (order.shares <= 0) throw new OrderError(`Invalid share quantity: ${order.shares}`);

    if (order.action === "buy") {
      const cost = order.shares * quote.price;
      if (cost > book.cash + 1e-9) {
        throw new OrderError(
          `Insufficient paper cash: need $${roundMoney(cost)}, have $${roundMoney(book.cash)}`,
        );
      }
      book.cash = roundMoney(book.cash - cost);
      const existing = book.positions[symbol];
      if (existing) {
        const totalShares = roundShares(existing.shares + order.shares);
        existing.costBasis = roundMoney(
          (existing.shares * existing.costBasis + cost) / totalShares,
        );
        existing.shares = totalShares;
      } else {
        book.positions[symbol] = {
          shares: roundShares(order.shares),
          costBasis: roundMoney(quote.price),
          openedAt: new Date().toISOString(),
        };
      }
    } else {
      const held = book.positions[symbol];
      if (!held) throw new OrderError(`No paper position in ${symbol} to sell (long-only)`);
      // A sell never fails for asking slightly too much — clamp to what's held.
      const shares = roundShares(Math.min(order.shares, held.shares));
      const proceeds = shares * quote.price;
      book.cash = roundMoney(book.cash + proceeds);
      book.realizedToday = roundMoney(
        book.realizedToday + (quote.price - held.costBasis) * shares,
      );
      held.shares = roundShares(held.shares - shares);
      if (held.shares < 1e-6) delete book.positions[symbol];
      this.store.save();
      return {
        symbol,
        action: "sell",
        filledShares: shares,
        fillPrice: quote.price,
        filledAt: new Date().toISOString(),
      };
    }

    this.store.save();
    return {
      symbol,
      action: order.action,
      filledShares: roundShares(order.shares),
      fillPrice: quote.price,
      filledAt: new Date().toISOString(),
    };
  }
}
