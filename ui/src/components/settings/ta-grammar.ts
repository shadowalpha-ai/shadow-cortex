/**
 * Re-export shim: the ta.* field grammar is engine domain and lives
 * dependency-free in src/enrichment/ta-grammar.ts — importing it here means
 * the rule builder's notion of "derivable indicator field" IS the engine's
 * own function, so the two can never drift (they did once: the UI mirror
 * missed priceVs*Pct and bbPercentB and falsely linted menu fields).
 */

export * from "../../../../src/enrichment/ta-grammar.js";
