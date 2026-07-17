# Authoring Guide — sources, deciders, exits, profiles

This guide is written for humans AND for AI agents. If you're an agent and the
user said "connect me to [X]" or "trade it like [scenario/params]", everything
you need is here: the contracts, the conventions, and the reference
implementations to copy.

## The one rule above all

**The core is source-agnostic.** Nothing downstream of a source adapter may
depend on where a signal came from. `Signal` is the only contract the core
knows. If your design needs the decider or the exit loop to know about your
upstream, the adapter is wrong.

---

## The locked shapes (src/core/types.ts)

```ts
Signal   = { symbol, type, direction, strength (0..1), source, timestamp,
             confidence?, fields, dedupeKey, raw }
Proposal = { id, symbol, action (buy|sell), direction, decider,
             contributingSignals?, suggestedShares, referencePrice,
             protectiveStop?, rationale, createdAt, expiresAt, priceBandPct }
Position = { symbol, shares, costBasis, currentPrice, unrealizedPnlPct,
             highWaterMark, openedAt }
DecisionContext = { signals, positions, quotes, equity, enrichment?, settings, now }
Decider  = { name, decide(ctx: DecisionContext): Promise<Proposal[]> }
SignalSource = { name, fieldCatalog, poll(): Promise<Signal[]> }
```

Share quantities are decimal everywhere (fractional-capable). Round shares to
6 dp and money to cents at boundaries — helpers in `src/core/normalize.ts`.

### `Signal.fields` — the extensibility keystone

`fields` is a dictionary of labeled data values (`number | string | boolean`)
an adapter publishes for entry criteria to constrain by name — `opp`,
`analystRating`, `spikeRatio`, `confidence`, or anything your source ingests.
The core never interprets field names; **entry rule cards reference them**, so
you can build criteria on top of any data a source provides without touching
core code. A future TA source that publishes `rsi`, `sma50`, `atrPct` needs
zero engine changes — rule cards can constrain those the day it ships.

Every adapter also exports a **`fieldCatalog: FieldDef[]`** — the list of
fields it publishes (`{name, kind, description}`, plus optional `values`
enums and `defaultOp`/`defaultValue` suggestions), aggregated by the registry
and served to the dashboard rule builder as dropdown options. A test
(`test/field-catalog.test.ts`) asserts an adapter never publishes a field it
didn't declare, so the builder's dropdowns never lie.

Field catalogs also feed the human/AI reference **`docs/DATAPOINTS.md`**:
after adding or changing any `FieldDef`, wire the new catalog into
`src/tools/generate-field-docs.ts` (new sources only) and run
`npm run docs:fields` — `test/field-docs.test.ts` fails until the
regenerated file is committed, so no datapoint ships undocumented.

---

## Adding a signal source

Sources are **pollers**: the engine calls `poll()` on the intake cadence and
the adapter fetches from its upstream, returning normalized `Signal[]`.
Reference: `src/sources/shadowalpha.ts` and
`src/sources/shadowalpha-portfolio.ts`.

Requirements for every adapter — the reference files show all of them:

1. **A header comment stating your normalization assumptions** — what maps to
   bullish/bearish and how strength scales to 0..1. A human must be able to
   sanity-check your mapping without reading code.
2. **Use the core helpers** (`makeDedupeKey`, `clampStrength`,
   `directionFromSign`) — never reinvent them.
3. **Preserve the untouched upstream payload in `signal.raw`.**
4. **Fallible by contract:** handle auth expiry, rate limits, and
   partial/empty responses without throwing out of the loop. Validate fields —
   never trust upstream data. A null rendered as `0.0` must not become a
   price or a strength.
5. **Injectable client:** take your HTTP/MCP client as a constructor argument
   so tests run against fixtures with zero credentials
   (see `McpToolClient` in `src/sources/mcp-client.ts`).
6. **Declare a `fieldCatalog`** and publish those fields on `signal.fields`
   (see `SHADOWALPHA_FIELDS` / `portfolioFieldCatalog`). This is what makes
   your source's data usable in rule cards.
