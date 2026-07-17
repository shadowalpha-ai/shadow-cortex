/**
 * The exit-conditions library — pure functions of price, time, and (for the
 * ATR stop) volatility, evaluated against each live position every
 * management tick. Deterministic; mirrors the entry-rule structure; emits
 * the same Proposal type downstream.
 *
 * Conflict resolution: risk-reducing rules win. Evaluation order is
 *   stop-loss → ATR stop → trailing-stop → partial take-profit →
 *   take-profit → breakeven (dead money) → max-hold
 * The first rule that fires is the exit reason (a stop always beats a
 * target). A partial take-profit decision carries `fraction` (< 1) — every
 * other rule closes the full position.
 *
 * ATR stop: chandelier-style — exit when price falls
 * atrStopMultiplier × ATR(atrPeriod) below the high-water mark. When ATR is
 * unavailable (`atr` null) the rule is skipped; the fixed stops still run.
 *
 * Trail activation: the trailing stop arms only once the position has been
 * up `trailActivationPct` from cost basis (tracked via the high-water mark,
 * so a later dip doesn't disarm it).
 */

import type { Position } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { roundMoney } from "../core/normalize.js";

export interface ExitDecision {
  rule:
    | "stop-loss"
    | "atr-stop"
    | "trailing-stop"
    | "partial-take-profit"
    | "take-profit"
    | "breakeven"
    | "max-hold";
  detail: string;
  /** Present (< 1) only for partial take-profit; absent = close everything. */
  fraction?: number;
}

/** Only the price/time/volatility stops — router-level knobs don't belong here. */
export type ExitStops = Pick<
  Settings["exit"],
  | "stopLossPct"
  | "trailingStopPct"
  | "trailActivationPct"
  | "takeProfitPct"
  | "maxHoldDays"
  | "atrStopMultiplier"
  | "atrPeriod"
  | "breakevenDays"
  | "breakevenMinMovePct"
  | "partialTpPct"
  | "partialCloseFraction"
>;

export interface ExitContext {
  /** ATR(atrPeriod) for the symbol, when the provider could compute it. */
  atr?: number | null;
  /** Whether this position already took its partial take-profit. */
  partialTaken?: boolean;
}

export function evaluateExit(
  position: Position,
  exit: ExitStops,
  now: Date = new Date(),
  ctx: ExitContext = {},
): ExitDecision | null {
  const { costBasis, currentPrice, highWaterMark, openedAt } = position;

  if (exit.stopLossPct !== null) {
    const stopPrice = costBasis * (1 - exit.stopLossPct / 100);
    if (currentPrice <= stopPrice) {
      return {
        rule: "stop-loss",
        detail: `price $${currentPrice} breached hard stop $${roundMoney(stopPrice)} (−${exit.stopLossPct}% off cost basis $${costBasis})`,
      };
    }
  }

  if (exit.atrStopMultiplier !== null && ctx.atr != null && ctx.atr > 0) {
    const stopPrice = highWaterMark - exit.atrStopMultiplier * ctx.atr;
    if (currentPrice <= stopPrice) {
      return {
        rule: "atr-stop",
        detail:
          `price $${currentPrice} fell ${exit.atrStopMultiplier}×ATR(${exit.atrPeriod}) ` +
          `($${roundMoney(exit.atrStopMultiplier * ctx.atr)}) below peak $${highWaterMark} (stop $${roundMoney(stopPrice)})`,
      };
    }
  }

  if (exit.trailingStopPct !== null) {
    // The trail arms only after the position has BEEN up activation% — judged
    // off the high-water mark so a pullback doesn't disarm it.
    const armed =
      exit.trailActivationPct === null ||
      highWaterMark >= costBasis * (1 + exit.trailActivationPct / 100);
    if (armed) {
      const trailPrice = highWaterMark * (1 - exit.trailingStopPct / 100);
      if (currentPrice <= trailPrice) {
        return {
          rule: "trailing-stop",
          detail: `price $${currentPrice} fell ${exit.trailingStopPct}% off peak $${highWaterMark} (trail stop $${roundMoney(trailPrice)})`,
        };
      }
    }
  }

  if (exit.partialTpPct !== null && !ctx.partialTaken) {
    const target = costBasis * (1 + exit.partialTpPct / 100);
    if (currentPrice >= target) {
      return {
        rule: "partial-take-profit",
        fraction: exit.partialCloseFraction,
        detail:
          `price $${currentPrice} reached partial target $${roundMoney(target)} ` +
          `(+${exit.partialTpPct}%) — selling ${Math.round(exit.partialCloseFraction * 100)}%, letting the rest run`,
      };
    }
  }

  if (exit.takeProfitPct !== null) {
    const targetPrice = costBasis * (1 + exit.takeProfitPct / 100);
    if (currentPrice >= targetPrice) {
      return {
        rule: "take-profit",
        detail: `price $${currentPrice} reached target $${roundMoney(targetPrice)} (+${exit.takeProfitPct}% off cost basis $${costBasis})`,
      };
    }
  }

  const heldDays = (now.getTime() - Date.parse(openedAt)) / 86_400_000;

  if (exit.breakevenDays !== null && heldDays >= exit.breakevenDays) {
    const minMove = exit.breakevenMinMovePct ?? 0;
    if (position.unrealizedPnlPct < minMove) {
      return {
        rule: "breakeven",
        detail:
          `dead money: held ${heldDays.toFixed(1)}d and only ${position.unrealizedPnlPct}% ` +
          `(needs ≥ ${minMove}% after ${exit.breakevenDays}d) — freeing the capital`,
      };
    }
  }

  if (exit.maxHoldDays !== null && heldDays >= exit.maxHoldDays) {
    return {
      rule: "max-hold",
      detail: `held ${heldDays.toFixed(1)}d, maxHoldDays is ${exit.maxHoldDays}`,
    };
  }

  return null;
}
