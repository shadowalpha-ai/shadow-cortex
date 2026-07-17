---
name: edit-strategy
description: "Use when the user asks to change the trading strategy the engine runs: entry criteria / buy signals, exit stops/targets, risk caps, sizing, decider, paper/live mode, execution mode, sources, or cadence. Trigger on phrases like change the strategy, only buy when, add a rule, tighten the stop, raise the cap, follow a curation/portfolio, switch to auto, edit the profile. You edit the active profile JSON file directly; the dashboard reflects the change and the user restarts to apply."
---

# Editing the strategy (the profile file)

The strategy lives entirely in a **profile JSON file** (`profiles/*.json`, or
`profiles/custom.json` if the engine was started with no `--profile`). Editing
that file is how you change what the engine trades. The dashboard's Settings
panel writes the same file — you're using the same interface, from the shell.

## Procedure

1. **Find the active profile.** It's the `--profile` argument in how the engine
   was started (check `package.json` scripts / how the user runs it). The demo
   is `profiles/scenario3.json`. If unsure, ask.
2. **Read it, change it, write the WHOLE document back.** Never write a partial
   profile: scenario-1 and scenario-2 documents must carry explicit `mode` and
   `execution` keys or validation fails closed. Preserve every field you're not
   changing.
3. **Validate:** `npm run validate-profile -- <path>`. Exit 0 = the engine will
   load and boot it. Exit 1 prints the exact issues — fix them before stopping.
4. **Tell the user to restart** to apply (saves are not live). If the dashboard
   is open it shows a "settings changed — restart to apply" banner within ~2s.

## Entry criteria = rule cards over data fields

`entry.rules` is an array of cards (OR'd together); each card's `constraints`
are AND'd. Rule cards are the only entry model (defaults in src/entry/rules.ts).

```jsonc
{
  "label": "human-readable name",
  "source": "shadowalpha",        // or "shadowalpha-portfolio"; null = any
  "symbols": ["NVDA"],            // empty = any ticker
  "constraints": [
    { "field": "analystRating", "op": ">=", "value": 55 },
    { "field": "confidence",    "op": ">=", "value": 0.6 },
    { "field": "window.distinctSources", "op": ">=", "value": 2 }
  ]
}
```

- **Ops:** `== != >= > <= <`, and `has` (only on `window.types`).
- **Fields** = a source's published fields + universal (`type`, `strength`,
  `confidence`, `ageMinutes`) + symbol enrichment (`ta.*`, `conviction.*`,
  `predictions.*` — config-free: reference one and the engine computes it) +
  `window.*` aggregates. The complete generated reference — every datapoint
  with type, suggested default, and meaning — is `docs/DATAPOINTS.md`.
  Ground truth while the engine runs (with the user's actual portfolio names
  enumerated): GET `/api/settings` → `availableFieldCatalog`, or the
  `get_strategy` MCP tool.
- A missing field fails its constraint (fail closed). `entry.symbolBlocklist`
  is enforced first, always.

## Other common edits

- **Exit stops/targets:** `exit.stopLossPct` / `trailingStopPct` /
  `takeProfitPct` / `maxHoldDays` / `trailActivationPct` / `atrStopMultiplier`+`atrPeriod` / `breakevenDays`+`breakevenMinMovePct` / `partialTpPct`+`partialCloseFraction` — any may be `null` to disable. Scenario 2
  must keep at least one stop.
- **Caps:** `caps.maxSharesPerOrder` / `maxOpenPositions` /
  `maxDollarsPerPosition` / `maxDailyLoss` — any may be `null`. Caps gate
  entries only; exits are never blocked.
- **Sizing:** `sizing.mode` (`fixedDollar` | `fixedShares` | `percentOfEquity`)
  + `sizing.value`.
- **Decider:** `decider` (`rules` | `claude`; claude needs `ANTHROPIC_API_KEY`).
- **Execution:** `execution` (`off` | `confirm` | `auto`). Turning on `auto`
  makes the engine place orders without asking — confirm the user wants that.
- **Live trading is not available in v1** — `mode: "live"` and
  `quoteSource: "broker"` refuse to boot. Leave `mode: "paper"`.

## Hard rules

- Never put credentials in the profile — they're env vars
  (`SHADOWALPHA_MCP_TOKEN`, `ANTHROPIC_API_KEY`).
- Always validate before finishing. A profile that fails validation will
  strand the user at the next restart.
- Full field-by-field reference: `src/settings/schema.ts` (documented inline)
  and `docs/AUTHORING.md`.
