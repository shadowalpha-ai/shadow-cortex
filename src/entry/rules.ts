/**
 * Entry rule cards — the ONE entry-qualification model (pure functions, same
 * pattern as src/exits/policies.ts).
 *
 * A rule card names a source (or any) and a list of constraints over labeled
 * data fields. Criteria are built on top of whatever data a source ingests:
 * adapters publish a field dictionary per signal (`signal.fields`) plus a
 * static catalog; rules constrain any of those fields by name.
 *
 * Three constraint scopes share one syntax:
 * - Plain fields evaluate PER SIGNAL: universal fields (`type`, `strength`,
 *   `confidence`, `ageMinutes`) or any adapter-published field.
 * - Reserved `window.*` fields evaluate over the card's MATCHING SET:
 *   `window.distinctSources`, `window.signalCount`, `window.maxStrength`,
 *   and `window.types` (with the `has` op).
 * - Reserved `ta.*` fields evaluate PER SYMBOL from the enrichment map the
 *   intake loop fetched (src/enrichment/ta.ts) — chart data, not signal data,
 *   so they hold or fail identically for every signal on the symbol.
 *
 * Semantics: the matching set is the fresh bullish signals for a symbol that
 * pass the card's source/symbols filters and every per-signal constraint. A
 * card matches when that set is non-empty AND every window constraint holds.
 * Cards OR together; constraints within a card AND. A missing field always
 * fails its constraint — fail closed, never guess.
 */

import { z } from "zod";
import type { FieldDef, FieldValue, Signal } from "../core/types.js";

// --- schema (imported by the settings schema; must not import settings) ---

export const FIELD_OPS = ["==", "!=", ">=", ">", "<=", "<", "has"] as const;
type FieldOp = (typeof FIELD_OPS)[number];

const ConstraintSchema = z.object({
  field: z.string().min(1),
  op: z.enum(FIELD_OPS),
  value: z.union([z.number(), z.string(), z.boolean()]),
});

export const EntryRuleSchema = z.object({
  label: z.string().min(1),
  /** null = signals from any source. */
  source: z.string().nullable().default(null),
  /** Ticker universe for this card; empty = any symbol. */
  symbols: z.array(z.string()).default([]),
  /** Empty = the trigger alone qualifies ("copy every signal from X"). */
  constraints: z.array(ConstraintSchema).max(16),
});

export const EntryRulesSchema = z.array(EntryRuleSchema).min(1).max(16);

export type Constraint = z.infer<typeof ConstraintSchema>;
export type EntryRule = z.infer<typeof EntryRuleSchema>;

// --- field catalogs (served to the rule builder) ---

export const UNIVERSAL_FIELDS: FieldDef[] = [
  { name: "type", kind: "string", description: "Signal type, e.g. consensus, buzz, prediction, alert" },
  { name: "strength", kind: "number", description: "Normalized signal magnitude, 0..1" },
  { name: "confidence", kind: "number", description: "Source certainty 0..1 (absent on some signals — a constraint on it then fails)" },
  { name: "ageMinutes", kind: "number", description: "Minutes since the signal's timestamp" },
];

export const WINDOW_FIELDS: FieldDef[] = [
  { name: "window.distinctSources", kind: "number", description: "Distinct sources in the card's matching set" },
  { name: "window.signalCount", kind: "number", description: "Signals in the card's matching set" },
  { name: "window.maxStrength", kind: "number", description: "Strongest signal in the card's matching set" },
  { name: "window.types", kind: "string", description: "Signal types present in the matching set (use the `has` op)" },
];

// --- evaluation ---

export interface RuleMatch {
  rule: EntryRule;
  contributing: Signal[];
}

