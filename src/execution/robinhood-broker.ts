/**
 * RobinhoodBroker — live broker adapter for the official Robinhood
 * agentic-trading MCP (https://agent.robinhood.com/mcp/trading).
 *
 * ┌─ STATUS: READ MAPPINGS VERIFIED, WRITE MAPPINGS PROVISIONAL ────────────┐
 * │ Read-tool shapes (get_accounts, get_portfolio, get_equity_positions,     │
 * │ get_equity_quotes, get_equity_orders) were captured LIVE on 2026-07-15   │
 * │ against a funded agentic account — see sample-payloads.json and          │
 * │ docs/robinhood-discovery.md. Verified realities this adapter encodes:    │
 * │   • every response is wrapped `{data: {...}, guide: "..."}`              │
 * │   • every account-scoped tool REQUIRES `account_number`                  │
 * │   • numerics arrive as strings ("12.3400")                               │
 * │   • position rows carry NO market price — join with get_equity_quotes    │
 * │   • buying power is nested: data.buying_power.buying_power               │
 * │ review/place_equity_order RESPONSE shapes are still unverified (write    │
 * │ tools) — their handling stays defensive and is marked below.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WORKFLOW: Hybrid (engine reads, you approve writes). The engine reads your
 * real positions/account through this adapter so the management loop can run
 * programmatic exits against what you actually hold. Order placement is gated
 * by execution mode — in "confirm" mode `placeOrder` fires only after you
 * approve a proposal in the dashboard; in "auto" it fires within your caps.
 *
 * CONTAINMENT: writes target the dedicated, user-funded *agentic account*
 * only. Robinhood enforces this too — `get_accounts` marks exactly which
 * accounts are agentic-enabled for THIS agent (`agentic_allowed` is
 * caller-relative), and the adapter resolves that account itself rather than
 * trusting configuration. Never widen this. review_equity_order runs before
 * every place_equity_order and a review that reports a block/warning refuses
 * the order (refuse-by-default).
 */

import { num, unwrap } from "./robinhood-shared.js";
import type {
  Broker,
  BrokerPosition,
  OrderRequest,
  OrderResult,
} from "../core/types.js";
import type { McpToolClient } from "../sources/mcp-client.js";

export class RobinhoodError extends Error {}

interface RobinhoodConfig {
  /**
   * Pin the agentic account explicitly. Usually omit: the adapter discovers
   * the (single) agentic-enabled account via get_accounts. If set, it must
   * still be agentic-enabled or every write is refused upstream by Robinhood.
   */
  accountNumber?: string;
  /** Refuse to place if review_equity_order surfaces any warning (default true). */
  refuseOnReviewWarning: boolean;
}

export class RobinhoodBroker implements Broker {
  readonly name = "robinhood";
  private resolvedAccount: string | null = null;

  constructor(
    private readonly mcp: McpToolClient,
    private readonly config: RobinhoodConfig,
  ) {
    this.resolvedAccount = config.accountNumber ?? null;
  }

