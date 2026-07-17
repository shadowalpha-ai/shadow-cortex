/**
 * ATR (Average True Range) — the volatility measure behind ATR stops.
 *
 * True range per day = max(high − low, |high − prevClose|, |low − prevClose|);
 * ATR = the simple average of the last `period` true ranges. Candle shape
 * captured live from ShadowAlpha get_price (2026-07-16):
 *   { symbol, known, current_price, daily_candles:
 *     [{ date, open, high, low, close, volume }] }
 *
 * Providers are fallible-by-contract: no data → null → the ATR stop is
 * SKIPPED for that symbol with a once-per-symbol warning. Other stops keep
 * protecting; an unavailable ATR must never silently widen risk.
 */

import { readFileSync } from "node:fs";
import type { McpToolClient } from "../sources/mcp-client.js";
import { log } from "../core/log.js";

export interface Candle {
  high: number;
  low: number;
  close: number;
}

/** Classic Wilder-style ATR over the trailing `period` true ranges. */
export function computeAtr(candles: Candle[], period: number): number | null {
  if (candles.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const window = trs.slice(-period);
  if (window.length === 0) return null;
  const atr = window.reduce((a, b) => a + b, 0) / window.length;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export interface AtrProvider {
  readonly name: string;
  /** ATR for the symbol, or null when it can't be computed (stop is skipped). */
  getAtr(symbol: string, period: number): Promise<number | null>;
}

/** Real candles via ShadowAlpha get_price. Cached — ATR moves slowly. */
export class ShadowAlphaAtrProvider implements AtrProvider {
  readonly name = "shadowalpha";
  private readonly cache = new Map<string, { atr: number | null; fetchedAt: number }>();

  constructor(
    private readonly mcp: McpToolClient,
    private readonly cacheMinutes = 60,
  ) {}

  async getAtr(symbol: string, period: number): Promise<number | null> {
    const key = `${symbol.toUpperCase()}:${period}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.cacheMinutes * 60_000) {
      return cached.atr;
    }
    let atr: number | null = null;
    try {
      const result = (await this.mcp.callTool("get_price", {
        symbol: symbol.toUpperCase(),
        // Extra headroom so weekends/holidays still leave `period` candles.
        days: Math.min(365, period * 2 + 10),
      })) as { daily_candles?: Array<{ high?: number; low?: number; close?: number }> };
      const candles = (result?.daily_candles ?? [])
        .map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
        .filter((c) => Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
      atr = computeAtr(candles, period);
    } catch (err) {
      log.warn(`atr: ${symbol} fetch failed — ATR stop skipped this window (${String(err)})`);
    }
    this.cache.set(key, { atr, fetchedAt: Date.now() });
    return atr;
  }
}

/**
 * Fixture ATR from the replayed close-only price series (quotes.json):
 * close-to-close absolute moves approximate true range well enough for the
 * zero-credential demo.
 */
export class FixtureAtrProvider implements AtrProvider {
  readonly name = "fixture";
  private readonly series: Record<string, number[]>;

  constructor(quotesFixturePath: string) {
    this.series = JSON.parse(readFileSync(quotesFixturePath, "utf8"));
  }

  async getAtr(symbol: string, period: number): Promise<number | null> {
    const closes = this.series[symbol.toUpperCase()];
    if (!closes || closes.length < 2) return null;
    const candles: Candle[] = closes.map((close) => ({ high: close, low: close, close }));
    return computeAtr(candles, period);
  }
}
