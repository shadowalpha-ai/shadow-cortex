---
name: source-adapters
description: "Use when adding or modifying a signal source adapter for the engine: connecting a new upstream (MCP server, API, webhook), normalizing external data into Signal objects, or changing an existing adapter's mapping. Trigger on phrases like add a source, new adapter, connect [service], normalize signals, poller."
---

# Source adapters

A source adapter turns one upstream into `Signal[]`. The core never learns
anything about the upstream — if downstream code needs to know where a signal
came from beyond `signal.source`, the adapter is wrong.

## The contract

- One ingestion mode: a **poller** — the engine calls `poll()` on the intake
  cadence and the adapter returns normalized `Signal[]`.
- Emit the locked `Signal` shape: `{ symbol, type, direction, strength (0..1),
  source, timestamp, confidence?, dedupeKey, raw }`.
- Use the core normalization helpers for dedupe-key generation, direction
  mapping, and strength scaling — never reimplement them per adapter.
- Preserve the untouched upstream payload in `Signal.raw`.

## Required in every adapter

- A header comment stating the normalization assumptions: what maps to
  bullish/bearish, and how strength is scaled to 0..1. A human must be able to
  sanity-check the mapping without reading the code.
- Fallible by contract: handle auth expiry, rate limits, and partial or empty
  responses without throwing out of the loop. Validate fields — never trust
  upstream data (null-rendered-as-`0.0` traps).
- Injectable client: the adapter takes its HTTP/MCP client as a constructor
  argument so tests run against fixtures with zero credentials.
- Self-registration: the adapter drops into the sources directory/manifest;
  the core stays untouched.

## Tests that must accompany a new adapter

- Normalization: representative upstream fixture → expected `Signal[]`.
- Dedupe: the same upstream event ingested twice → one signal survives.
- Failure modes: empty response, malformed payload, auth-error response — no
  crash, no bogus signals emitted.

Once `docs/AUTHORING.md` exists in the repo, keep this skill and that guide in
sync — the guide is the public-facing version of this contract.
