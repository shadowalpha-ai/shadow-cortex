/**
 * Generates docs/DATAPOINTS.md — the complete datapoint reference for entry
 * criteria — from the SAME FieldDef catalogs the engine serves to the rule
 * builder. Humans read the file; AIs read it or pull the live catalog.
 *
 * Run: `npm run docs:fields` (test/field-docs.test.ts fails when the checked-in
 * file drifts from the code, so adapters can't add fields undocumented).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FieldDef } from "../core/types.js";
import { FIELD_OPS, UNIVERSAL_FIELDS, WINDOW_FIELDS } from "../entry/rules.js";
import { SHADOWALPHA_FIELDS } from "../sources/shadowalpha.js";
import { PREDICTION_FIELDS } from "../sources/shadowalpha-predictions.js";
import { portfolioFieldCatalog } from "../sources/shadowalpha-portfolio.js";
import { CONVICTION_FIELDS, SYMBOL_PREDICTION_FIELDS } from "../enrichment/shadowalpha.js";
import { STANDARD_TA_MENU, isMenuTaField, taFieldDefs } from "../enrichment/ta.js";

/** Robinhood indicator types the MCP supports beyond our wired menu (captured 2026-07-17). */
const ROBINHOOD_UNWIRED_TYPES =
  "momentum, roc, cci, williams_r, atr, mfi, adx, donchian_channels, " +
  "keltner_channels, supertrend, vwap, obv, pivot_points";

function esc(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function table(fields: FieldDef[]): string {
  const rows = fields.map((f) => {
    const def =
      f.defaultOp !== undefined && f.defaultValue !== undefined
        ? `\`${f.defaultOp} ${f.defaultValue}\``
        : "—";
    const description = f.description ?? "";
    const desc = [
      description && !/[.!?]$/.test(description) && f.values ? `${description}.` : description,
      f.values ? `One of: ${f.values.map((v) => `\`${v}\``).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `| \`${f.name}\` | ${f.kind} | ${def} | ${esc(desc)} |`;
  });
  return ["| Datapoint | Type | Suggested default | Meaning |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

export function generateFieldDocs(): string {
  const taMenu = taFieldDefs(STANDARD_TA_MENU).filter((f) => isMenuTaField(f.name));

  return `# Datapoint reference — everything entry criteria can gate on

> GENERATED from the engine's own field catalogs by \`npm run docs:fields\` —
> do not edit by hand. \`test/field-docs.test.ts\` fails when this file drifts
> from the code. The LIVE catalog (including your configured portfolio names)
> is always \`GET /api/settings\` → \`availableFieldCatalog\`, or the
> \`get_strategy\` MCP tool for AI clients.

Entry criteria are sentence cards: **when a signal arrives from [feed] → and
all conditions hold → propose a buy**. Every condition is
\`datapoint op value\`. Missing data always **fails closed** — a condition on
a datapoint the signal doesn't carry simply never matches (the Event feed's
\`entry_skipped\` events tell you why nothing proposed).

Operators: \`${FIELD_OPS.join("` `")}\`. Numbers use the comparisons, strings
and booleans use \`==\`/\`!=\`, and \`window.types\` uses \`has\`.

## This signal (universal — carried by every signal from any feed)

${table(UNIVERSAL_FIELDS)}

## Feed: Ideas & buzz — ShadowAlpha (\`shadowalpha\`)

The buzz/stock-ideas scanner. Note: the source's own \`minStrength\` floor
(Data sources) drops weaker signals before rules ever see them.

${table(SHADOWALPHA_FIELDS)}

## Feed: Analyst predictions — ShadowAlpha (\`shadowalpha-predictions\`)

Individual analyst calls, joined with the analyst's track record.

${table(PREDICTION_FIELDS)}

## Feed: Portfolios / curations — ShadowAlpha (\`shadowalpha-portfolio\`)

Trades made by the portfolios you follow (picked in Data sources). Long
entries arrive bullish; analyst shorts arrive bearish (never a buy); closes
arrive as bearish advisories. \`portfolioName\`'s dropdown enumerates the
portfolios you actually follow.

${table(portfolioFieldCatalog(["(your followed portfolios)"]))}

## Symbol enrichment: AI conviction — ShadowAlpha (\`conviction.*\`)

Computed per symbol at decision time (enable in Data sources → ShadowAlpha →
AI conviction analysis). Live mode refuses fixture-fed enrichment.

${table(CONVICTION_FIELDS)}

## Symbol enrichment: Prediction stats — ShadowAlpha (\`predictions.*\`)

Aggregated tracked predictions per symbol (enable in Data sources).

${table(SYMBOL_PREDICTION_FIELDS)}

## Symbol enrichment: Technical indicators — Robinhood (\`ta.*\`)

Server-computed by Robinhood over daily bars (shape captured live
2026-07-17); the fixture provider serves demo values without credentials.
Enrichment is config-free: reference a \`ta.*\` field in any rule and the
engine derives and fetches exactly what's needed.

${table(taMenu)}

**The period grammar goes beyond the menu**: any \`ta.rsiN\`, \`ta.smaN\`,
\`ta.emaN\`, \`ta.priceVsSmaNPct\`, \`ta.priceVsEmaNPct\`, \`ta.bbUpperN\`,
\`ta.bbLowerN\`, or \`ta.bbPercentBN\` works for any period \`N\` (hand-edit
the profile or type the name) — e.g. \`ta.rsi21\` or \`ta.priceVsSma100Pct\`.
MACD is the standard 12/26/9. Raw levels (\`ta.sma50\`, \`ta.bbUpper20\`) are
dollar values — prefer the relative \`priceVs…Pct\`/\`%B\` forms, which are
comparable across symbols.

Robinhood's indicator engine also supports (not yet wired into the menu):
${ROBINHOOD_UNWIRED_TYPES}.

## Window aggregates (\`window.*\`)

Computed over the card's matching signal set — for confluence rules like
"at least 2 distinct sources agree".

${table(WINDOW_FIELDS)}
`;
}

// CLI entry: write the file.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const out = fileURLToPath(new URL("../../docs/DATAPOINTS.md", import.meta.url));
  writeFileSync(out, generateFieldDocs());
  console.log(`wrote ${out}`);
}