function resolveSignalField(
  signal: Signal,
  name: string,
  now: Date,
  enrichment?: Record<string, FieldValue>,
): FieldValue | undefined {
  // Dotted names (ta.rsi14, conviction.buyZoneActive, predictions.count…)
  // are per-symbol ENRICHMENT fields — resolved from the enrichment map,
  // never from the signal. window.* is the one dotted namespace that isn't
  // (it aggregates the matching set and is handled in windowHolds).
  if (name.includes(".") && !name.startsWith("window.")) return enrichment?.[name];
  switch (name) {
    case "type":
      return signal.type;
    case "strength":
      return signal.strength;
    case "confidence":
      return signal.confidence;
    case "ageMinutes":
      return (now.getTime() - Date.parse(signal.timestamp)) / 60_000;
    default:
      return signal.fields[name];
  }
}

/** Missing values fail every op — including `!=`. Fail closed, never guess. */
function compare(actual: FieldValue | undefined, op: FieldOp, expected: FieldValue): boolean {
  if (actual === undefined) return false;
  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case "has":
      return false; // only meaningful on window.types, handled in windowHolds()
    default:
      if (typeof actual !== "number" || typeof expected !== "number") return false;
      switch (op) {
        case ">=":
          return actual >= expected;
        case ">":
          return actual > expected;
        case "<=":
          return actual <= expected;
        case "<":
          return actual < expected;
      }
  }
}

function windowHolds(constraint: Constraint, matching: Signal[]): boolean {
  switch (constraint.field) {
    case "window.distinctSources":
      return compare(new Set(matching.map((s) => s.source)).size, constraint.op, constraint.value);
    case "window.signalCount":
      return compare(matching.length, constraint.op, constraint.value);
    case "window.maxStrength":
      return compare(Math.max(...matching.map((s) => s.strength)), constraint.op, constraint.value);
    case "window.types":
      if (constraint.op !== "has") return false;
      return matching.some((s) => s.type === String(constraint.value));
    default:
      return false; // unknown window field — fail closed
  }
}

/**
 * Evaluate every rule card for one symbol against its fresh bullish signals.
 * Returns the first matching card (cards OR together) or null.
 */
export function evaluateRulesForSymbol(
  symbol: string,
  signals: Signal[],
  rules: EntryRule[],
  now: Date,
  enrichment?: Record<string, FieldValue>,
): RuleMatch | null {
  for (const rule of rules) {
    if (rule.symbols.length > 0 && !rule.symbols.includes(symbol)) continue;

    const perSignal = rule.constraints.filter((c) => !c.field.startsWith("window."));
    const windowed = rule.constraints.filter((c) => c.field.startsWith("window."));

    const matching = signals.filter(
      (s) =>
        (rule.source === null || s.source === rule.source) &&
        perSignal.every((c) =>
          compare(resolveSignalField(s, c.field, now, enrichment), c.op, c.value),
        ),
    );
    if (matching.length === 0) continue;
    if (!windowed.every((c) => windowHolds(c, matching))) continue;

    return { rule, contributing: matching };
  }
  return null;
}

// --- default cards (SAFE_DEFAULTS' entry posture) ---

/**
 * The rule cards an unconfigured engine runs: multi-source consensus, or one
 * genuinely strong signal. Conservative — a single mid-strength signal from
 * one source never trades. Rule cards are the ONLY entry-qualification model.
 */
export const DEFAULT_ENTRY_RULES: EntryRule[] = [
  {
    label: "consensus",
    source: null,
    symbols: [],
    constraints: [
      { field: "strength", op: ">=", value: 0.4 },
      { field: "window.distinctSources", op: ">=", value: 2 },
    ],
  },
  {
    label: "strong signal",
    source: null,
    symbols: [],
    constraints: [
      { field: "strength", op: ">=", value: 0.4 },
      { field: "window.maxStrength", op: ">=", value: 0.75 },
    ],
  },
];

/** Human-readable card summary — used for auto-labels and dashboard display. */
export function describeRule(rule: EntryRule): string {
  const scope = [
    rule.source ? `source ${rule.source}` : null,
    rule.symbols.length > 0 ? `symbols ${rule.symbols.join("/")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const constraints =
    rule.constraints.length === 0
      ? "any signal"
      : rule.constraints
          .map((c) => `${c.field.replace("window.", "")} ${c.op} ${c.value}`)
          .join(" and ");
  return scope ? `${constraints} (${scope})` : constraints;
}
