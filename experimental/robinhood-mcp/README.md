# Robinhood MCP broker adapter

**The adapter has graduated: it now lives at
[`src/execution/robinhood-broker.ts`](../../src/execution/robinhood-broker.ts)**
and is wired into the orchestrator (`mode: "live"` + `liveBroker: "robinhood"`,
after `npm run robinhood:connect`). This directory keeps the discovery
artifacts: `sample-payloads.json` (real scrubbed captures the read mappings
are pinned against) and this history.

It implements the same `Broker` interface as the PaperBroker
(`src/core/types.ts`). Because execution is one interface behind the gate,
swapping PaperBroker for it changes nothing upstream.

## Status: read mappings verified and WIRED — live mode boots

**Read-tool mappings are verified against real payloads** captured 2026-07-15
from a funded agentic account (`sample-payloads.json`, scrubbed; findings in
the [discovery readout](../../docs/robinhood-discovery.md)): the `{data,
guide}` response envelope, agentic-account discovery via `get_accounts`,
required `account_number` scoping, string numerics, the positions↔quotes
price join, and nested buying power are all real and tested
(`test/robinhood-broker.test.ts`). The technical-indicator response shape
was captured live 2026-07-17 and the TA provider is pinned to it. **Write-tool
(order) response shapes are still best-guess** — capturing them means placing
a real order, which stays behind an explicit human go-ahead; until then
`placeOrder` parses defensively and refuses on any review warning.

## Chosen workflow: Hybrid (engine reads, you approve writes)

- **Reads** — the engine calls `get_equity_positions` / `get_portfolio` through
  this adapter so the management loop runs programmatic exits against the
  positions you *actually* hold. This is what makes stops/trailing/targets real
  rather than paper.
- **Writes** — gated by execution mode. In `confirm` mode `placeOrder` fires
  only after you approve a proposal in the dashboard (or your AI agent
  approves it); in `auto` it fires within your caps. Either way it runs
  `review_equity_order` first and refuses on any warning.
- **Containment** — writes target the dedicated, user-funded **agentic
  account** only, and Robinhood enforces it: `get_accounts` flags exactly
  which account is agentic-enabled for this agent (`agentic_allowed`, verified
  caller-relative), and the adapter discovers that account itself rather than
  trusting configuration. Never widen this.

"Different AI models interface with the script" fits here: the engine is
model-agnostic. Your decider can be any model; your approval can come from you
or from any AI agent driving the dashboard — the engine just needs read access
to your real positions to manage exits.

## How it got finished (history)

1. ~~**Run the discovery readout**~~ — DONE for read tools (2026-07-15) and
   for `get_equity_technical_indicators` (2026-07-17); procedure and findings
   in [`docs/robinhood-discovery.md`](../../docs/robinhood-discovery.md).
2. ~~**Correct the mapping.**~~ — DONE: `sample-payloads.json` holds real
   scrubbed captures and `src/execution/robinhood-broker.ts` conforms, pinned
   by `npm test`.
3. ~~**Wire it on.**~~ — DONE: `liveBroker: "robinhood"` in the settings
   schema, `buildRobinhoodBroker` in the orchestrator, engine-side OAuth
   (`src/execution/robinhood-oauth.ts`, connected from the dashboard or
   `npm run robinhood:connect`). `mode: "live"` boots once connected and
   refuses (fail closed) until then.

**Still open:** order-response capture (one real reviewed+placed order, only
with an explicit user go-ahead) and long-run token-lifetime observation.

Fixtures used in tests must be scrubbed: no account numbers, tokens, balances,
or real position sizes.
