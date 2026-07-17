/**
 * The ta.* field grammar — spec type, menu, field-name derivation, and the
 * inverse (which indicator computes a given field name).
 *
 * DEPENDENCY-FREE ON PURPOSE: the dashboard imports this module directly
 * (ui/src/components/settings/ta-grammar.ts re-export shim), so the rule
 * builder's notion of "derivable ta.* field" is the engine's own function
 * and can never drift. Keep zod (and everything else) out of here; ta.ts
 * re-exports all of this and pins IndicatorSpecSchema to the same type.
 */

export type IndicatorSpec =
  | { type: "rsi"; period: number }
  | { type: "sma"; period: number }
  | { type: "ema"; period: number }
  | { type: "macd"; fastPeriod: number; slowPeriod: number; signalPeriod: number }
  | { type: "bollinger"; period: number; numStd: number };

/**
 * The standard menu the rule builder ALWAYS offers. The engine derives the
 * indicators it must compute from the ta.* fields the rules reference
 * (taSpecsFromRuleFields) — configuration follows the strategy, never gates
 * it. `enrichment.ta.indicators` remains as optional manual extras.
 */
export const STANDARD_TA_MENU: IndicatorSpec[] = [
  { type: "rsi", period: 14 },
  { type: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  { type: "sma", period: 20 },
  { type: "sma", period: 50 },
  { type: "sma", period: 200 },
  { type: "ema", period: 12 },
  { type: "ema", period: 26 },
  { type: "bollinger", period: 20, numStd: 2 },
];

/**
 * Only the fields where comparing to a plain number makes sense on any
 * symbol appear in the builder's menu (bounded, percentage, or
 * signed-around-zero). Raw dollar levels (ta.sma200, ta.bbUpper20…) stay
 * derivable by grammar for power users but are hidden from the menu.
 */
export function isMenuTaField(name: string): boolean {
  return (
    /^ta\.rsi\d+$/.test(name) ||
    name === "ta.macdHist" ||
    /^ta\.priceVs(?:Sma|Ema)\d+Pct$/.test(name) ||
    /^ta\.bbPercentB\d+$/.test(name)
  );
}

/**
 * Deterministic field name(s) for one indicator spec. Moving averages and
 * bands publish RELATIVE fields alongside the raw levels — a raw 200-day
 * average in dollars is meaningless as a universal criterion, but "price is
 * X% above its 200-day average" compares the same way on every symbol.
 */
export function taFieldNames(spec: IndicatorSpec): string[] {
  switch (spec.type) {
    case "rsi":
      return [`ta.rsi${spec.period}`];
    case "sma":
      return [`ta.sma${spec.period}`, `ta.priceVsSma${spec.period}Pct`];
    case "ema":
      return [`ta.ema${spec.period}`, `ta.priceVsEma${spec.period}Pct`];
    case "macd":
      return ["ta.macdHist"];
    case "bollinger":
      return [`ta.bbUpper${spec.period}`, `ta.bbLower${spec.period}`, `ta.bbPercentB${spec.period}`];
  }
}

/**
 * The inverse: which indicator computes a ta.* field. Names outside the
 * derivable grammar return null (the constraint then fails closed and the
 * builder lints it as unknown).
 */
export function specForTaField(name: string): IndicatorSpec | null {
  let m = /^ta\.rsi(\d+)$/.exec(name);
  if (m) return { type: "rsi", period: Number(m[1]) };
  m = /^ta\.(?:sma|priceVsSma)(\d+)(?:Pct)?$/.exec(name);
  if (m && (name.includes("priceVsSma") ? name.endsWith("Pct") : true)) {
    if (/^ta\.sma\d+$/.test(name) || /^ta\.priceVsSma\d+Pct$/.test(name)) {
      return { type: "sma", period: Number(m[1]) };
    }
  }
  m = /^ta\.(?:ema|priceVsEma)(\d+)(?:Pct)?$/.exec(name);
  if (m && (/^ta\.ema\d+$/.test(name) || /^ta\.priceVsEma\d+Pct$/.test(name))) {
    return { type: "ema", period: Number(m[1]) };
  }
  if (name === "ta.macdHist") {
    return { type: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
  }
  m = /^ta\.(?:bbUpper|bbLower|bbPercentB)(\d+)$/.exec(name);
  if (m) return { type: "bollinger", period: Number(m[1]), numStd: 2 };
  return null;
}
