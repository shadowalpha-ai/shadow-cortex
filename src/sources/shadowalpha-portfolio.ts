/**
 * ShadowAlpha portfolio adapter (poller) — trade on a specific curation.
 * Follows one or more of your ShadowAlpha portfolios: when the upstream
 * portfolio engine opens a long, that entry becomes a bullish signal here;
 * when it closes one, a bearish (advisory) signal. Analyst shorts map by
 * their own direction (bearish — never a buy) and short-covers are skipped.
 *
 * NORMALIZATION ASSUMPTIONS (sanity-check without reading the code):
 * - LONG-ONLY US EQUITIES v1: option legs (`option_type` set) and non-equity
 *   symbols (`BTC-USD`, `XAU-USD`, `CL=F` — anything failing /^[A-Z]{1,5}$/)
 *   are skipped with a log line, never guessed. Pure-alpha index tickers
 *   (e.g. SPX) slip past that filter and are backstopped by the quote
 *   provider / broker refusing them.
 * - new_entries → type "curation", direction FROM THE ROW (`direction`
 *   "bearish" = analyst short → bearish signal; anything else → bullish).
 *   new_exits of longs → bearish, which to the long-only rules decider means
 *   "don't buy / exit if held" — it never forces an exit. new_exits of
 *   shorts (row direction "bearish") are skipped: a covered short advises
 *   nothing for a long-only book.
 * - Strength is a documented constant 0.8: a curation actually entering a
 *   position is a high-conviction event, and the feed carries no per-trade
 *   confidence. No `confidence` is set (fail-closed for confidence rules).
 * - Dedupe: trade rows carry a stable upstream id — exact event identity
 *   beats time-bucketing (`shadowalpha-portfolio:entry:<id>` / `:exit:<id>`).
 *
 * CURSOR MODEL (per the upstream tool's own note): on the first poll each
 * portfolio's `after_id` is seeded from `latest_trade_id` in the
 * list_portfolios snapshot, so ONLY trades from now on become signals — no
 * historical re-ingest. Cursors advance from `cursors.last_id` /
 * `last_exit_date` and never move backward. They are in-memory only: after a
 * restart the seed is taken fresh, so entries fired while the engine was down
 * are skipped (documented trade-off; stable dedupe keys make any overlap
 * idempotent, and signalTtlMinutes ages out anything stale).
 *
 * RATE BUDGET (ShadowAlpha: 30 req/min): one get_portfolio_signals call per
 * configured portfolio per poll, plus a list_portfolios refresh every
 * `listRefreshMinutes`. A few portfolios at the default intake cadence is
 * comfortable; aggressive cadences multiply per-portfolio calls.
 */

import { normalizeTimestamp } from "../core/normalize.js";
import type { FieldDef, FieldValue, Signal, SignalSource } from "../core/types.js";
import { log } from "../core/log.js";
import type { McpToolClient } from "./mcp-client.js";

interface TradeRow {
  id?: number | string | null;
  symbol?: string | null;
  direction?: string | null;
  entry_price?: number | string | null;
  quantity?: number | string | null;
  entry_date?: string | null;
  exit_date?: string | null;
  status?: string | null;
  option_type?: string | null;
}

export interface PortfolioListing {
  id?: number | string | null;
  name?: string | null;
  status?: string | null;
  latest_trade_id?: number | null;
  performance?: {
    total_return_pct?: number | null;
    win_rate_pct?: number | null;
  } | null;
}

interface SignalsResponse {
  portfolio?: { id?: number | string; name?: string; status?: string };
  new_entries?: TradeRow[];
  new_exits?: TradeRow[];
  cursors?: { last_id?: number | null; last_exit_date?: string | null };
}

const SOURCE = "shadowalpha-portfolio";
const EQUITY_SYMBOL = /^[A-Z]{1,5}$/;
/** Documented constant: a curation entering a position is high-conviction. */
const CURATION_STRENGTH = 0.8;

/** Published on every signal; imported by the rule builder. */
export function portfolioFieldCatalog(portfolios: string[]): FieldDef[] {
  return [
    { name: "portfolioId", kind: "number", description: "Upstream id of the portfolio that traded" },
    {
      name: "portfolioName",
      kind: "string",
      description: "The portfolio/curation that traded",
      values: portfolios,
    },
    { name: "entryPrice", kind: "number", description: "Price at which the portfolio entered" },
    { name: "quantity", kind: "number", description: "Upstream position size (their units, not yours)" },
    {
      name: "upstreamStatus",
      kind: "string",
      description: "Trade status upstream when observed",
      values: ["open", "closed"],
    },
    { name: "portfolioWinRatePct", kind: "number", description: "The portfolio's closed-trade win rate % (absent while unknown). >= 60 keeps only strong track records.", defaultOp: ">=", defaultValue: 60 },
    { name: "portfolioReturnPct", kind: "number", description: "The portfolio's total return % since inception (absent while unknown).", defaultOp: ">=", defaultValue: 0 },
  ];
}