7. **Register it:** add a config variant to the `sources` union in
   `src/settings/schema.ts` and one factory case in
   `src/sources/registry.ts`. The core stays untouched.

Tests that must accompany a new adapter (copy the shape of
`test/shadowalpha-portfolio.test.ts`): representative fixture → expected
`Signal[]`; the same upstream event twice → one signal survives;
empty/malformed/auth-error responses → no crash, no bogus signals; the
field-catalog honesty check picks your adapter up automatically once it's
exported.

**A worked reference source:** `src/sources/shadowalpha-portfolio.ts` turns
your ShadowAlpha portfolios/curations into tradeable signals via
`list_portfolios` + `get_portfolio_signals` — cursor seeding, per-item error
isolation, a declared field catalog with an enumeration, and fail-closed
skips for rows the engine can't trade.

### Sketch: an HTTP webhook source (e.g. TradingView)

v1 deliberately ships no open HTTP port (no auth story to get wrong). If you
want TradingView alerts: run any webhook receiver you trust (even a 20-line
`node:http` server) that validates a shared secret and appends alerts to a
local file or queue, then write a small poller source that drains it into
`Signal`s. Binary alerts map to a fixed mid-strength of 0.5. Dedupe hard —
TradingView retries.

---

## Adding a decider

Implement `Decider`, register it in `src/deciders/registry.ts`, add its name
to the `decider` enum in the settings schema. Rules to live by:

- **Deciders only propose.** The execution gate (`src/execution/gate.ts`)
  enforces caps, the confirm gate, and the price band. Don't duplicate cap
  logic in a decider — but don't rely on the gate for correctness of your
  logic either.
- **Long-only:** buy opens, sell closes. Never propose selling what isn't
  held. If your decider is an LLM (see `src/deciders/claude.ts`), enforce this
  mapping in code after the model responds — never trust the model to.
- Size with `sizeShares()` from `src/core/sizing.ts` so fractional rules and
  the $1 minimum order hold everywhere.
- Skip symbols with no quote in `ctx.quotes`; skip held symbols for entries
  (no scale-in in v1).
- Key-gate anything that needs credentials and fail closed to `rules`.

## Adding an exit rule

Exit rules are pure functions of price and time in `src/exits/policies.ts`,
evaluated per position per management tick. Add your rule to `evaluateExit`
(mind the order — risk-reducing rules fire first), add its parameter to the
`exit` block in the settings schema with a safe default, and add a case to
`test/exits.test.ts`. If your rule needs signals (e.g. exit-on-reversal),
stop: that couples the management loop to the signal store and is deliberately
post-v1.

## Entry rule cards (the criteria model)

Entry criteria are **rule cards** built on top of ingested data — see
`src/entry/rules.ts` (the evaluator) and the `entry.rules` block of any
profile. A card names a source and a list of constraints over signal fields:

```jsonc
{
  "label": "Buzzing + analyst-backed",
  "source": "shadowalpha",        // null = any source
  "symbols": ["NVDA", "PLTR"],    // empty = any ticker
  "constraints": [
    { "field": "type",           "op": "==", "value": "consensus" },
    { "field": "analystRating",  "op": ">=", "value": 55 },
    { "field": "window.distinctSources", "op": ">=", "value": 2 }
  ]
}
```

- **Fields** are `signal.fields` names, plus the universal fields (`type`,
  `strength`, `confidence`, `ageMinutes`) and `window.*` aggregates over the
  card's matching set (`window.distinctSources`, `window.signalCount`,
  `window.maxStrength`, `window.types` with the `has` op).
