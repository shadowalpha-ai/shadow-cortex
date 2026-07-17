/**
 * Shadow Cortex — entry point.
 *
 *   npm run dev                                  # scenario 3 demo, fixtures, paper, execution off
 *   npm start -- --profile profiles/scenario2.json
 *
 * A profile IS a strategy: one settings file selected here. No profile means
 * SAFE_DEFAULTS (paper, execution off, deterministic decider).
 */

import { parseArgs } from "node:util";
import { loadProfile, SettingsError } from "./settings/load.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { log } from "./core/log.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
  },
});

try {
  const profile = loadProfile(values.profile);
  new Orchestrator(profile.settings, profile.path).start();
} catch (err) {
  if (err instanceof SettingsError) {
    log.error(err.message);
    process.exit(1);
  }
  throw err;
}
