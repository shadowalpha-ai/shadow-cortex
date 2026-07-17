/**
 * Confirm channel for `execution: "confirm"` — the scenario 3 human gate.
 * Prompts are serialized so overlapping loop ticks never interleave questions.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Proposal } from "../core/types.js";

export interface ConfirmChannel {
  ask(proposal: Proposal, narrated: string): Promise<boolean>;
}

export class CliConfirmChannel implements ConfirmChannel {
  private queue: Promise<unknown> = Promise.resolve();

  ask(proposal: Proposal, narrated: string): Promise<boolean> {
    const next = this.queue.then(async () => {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await rl.question(`${narrated}\n  Confirm ${proposal.action} ${proposal.symbol}? [y/N] `);
        return answer.trim().toLowerCase() === "y";
      } finally {
        rl.close();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