interface ShadowAlphaPortfolioConfig {
  /** Portfolio names or numeric ids (as strings) — which curations to follow. */
  portfolios: string[];
  listRefreshMinutes: number;
}

interface Cursor {
  afterId: number;
  exitedAfter: string | null;
  seeded: boolean;
}

export class ShadowAlphaPortfolioSource implements SignalSource {
  readonly name = SOURCE;
  readonly fieldCatalog: FieldDef[];

  private readonly cursors = new Map<string, Cursor>();
  /** Trade ids already logged as skipped — replayed rows shouldn't spam the log. */
  private readonly loggedSkips = new Set<string>();
  private listing: PortfolioListing[] = [];
  private listingFetchedAt = 0;

  constructor(
    private readonly mcp: McpToolClient,
    private readonly config: ShadowAlphaPortfolioConfig,
  ) {
    this.fieldCatalog = portfolioFieldCatalog(config.portfolios);
  }

  async poll(now: Date = new Date()): Promise<Signal[]> {
    await this.refreshListing(now);
    const signals: Signal[] = [];

    for (const portfolio of this.config.portfolios) {
      try {
        const cursor = this.cursorFor(portfolio);
        const args: Record<string, unknown> = {
          portfolio,
          after_id: cursor.afterId,
          limit: 50,
        };
        if (cursor.exitedAfter) args.exited_after = cursor.exitedAfter;
        const result = (await this.mcp.callTool("get_portfolio_signals", args)) as SignalsResponse;

        const meta = this.listingFor(portfolio, result);
        for (const row of result?.new_entries ?? []) {
          const signal = this.normalizeRow(row, meta, "entry");
          if (signal) signals.push(signal);
        }
        for (const row of result?.new_exits ?? []) {
          const signal = this.normalizeRow(row, meta, "exit");
          if (signal) signals.push(signal);
        }
        this.advanceCursor(cursor, result?.cursors, now);
      } catch (err) {
        // Fallible by contract: one portfolio failing must not sink the poll.
        log.error(`${SOURCE}: polling "${portfolio}" failed — continuing`, err);
      }
    }
    return signals;
  }

  /** The live portfolio list (also serves the dashboard's picker endpoint). */
  async listPortfolios(now: Date = new Date()): Promise<PortfolioListing[]> {
    await this.refreshListing(now);
    return this.listing;
  }

  // --- cursors ---

  private cursorFor(portfolio: string): Cursor {
    let cursor = this.cursors.get(portfolio);
    if (!cursor) {
      // Seed from latest_trade_id (per the upstream note) so only trades from
      // now on become signals. If the listing is unavailable, start at 0 and
      // let dedupe keys + signal TTL suppress the historical backlog.
      const listed = this.findListing(portfolio);
      cursor = {
        afterId: typeof listed?.latest_trade_id === "number" ? listed.latest_trade_id : 0,
        exitedAfter: null,
        seeded: listed !== undefined,
      };
      if (!cursor.seeded) {
        log.warn(
          `${SOURCE}: "${portfolio}" not in the portfolio listing — starting at after_id 0 (history suppressed by dedupe + TTL).`,
        );
      }
      this.cursors.set(portfolio, cursor);
    }
    return cursor;
  }

  private advanceCursor(
    cursor: Cursor,
    upstream: SignalsResponse["cursors"],
    now: Date,
  ): void {
    // Never move a cursor backward on a malformed payload.
    if (typeof upstream?.last_id === "number" && upstream.last_id > cursor.afterId) {
      cursor.afterId = upstream.last_id;
    }
    const exitDate = upstream?.last_exit_date;
    if (typeof exitDate === "string" && Number.isFinite(Date.parse(exitDate))) {
      if (!cursor.exitedAfter || Date.parse(exitDate) > Date.parse(cursor.exitedAfter)) {
        cursor.exitedAfter = exitDate;
      }
    } else if (!cursor.exitedAfter) {
      // First successful poll: only exits from now on are interesting.
      cursor.exitedAfter = now.toISOString();
    }
  }

