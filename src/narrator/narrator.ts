/**
 * The AI narrator turns a proposal into a human-readable rationale. It
 * EXPLAINS; it never decides. Pluggable LLM client — and it MUST run with no
 * LLM configured, via the deterministic template fallback below.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Proposal } from "../core/types.js";
import { roundMoney } from "../core/normalize.js";
import { log } from "../core/log.js";

export class Narrator {
  private readonly client: Anthropic | null;

  constructor(private readonly model: string) {
    this.client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  }

  /** Deterministic template — always works, zero credentials. */
  template(proposal: Proposal): string {
    const p = proposal;
    const amount = `${p.suggestedShares} share${p.suggestedShares === 1 ? "" : "s"} @ ~$${roundMoney(p.referencePrice)}`;
    const stop = p.protectiveStop ? `, stop @ $${p.protectiveStop}` : "";
    return `${p.action.toUpperCase()} $${p.symbol} — ${p.rationale}. ${amount}${stop}. [${p.decider}]`;
  }

  async narrate(proposal: Proposal): Promise<string> {
    const fallback = this.template(proposal);
    if (!this.client) return fallback;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system:
          "Rewrite the given trade-proposal summary as one clear, factual sentence for a trader. " +
          "Keep every number exactly as given. No advice, no hype, no hedging boilerplate.",
        messages: [{ role: "user", content: fallback }],
      });
      const text = response.content.find((b) => b.type === "text");
      return text ? text.text.trim() : fallback;
    } catch (err) {
      // The narrator must never block the flow — explain with the template instead.
      log.error("Narrator LLM call failed — using template rationale", err);
      return fallback;
    }
  }
}
