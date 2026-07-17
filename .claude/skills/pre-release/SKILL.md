---
name: pre-release
description: "Use before tagging a release, publishing the repo or a version, or pushing anything intended for public consumption. Trigger on phrases like release, publish, tag a version, cut a release, push to GitHub, make it public. Covers the offline test gate, secret scan, safe-defaults check, and docs/disclaimer check."
---

# Pre-release checks

Run in order. All must pass before anything goes public.

1. **Offline gate** — `npx tsc --noEmit` and `npm test` pass with no
   credentials set and no network access. A fresh clone + `npm install &&
   npm run dev` starts in scenario 3, paper mode, confirm-gated execution
   (nothing executes without a click), against fixture data.

2. **Secret & internal-material scan** — over the working tree AND git history:
   - keys/tokens: grep for `sk-`, `Bearer `, `api_key`, `token`, private key
     headers, `.env` contents committed by mistake.
   - no internal ShadowAlpha business material, prod hostnames, or IPs.
   - broker payload fixtures scrubbed: account numbers, tokens, balances,
     real position sizes.

3. **Safe defaults intact** — `SAFE_DEFAULTS` still: paper mode, execution
   off, deterministic decider, conservative caps populated. Every example
   profile validates against the schema. Automation profiles (scenarios 1/2)
   still require explicit execution settings — a preset alone must never
   enable live or auto execution.

4. **Guard tests present and green** — the "no decider exceeds an in-force
   cap" suite and every execution-layer gate test, for entries AND exits.

5. **Docs** — README disclaimers present (not investment advice, own risk,
   unsupported reference implementation); setup instructions match reality;
   the authoring guide matches the current `Signal`/`Decider` contracts.
