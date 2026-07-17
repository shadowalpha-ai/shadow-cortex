/**
 * Symbol enrichment — the second half of the criteria model. Feeds emit
 * SIGNALS (events); enrichers answer QUESTIONS about a symbol under decision
 * (what does the chart look like? what's the AI conviction? how are its
 * predictions doing?) as `prefix.*` fields rule cards constrain like any
 * other field. Missing data always fails the constraint — fail closed.
 */

import type { FieldDef, FieldValue } from "../core/types.js";

export interface SymbolEnricher {
  /** The ta.* / conviction.* / predictions.* fields this enricher can produce. */
  fieldDefs(): FieldDef[];
  /**
   * Per-symbol field maps; a symbol with no data simply has no entry.
   * `prices` = the intake loop's current quotes (for relative TA fields).
   */
  enrich(
    symbols: string[],
    now: Date,
    prices?: Record<string, number>,
  ): Promise<Record<string, Record<string, FieldValue>>>;
}

/** Merges several enrichers into the one map the decider sees. */
export class CompositeEnricher implements SymbolEnricher {
  constructor(private readonly enrichers: SymbolEnricher[]) {}

  fieldDefs(): FieldDef[] {
    return this.enrichers.flatMap((e) => e.fieldDefs());
  }

  async enrich(
    symbols: string[],
    now: Date,
    prices?: Record<string, number>,
  ): Promise<Record<string, Record<string, FieldValue>>> {
    const merged: Record<string, Record<string, FieldValue>> = {};
    for (const enricher of this.enrichers) {
      const result = await enricher.enrich(symbols, now, prices);
      for (const [symbol, fields] of Object.entries(result)) {
        merged[symbol] = { ...merged[symbol], ...fields };
      }
    }
    return merged;
  }
}