  // --- portfolio listing (metadata + picker) ---

  private async refreshListing(now: Date): Promise<void> {
    const maxAgeMs = this.config.listRefreshMinutes * 60_000;
    if (this.listing.length > 0 && now.getTime() - this.listingFetchedAt < maxAgeMs) return;
    try {
      const result = (await this.mcp.callTool("list_portfolios", {})) as {
        portfolios?: PortfolioListing[];
      };
      if (Array.isArray(result?.portfolios) && result.portfolios.length > 0) {
        this.listing = result.portfolios;
        this.listingFetchedAt = now.getTime();
      }
    } catch (err) {
      log.error(`${SOURCE}: list_portfolios failed — continuing with last known listing`, err);
    }
  }

  private findListing(portfolio: string): PortfolioListing | undefined {
    return this.listing.find(
      (p) => String(p.id) === portfolio || (typeof p.name === "string" && p.name === portfolio),
    );
  }

  private listingFor(portfolio: string, result: SignalsResponse): PortfolioListing | undefined {
    // Prefer the response's own portfolio identity (resolves name↔id), then the listing.
    const fromResponse = result?.portfolio;
    const listed =
      this.listing.find((p) => fromResponse?.id !== undefined && String(p.id) === String(fromResponse.id)) ??
      this.findListing(portfolio);
    if (listed) return listed;
    return fromResponse ? { id: fromResponse.id, name: fromResponse.name } : undefined;
  }

  // --- normalization ---

  private normalizeRow(
    row: TradeRow,
    meta: PortfolioListing | undefined,
    kind: "entry" | "exit",
  ): Signal | null {
    if (row.id === undefined || row.id === null) return null;

    const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : null;
    if (!symbol) return null;
    if (row.option_type) {
      this.logSkipOnce(String(row.id), `skipping ${symbol} trade ${row.id} — option leg (long-only equities v1).`);
      return null;
    }
    if (!EQUITY_SYMBOL.test(symbol)) {
      this.logSkipOnce(String(row.id), `skipping "${symbol}" trade ${row.id} — not a US equity ticker.`);
      return null;
    }

    // The trade row's own direction decides what the signal means. An analyst
    // SHORT (bearish entry) must never become a buy — it maps to a bearish
    // signal, which the long-only decider treats as exit-advisory at most. A
    // covered short (bearish exit) advises nothing for a long-only book: skip.
    const tradeDirection = row.direction === "bearish" ? "bearish" : "bullish";
    let direction: "bullish" | "bearish";
    if (kind === "entry") {
      direction = tradeDirection;
    } else if (tradeDirection === "bearish") {
      this.logSkipOnce(
        `exit:${row.id}`,
        `skipping ${symbol} trade ${row.id} — closed a short; no action for a long-only book.`,
      );
      return null;
    } else {
      direction = "bearish";
    }
    const entryPrice = Number(row.entry_price);
    const quantity = Number(row.quantity);
    const timestamp =
      normalizeTimestamp(kind === "exit" ? (row.exit_date ?? row.entry_date) : row.entry_date) ??
      new Date().toISOString();

    const fields: Record<string, FieldValue> = {
      upstreamStatus: kind === "exit" ? "closed" : (row.status ?? "open"),
    };
    const portfolioId = Number(meta?.id);
    if (Number.isFinite(portfolioId)) fields.portfolioId = portfolioId;
    if (typeof meta?.name === "string") fields.portfolioName = meta.name;
    if (Number.isFinite(entryPrice) && entryPrice > 0) fields.entryPrice = entryPrice;
    if (Number.isFinite(quantity) && quantity > 0) fields.quantity = quantity;
    const winRate = meta?.performance?.win_rate_pct;
    if (typeof winRate === "number" && Number.isFinite(winRate)) fields.portfolioWinRatePct = winRate;
    const returnPct = meta?.performance?.total_return_pct;
    if (typeof returnPct === "number" && Number.isFinite(returnPct)) fields.portfolioReturnPct = returnPct;

    return {
      symbol,
      type: "curation",
      direction,
      strength: CURATION_STRENGTH,
      source: SOURCE,
      timestamp,
      fields,
      dedupeKey: `${SOURCE}:${kind}:${row.id}`,
      raw: row,
    };
  }

  private logSkipOnce(tradeId: string, message: string): void {
    if (this.loggedSkips.has(tradeId)) return;
    this.loggedSkips.add(tradeId);
    log.info(`${SOURCE}: ${message}`);
  }
}

