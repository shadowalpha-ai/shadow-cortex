/**
 * Position sizing. Fixed-dollar is the default and fractional-capable — a $25
 * position is a $25 position regardless of share price, which is what makes
 * tiny-account live testing possible. A hardcoded $1 minimum order value
 * (Robinhood's fractional floor) rejects dust orders.
 *
 * Sizing SUGGESTS shares; the execution gate ENFORCES caps.
 */

import { roundShares } from "./normalize.js";
import type { Settings } from "../settings/schema.js";

const MIN_ORDER_VALUE = 1;

/** Returns suggested shares, or 0 meaning "skip this order". */
export function sizeShares(
  price: number,
  sizing: Settings["sizing"],
  equity: number,
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;

  let shares: number;
  switch (sizing.mode) {
    case "fixedDollar":
      shares = sizing.value / price;
      break;
    case "fixedShares":
      shares = sizing.value;
      break;
    case "percentOfEquity":
      shares = (equity * sizing.value) / 100 / price;
      break;
  }

  if (!sizing.allowFractionalShares) shares = Math.floor(shares);
  shares = roundShares(shares);

  if (shares <= 0 || shares * price < MIN_ORDER_VALUE) return 0;
  return shares;
}
