/**
 * The rule-builder's field catalog and the "config follows the strategy"
 * derivation: the engine computes whatever enrichment the entry rules
 * actually reference — nothing to enable, nothing to forget.
 *
 * - `enrichmentNeeds(settings)` — which enrichment the RULES require
 *   (ta specs parsed from ta.* field names; conviction/predictions flags
 *   from their namespaces) plus any manual indicator extras from config.
 * - `availableFieldCatalog(settings)` — everything the builder offers:
 *   every feed's fields and the full standard TA menu, enabled or not.
 */

import type { FieldDef } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import {
  STANDARD_TA_MENU,
  isMenuTaField,
  taFieldDefs,
  taFieldNames,
  taSpecsFromRuleFields,
  type IndicatorSpec,
} from "./ta.js";
import { CONVICTION_FIELDS, SYMBOL_PREDICTION_FIELDS } from "./shadowalpha.js";
import { SHADOWALPHA_FIELDS } from "../sources/shadowalpha.js";
import { PREDICTION_FIELDS } from "../sources/shadowalpha-predictions.js";
import { portfolioFieldCatalog } from "../sources/shadowalpha-portfolio.js";
import { UNIVERSAL_FIELDS, WINDOW_FIELDS } from "../entry/rules.js";

function referencedFields(settings: Settings): string[] {
  return settings.entry.rules.flatMap((r) => r.constraints.map((c) => c.field));
}

function dedupeSpecs(specs: IndicatorSpec[]): IndicatorSpec[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = taFieldNames(spec).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface EnrichmentNeeds {
  /** Indicators the rules reference, unioned with config extras. */
  taSpecs: IndicatorSpec[];
  /** Indicators the RULES alone require (drives live-mode honesty checks). */
  rulesTaSpecs: IndicatorSpec[];
  conviction: boolean;
  symbolPredictions: boolean;
}

export function enrichmentNeeds(settings: Settings): EnrichmentNeeds {
  const fields = referencedFields(settings);
  const rulesTaSpecs = taSpecsFromRuleFields(fields);
  return {
    rulesTaSpecs,
    taSpecs: dedupeSpecs([...rulesTaSpecs, ...settings.enrichment.ta.indicators]),
    conviction: fields.some((f) => f.startsWith("conviction.")),
    symbolPredictions: fields.some((f) => f.startsWith("predictions.")),
  };
}

export interface AvailableFieldCatalog {
  universal: FieldDef[];
  window: FieldDef[];
  /** EVERY known feed's fields, enabled or not — the client filters by draft. */
  bySource: Record<string, FieldDef[]>;
  /** Every enrichment group's fields — always offered; usage auto-activates them. */
  enrichment: {
    ta: FieldDef[];
    conviction: FieldDef[];
    symbolPredictions: FieldDef[];
  };
}

export function availableFieldCatalog(settings: Settings): AvailableFieldCatalog {
  const portfolioSource = settings.sources.find((s) => s.type === "shadowalpha-portfolio");
  const portfolios =
    portfolioSource?.type === "shadowalpha-portfolio" ? portfolioSource.portfolios : [];
  const needs = enrichmentNeeds(settings);
  return {
    universal: UNIVERSAL_FIELDS,
    window: WINDOW_FIELDS,
    bySource: {
      shadowalpha: SHADOWALPHA_FIELDS,
      "shadowalpha-predictions": PREDICTION_FIELDS,
      "shadowalpha-portfolio": portfolioFieldCatalog(portfolios),
    },
    enrichment: {
      // The standard menu (universally-comparable fields only) plus any
      // field the rules already reference — even raw levels stay editable.
      ta: (() => {
        const inUse = new Set(referencedFields(settings).filter((f) => f.startsWith("ta.")));
        return taFieldDefs(dedupeSpecs([...STANDARD_TA_MENU, ...needs.taSpecs])).filter(
          (f) => isMenuTaField(f.name) || inUse.has(f.name),
        );
      })(),
      conviction: CONVICTION_FIELDS,
      symbolPredictions: SYMBOL_PREDICTION_FIELDS,
    },
  };
}
