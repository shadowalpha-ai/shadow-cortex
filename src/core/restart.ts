/**
 * The exit code that means "restart me": the dashboard's Restart button makes
 * the engine exit with this, and the supervisor (src/tools/supervise.ts, what
 * `npm run dev`/`npm start` actually run) respawns it. Any other exit code
 * ends the supervisor too.
 */
export const RESTART_EXIT_CODE = 42;
