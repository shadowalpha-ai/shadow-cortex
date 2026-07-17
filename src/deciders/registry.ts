/**
 * Decider registry. Swapping how decisions get made = changing one settings
 * field. All deciders emit Proposal[] into the same guarded execution path.
 */

import type { Decider } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { RulesDecider } from "./rules.js";
import { createClaudeDecider } from "./claude.js";
import { log } from "../core/log.js";

export function buildDecider(settings: Settings): Decider {
  if (settings.decider === "claude") {
    const claude = createClaudeDecider(settings.claude.model);
    if (claude) return claude;
    log.warn(
      'Decider "claude" requested but ANTHROPIC_API_KEY is not set — ' +
        "falling back to the deterministic rules decider (fail closed).",
    );
  }
  return new RulesDecider();
}
