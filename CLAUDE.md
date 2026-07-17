# Shadow Cortex — Claude Instructions

Open-source, self-hosted TypeScript/Node template for an AI-managed automated
trading engine. Runs **locally only** — one user, their machine, their keys.
It is a reference implementation and free giveaway, not a hosted service and
not a supported product. Scope and design decisions live in the internal PRD
(`shadowalpha-engine-PRD.md`, kept out of the public repo — gitignored); the
README and docs/ carry everything a public contributor needs.

There is no production infrastructure for this project. Nothing here deploys
anywhere; "shipping" means cutting a public release of the repo.

## This repo is public — hygiene rules

- Never commit secrets, API keys, tokens, or session files. Settings reference
  credentials from env (`${VAR}`), never inline.
- Never commit internal ShadowAlpha business material (marketing strategy,
  pricing internals, customer data, prod hostnames/IPs).
- Captured broker payloads used as fixtures must be scrubbed first: account
  numbers, tokens, balances, real position sizes.

## Safety invariants (structural — never regress these)

- `SAFE_DEFAULTS`: paper mode, execution off, deterministic decider,
  conservative editable caps populated. Any change that weakens what an
  unconfigured `npm run dev` does is a bug.
- Settings validation fails **closed**: invalid or missing settings fall back
  to safe defaults or refuse to run — never fail open into live or uncapped
  execution.
- Deciders only emit `Proposal`s. Only the execution layer executes, and every
  gate (in-force caps, confirm gate, price band) is enforced there. No decider
  — including a full AI agent — can bypass or exceed an in-force cap.
- Exposure caps and the daily-loss halt gate entries only. Risk-reducing exits
  are never blocked by them.
- The user owns every cap value, including disabling caps. The engine's job is
  faithful enforcement of whatever is set, not imposing its own floor.
- The broker is the source of truth for positions: reconcile after every
  execution and on every management tick.
- Every proposal, confirm/reject, execution, and exit goes to the append-only
  audit log.
- The core is source-agnostic: nothing downstream of an adapter may depend on
  where a signal came from. `Signal` is the only contract the core knows.

## Engineering reflexes

- TypeScript strict mode; no `any` in the core data shapes.
- Everything external (source, broker, LLM, MCP client) sits behind an
  interface with a mock. `npm test` and `npm run dev` must work with zero
  credentials and no network.
- Loops handle errors **per-item, not per-cycle** — one bad signal or one
  failed broker call must not kill the run.
- Log at loop-cycle boundaries and around every external call; never log
  secrets (truncate or hash).
- Blast-radius check: before changing a core type (`Signal`, `Proposal`,
  `Position`, `Settings`), grep every adapter, decider, and test that consumes
  it and verify them.

## When compacting this conversation

Preserve: the list of modified files, any PRD/design decisions made this
session, and the state of in-progress refactors. Summarize exploration briefly.

## Routing — where the rest lives

- **Adding or modifying a signal source adapter** → the `source-adapters` skill.
- **Changing the trading strategy** (entry criteria/rules, exits, caps, sizing,
  decider, mode, sources) → the `edit-strategy` skill. Strategy lives in the
  active profile JSON; edits apply on restart.
- **Cutting a release / making anything public** → the `pre-release` skill.
- More skills (deciders, exit rules) get added as the codebase lands; until
  then, `docs/AUTHORING.md` and the PRD govern.

Prefer reviewable local skills over MCP servers for project workflows: skill
text can be read and audited; MCP servers are opaque.
