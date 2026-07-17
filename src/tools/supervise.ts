/**
 * Supervisor — what `npm run dev` / `npm start` actually run. Spawns the
 * engine and respawns it whenever it exits with RESTART_EXIT_CODE (the
 * dashboard's Restart button). Any other exit — Ctrl+C, a crash, a settings
 * refusal — ends the supervisor with the same code, so behavior is otherwise
 * identical to running the engine directly.
 */

import { spawnSync } from "node:child_process";
import { RESTART_EXIT_CODE } from "../core/restart.js";

const args = process.argv.slice(2);

for (;;) {
  const result = spawnSync("npx", ["tsx", "src/index.ts", ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === RESTART_EXIT_CODE) {
    console.log("[supervise] restart requested — respawning the engine…");
    continue;
  }
  process.exit(result.status ?? 1);
}