- **Ops:** `== != >= > <= <` and `has` (for `window.types`).
- **Semantics:** cards OR together; constraints within a card AND. A missing
  field fails its constraint (**fail closed** — a rule never fires on data you
  don't have). `entry.symbolBlocklist` is enforced first, always.
- Rule cards are the ONLY entry-qualification model; an unconfigured engine
  runs the conservative `DEFAULT_ENTRY_RULES` pair (consensus / strong signal)
  from `src/entry/rules.ts`.
- A `FieldDef` may declare `values: [...]` (an enumeration) — the builder then
  renders a dropdown instead of a text input. The `shadowalpha-portfolio`
  source uses this so a card can *select a specific curation*:
  `{ "field": "portfolioName", "op": "==", "value": "Momentum" }`. Its other
  fields (`portfolioWinRatePct`, `portfolioReturnPct`) let a card demand a
  track record: `{ "field": "portfolioWinRatePct", "op": ">=", "value": 60 }`.
- Reserved **`ta.*` fields** are per-symbol technical indicators from the
  `enrichment.ta` settings block (`src/enrichment/ta.ts`): configure
  indicators (`rsi`/`sma`/`macd`) and constrain the derived fields
  (`ta.rsi14`, `ta.sma50`, `ta.macdHist`) in any card —
  `{ "field": "ta.rsi14", "op": "<=", "value": 70 }`. Providers: `fixture`
  (offline demo) or `robinhood` (server-computed via
  `get_equity_technical_indicators`; needs `npm run robinhood:connect`).
  No data for a symbol → the constraint fails (fail closed), never guesses.

### Following a ShadowAlpha portfolio (curation)

```jsonc
// sources:
{ "type": "shadowalpha-portfolio", "transport": "live", "portfolios": ["Momentum"] }
```

The adapter polls `get_portfolio_signals` per configured portfolio with a
cursor seeded from `latest_trade_id` (only trades from now on become signals),
turns upstream entries into bullish `curation` signals and closes into bearish
advisories, and skips option legs and non-equity symbols (long-only US
equities v1). `GET /api/portfolios` feeds the dashboard's picker from
`list_portfolios`. One source instance handles many portfolios — list them in
`portfolios`, don't duplicate the source.

## Writing a profile

A profile is a JSON settings file — see `profiles/*.json` and the schema in
`src/settings/schema.ts` (every field is documented inline, every default is
the safe one). Rules the loader enforces, fail-closed:

- Scenario 1/2 profiles must set `mode` and `execution` explicitly.
- Scenario 2 profiles must keep at least one programmatic stop
  (`stopLossPct` or `trailingStopPct`).
- Any cap may be `null` (disabled) — that is the user's right and their risk.
- Credentials never go in a profile. They are environment variables
  (`SHADOWALPHA_MCP_TOKEN`, `ANTHROPIC_API_KEY`), referenced by the code.

Two throttles worth knowing when tuning proposal volume: `marketHoursOnly`
suppresses proposal *creation* off-hours (intake pauses entirely) as well as
deferring entry execution — exits always run; and the rejection cooldowns
(`entry.rejectionCooldownMinutes`, default 30; `exit.rejectionCooldownMinutes`,
default off) keep a just-rejected symbol+action from being re-proposed until
the window passes.

A plain-language strategy like "trade ShadowAlpha consensus like scenario 2
with a 7% trailing stop, $25 a position, never more than 4 names" maps 1:1
onto a profile. That's the point.

## Editing the strategy as an AI agent (behind the scenes)

The profile file IS the agent interface. If you're the user's coding agent and
they ask you to change the strategy — "only buy analyst-backed names", "tighten
the stop to 5%", "follow my Momentum curation" — edit the **active profile
file** directly:

1. **Round-trip the whole document.** Read the profile, change fields, write
   the full object back. Never write a partial document — scenario-1/2 preset
   precedence checks for explicit `mode`/`execution` keys.
2. **Validate before you're done:** `npm run validate-profile -- <path>`. Exit
   0 means the engine will both load and boot it; exit 1 prints the exact
   issues (same fail-closed path the engine uses).
3. **Tell the user to restart.** Saves apply on restart, not live. If the
   engine is running with the dashboard, your edit appears there within ~2s as
   a "settings changed — restart to apply" banner with a diff.

This is also what the dashboard's Settings panel does under the hood — same
file, same validation. There is a project skill (`.claude/skills/edit-strategy`)
with the field reference an agent needs.