  /**
   * The account every call is scoped to. Discovered once from get_accounts:
   * the active account with agentic_allowed=true (caller-relative — the only
   * account Robinhood lets this agent act on). Fails closed if none exists.
   */
  async accountNumber(): Promise<string> {
    if (this.resolvedAccount) return this.resolvedAccount;
    const raw = unwrap(await this.mcp.callTool("get_accounts", {})) as {
      accounts?: RawAccount[];
    };
    const agentic = (raw?.accounts ?? []).find(
      (a) => a.agentic_allowed === true && a.state === "active" && !a.deactivated,
    );
    if (!agentic?.account_number) {
      throw new RobinhoodError(
        "No agentic-enabled Robinhood account is accessible to this agent. " +
          "Create and fund one in the Robinhood app (Investing → Agentic trading); " +
          "the engine only ever touches that dedicated account.",
      );
    }
    this.resolvedAccount = agentic.account_number;
    return this.resolvedAccount;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const account = await this.accountNumber();
    const raw = unwrap(
      await this.mcp.callTool("get_equity_positions", { account_number: account }),
    ) as { positions?: RawPosition[] };
    const rows = raw?.positions ?? [];
    if (rows.length === 0) return [];

    // Position rows carry no market price — one batched quote call covers all.
    const symbols = [
      ...new Set(
        rows
          .map((r) => (typeof r.symbol === "string" ? r.symbol.toUpperCase() : null))
          .filter((s): s is string => s !== null),
      ),
    ];
    const prices = await this.getQuotes(symbols);

    const out: BrokerPosition[] = [];
    for (const row of rows) {
      const mapped = mapPosition(row, prices);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  async getAccount(): Promise<{ cash: number; equity: number }> {
    const account = await this.accountNumber();
    const raw = unwrap(
      await this.mcp.callTool("get_portfolio", { account_number: account }),
    ) as RawPortfolio;
    return mapPortfolio(raw);
  }

  /** Batched live quotes; the freshest of regular/extended-hours trade prints. */
  async getQuotes(symbols: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (symbols.length === 0) return prices;
    const raw = unwrap(await this.mcp.callTool("get_equity_quotes", { symbols })) as {
      results?: RawQuoteResult[];
    };
    for (const entry of raw?.results ?? []) {
      const quote = entry?.quote;
      const symbol = typeof quote?.symbol === "string" ? quote.symbol.toUpperCase() : null;
      const price = quotePrice(quote);
      if (symbol && price !== null) prices.set(symbol, price);
    }
    return prices;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const account = await this.accountNumber();

    // 1. Preview first — this is the pre-trade safety surface.
    const review = (await this.mcp.callTool("review_equity_order", {
      account_number: account,
      symbol: order.symbol,
      side: order.action,
      // quantity is a string in the MCP schema; fractional shares are supported.
      quantity: String(order.shares),
      type: "market",
    })) as RawReview;

    const warnings = reviewWarnings(review);
    if (this.config.refuseOnReviewWarning && warnings.length > 0) {
      throw new RobinhoodError(
        `Robinhood review flagged ${order.action} ${order.symbol}: ${warnings.join("; ")} — refusing (refuse-by-default).`,
      );
    }

    // 2. Place into the agentic account only.
    const placed = (await this.mcp.callTool("place_equity_order", {
      account_number: account,
      symbol: order.symbol,
      side: order.action,
      quantity: String(order.shares),
      type: "market",
      ...reviewToken(review),
    })) as RawOrder;

    return mapOrder(order, unwrap(placed) as RawOrder);
  }
}

// --- raw upstream shapes ---
// Read shapes CAPTURED 2026-07-15 (sample-payloads.json). Write shapes
// (RawReview/RawOrder) remain best-guess until a real order is captured.

interface RawAccount {
  account_number?: string;
  nickname?: string;
  agentic_allowed?: boolean;
  state?: string;
  deactivated?: boolean;
}
interface RawPosition {
  symbol?: string;
  quantity?: number | string | null;
  average_buy_price?: number | string | null;
  created_at?: string | null;
}
interface RawPortfolio {
  total_value?: number | string | null;
  cash?: number | string | null;
  buying_power?: { buying_power?: number | string | null } | null;
}
interface RawQuote {
  symbol?: string;
  last_trade_price?: number | string | null;
  venue_last_trade_time?: string | null;
  last_non_reg_trade_price?: number | string | null;
  venue_last_non_reg_trade_time?: string | null;
}
interface RawQuoteResult {
  quote?: RawQuote;
}
interface RawReview {
  review_id?: string;
  warnings?: unknown;
  alert?: unknown;
  data?: { warnings?: unknown; alerts?: unknown; review_id?: string };
}
interface RawOrder {
  state?: string;
  average_price?: number | string | null;
  cumulative_quantity?: number | string | null;
  updated_at?: string | null;
}


// --- VERIFIED MAPPINGS (against 2026-07-15 captures) ---

function mapPosition(row: RawPosition, prices: Map<string, number>): BrokerPosition | null {
  const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : null;
  const shares = num(row.quantity);
  if (!symbol || shares === null || shares <= 0) return null;

  const currentPrice = prices.get(symbol);
  if (currentPrice === undefined) return null;

  // average_buy_price may be omitted while a position is still reconciling
  // (per the tool's own field guide). Falling back to the current price keeps
  // the position visible and makes basis-relative stops conservative (tighter)
  // rather than dropping stop protection entirely.
  const costBasis = num(row.average_buy_price) ?? currentPrice;

  return {
    symbol,
    shares,
    costBasis,
    currentPrice,
    openedAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
  };
}

function mapPortfolio(p: RawPortfolio): { cash: number; equity: number } {
  // buying_power.buying_power is the broker's authoritative spendable figure.
  const cash = num(p.buying_power?.buying_power) ?? num(p.cash);
  const equity = num(p.total_value) ?? cash;
  if (cash === null || equity === null) {
    // Never report $0 off an unusable payload — a transient bad read must
    // fail loudly, not masquerade as a wiped account (which would also
    // falsely trip the daily-loss halt).
    throw new RobinhoodError("get_portfolio returned no usable numbers — refusing (fail closed)");
  }
  return { cash, equity };
}

/** Freshest of the regular-session and extended-hours prints, by venue timestamp. */
function quotePrice(q: RawQuote | undefined): number | null {
  if (!q) return null;
  const reg = num(q.last_trade_price);
  const nonReg = num(q.last_non_reg_trade_price);
  if (reg !== null && nonReg !== null) {
    const regTs = Date.parse(q.venue_last_trade_time ?? "");
    const nonRegTs = Date.parse(q.venue_last_non_reg_trade_time ?? "");
    if (Number.isFinite(regTs) && Number.isFinite(nonRegTs)) {
      return nonRegTs > regTs ? nonReg : reg;
    }
  }
  return reg ?? nonReg;
}

// --- PROVISIONAL MAPPINGS (write-tool responses not yet captured) ---

function reviewWarnings(review: RawReview): string[] {
  const out: string[] = [];
  for (const source of [review.warnings, review.data?.warnings, review.data?.alerts]) {
    if (Array.isArray(source)) out.push(...source.map(String));
    else if (typeof source === "string" && source) out.push(source);
  }
  if (review.alert) out.push(String(review.alert));
  return out;
}

/** If review issues a token the place call must echo, pass it through. */
function reviewToken(review: RawReview): Record<string, unknown> {
  const id = review.review_id ?? review.data?.review_id;
  return id ? { review_id: id } : {};
}

function mapOrder(order: OrderRequest, placed: RawOrder): OrderResult {
  // A market order may report as filled or pending; the management loop
  // reconciles from getPositions regardless, so we report what we can.
  const filledShares = num(placed.cumulative_quantity) ?? order.shares;
  const fillPrice = num(placed.average_price) ?? 0;
  return {
    symbol: order.symbol.toUpperCase(),
    action: order.action,
    filledShares,
    fillPrice,
    filledAt: typeof placed.updated_at === "string" ? placed.updated_at : new Date().toISOString(),
  };
}
