/**
 * Derivation logic for the rule-card builder's two-step "pick a data source →
 * pick a datapoint" model. Pure functions, no JSX.
 *
 * The persisted constraint stays `{field, op, value}` — the CATEGORY is never
 * stored; it derives from the field name's prefix, mirroring the engine's
 * resolver (src/entry/rules.ts resolveSignalField).
 *
 * Enrichment is CONFIG-FREE: the engine computes whatever ta.* /
 * conviction.* / predictions.* fields the rules reference, so every
 * enrichment datapoint is always selectable. Lint covers what genuinely
 * can't work: feed fields outside the trigger scope, ta.* names outside the
 * derivable grammar, and names nothing knows.
 */

import { specForTaField } from "./ta-grammar";
import type { FieldCatalog, FieldDef, Settings } from "../../types";
import { feedLabel } from "./feeds";

export type CategoryId = "signal" | "sa-symbol" | "rh-symbol" | "window";

export interface DatapointGroup {
  label: string;
  enabled: boolean;
  disabledHint: string | null;
  fields: FieldDef[];
}

export interface Category {
  id: CategoryId;
  label: string;
  enabled: boolean;
  disabledHint: string | null;
  groups: DatapointGroup[];
}

/** What the draft currently enables. */
export interface DraftState {
  enabledFeeds: Set<string>;
  portfolios: string[];
  /** The buzz feed's source-side strength floor (signals below it never arrive). */
  minStrength: number | null;
}

export function draftState(draft: Settings): DraftState {
  const portfolioSource = draft.sources.find((s) => s.type === "shadowalpha-portfolio");
  const buzzSource = draft.sources.find((s) => s.type === "shadowalpha");
  return {
    enabledFeeds: new Set(draft.sources.map((s) => s.type)),
    portfolios:
      portfolioSource?.type === "shadowalpha-portfolio" ? portfolioSource.portfolios : [],
    minStrength:
      buzzSource?.type === "shadowalpha" && buzzSource.minStrength > 0
        ? buzzSource.minStrength
        : null,
  };
}

/** Per-feed fields, with the portfolioName enumeration taken from the DRAFT. */
export function feedFields(catalog: FieldCatalog, state: DraftState, feed: string): FieldDef[] {
  const fields = catalog.bySource[feed] ?? [];
  if (feed !== "shadowalpha-portfolio") return fields;
  return fields.map((f) =>
    f.name === "portfolioName" ? { ...f, values: state.portfolios } : f,
  );
}

const ENABLE_HINT = "enable in Data sources";

/** The step-1 categories (and their step-2 datapoint groups) for one card. */
export function categoriesForCard(
  catalog: FieldCatalog,
  state: DraftState,
  source: string | null,
): Category[] {
  // "This signal": the triggering signal's own data.
  const signalGroups: DatapointGroup[] = [
    { label: "Any signal", enabled: true, disabledHint: null, fields: catalog.universal },
  ];
  if (source !== null) {
    const on = state.enabledFeeds.has(source);
    signalGroups.push({
      label: `${feedLabel(source)} fields`,
      enabled: on,
      disabledHint: on ? null : `feed is off — ${ENABLE_HINT}`,
      fields: feedFields(catalog, state, source),
    });
  } else {
    for (const feed of Object.keys(catalog.bySource)) {
      if (!state.enabledFeeds.has(feed)) continue;
      signalGroups.push({
        label: `${feedLabel(feed)} fields`,
        enabled: true,
        disabledHint: null,
        fields: feedFields(catalog, state, feed),
      });
    }
  }

  const always = { enabled: true, disabledHint: null };
  return [
    { id: "signal", label: "This signal", ...always, groups: signalGroups },
    {
      id: "sa-symbol",
      label: "ShadowAlpha — symbol data",
      ...always,
      groups: [
        { label: "AI conviction (conviction.*)", ...always, fields: catalog.enrichment.conviction },
        { label: "Prediction stats (predictions.*)", ...always, fields: catalog.enrichment.symbolPredictions },
      ],
    },
    {
      id: "rh-symbol",
      label: "Robinhood — symbol data",
      ...always,
      groups: [
        { label: "Technical indicators (ta.*)", ...always, fields: catalog.enrichment.ta },
      ],
    },
    {
      id: "window",
      label: "Signal window (aggregates)",
      ...always,
      groups: [
        { label: "Across the card's matching signals", ...always, fields: catalog.window },
      ],
    },
  ];
}

/** Which category a stored field belongs to — the engine resolver's prefix rule. */
export function categoryForField(field: string): CategoryId {
  if (field.startsWith("window.")) return "window";
  if (field.startsWith("ta.")) return "rh-symbol";
  if (field.startsWith("conviction.") || field.startsWith("predictions.")) return "sa-symbol";
  return "signal";
}

/** The engine's own grammar decides derivability — no UI mirror to drift. */
export function isDerivableTaField(field: string): boolean {
  return specForTaField(field) !== null;
}

/** Find a field's def anywhere so editors stay typed for stale constraints. */
export function findFieldDef(field: string, categories: Category[]): FieldDef | undefined {
  for (const category of categories) {
    for (const group of category.groups) {
      const def = group.fields.find((f) => f.name === field);
      if (def) return def;
    }
  }
  return undefined;
}

/**
 * Why this constraint can never match right now, or null when it can. Mirrors
 * the engine's fail-closed evaluation (missing field → constraint false).
 */
export function lintConstraint(
  constraint: { field: string; op: string; value: string | number | boolean },
  categories: Category[],
  catalog: FieldCatalog,
  state: DraftState,
  source: string | null,
): string | null {
  const { field } = constraint;
  // ta.* — anything the indicator grammar can derive is computed on demand.
  if (field.startsWith("ta.")) {
    return isDerivableTaField(field)
      ? null
      : "not a recognized indicator field — this condition will never match";
  }

  // Present in a group → fine when the group is live; else name the fix.
  for (const category of categories) {
    for (const group of category.groups) {
      const def = group.fields.find((f) => f.name === field);
      if (!def) continue;
      if (!group.enabled) return `will never match — ${group.disabledHint ?? group.label}`;
      // The 2026-07-16 foot-gun: a != on an enumerated value silently turns
      // "follow" into "exclude". Legal, but say what it means out loud.
      if (constraint.op === "!=" && def.values?.includes(String(constraint.value))) {
        return `heads-up: this EXCLUDES "${constraint.value}" — signals where ${field} is "${constraint.value}" will never match this card`;
      }
      return null;
    }
  }

  // A feed field outside the trigger scope.
  if (!field.includes(".")) {
    if (source !== null) {
      return `will never match — ${feedLabel(source)} signals don't publish "${field}"`;
    }
    for (const feed of Object.keys(catalog.bySource)) {
      if (state.enabledFeeds.has(feed)) continue;
      if ((catalog.bySource[feed] ?? []).some((f) => f.name === field)) {
        return `will never match — only ${feedLabel(feed)} publishes "${field}", and that feed is off`;
      }
    }
  }

  return "unknown datapoint — this condition will never match";
}
