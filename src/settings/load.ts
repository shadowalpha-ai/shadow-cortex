/**
 * Fail-closed settings loader.
 *
 * - No profile file        → SAFE_DEFAULTS (scenario 3, paper, execution off).
 * - Invalid profile file   → refuse to run with a clear error. Never fail
 *                            open into live or uncapped execution.
 *
 * All validation logic lives in ./validate.ts — the dashboard API and the
 * validate-profile CLI share the exact same path, so what loads here is what
 * validates there, word for word.
 */

import { readFileSync, existsSync } from "node:fs";
import { SettingsSchema, type Settings } from "./schema.js";
import { formatIssues, parseSettingsDocument } from "./validate.js";
import { log } from "../core/log.js";

/** The shipped safe posture: paper, execution off, deterministic decider, conservative caps. */
export function SAFE_DEFAULTS(): Settings {
  return SettingsSchema.parse({});
}

export class SettingsError extends Error {}

export interface LoadedProfile {
  settings: Settings;
  /** The raw document as it sits on disk (null when running SAFE_DEFAULTS). */
  raw: unknown | null;
  path: string | null;
}

export function loadProfile(profilePath?: string): LoadedProfile {
  if (!profilePath) {
    log.warn("No --profile given — running SAFE_DEFAULTS (scenario 3, paper, execution off).");
    return { settings: SAFE_DEFAULTS(), raw: null, path: null };
  }
  if (!existsSync(profilePath)) {
    throw new SettingsError(`Profile not found: ${profilePath} — refusing to run (fail closed).`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    throw new SettingsError(
      `Profile ${profilePath} is not valid JSON — refusing to run (fail closed). ${String(err)}`,
    );
  }

  const result = parseSettingsDocument(raw);
  if (!result.ok) {
    throw new SettingsError(
      `Profile ${profilePath} failed validation — refusing to run (fail closed):\n` +
        formatIssues(result.issues),
    );
  }
  return { settings: result.settings, raw, path: profilePath };
}

export function loadSettings(profilePath?: string): Settings {
  return loadProfile(profilePath).settings;
}
