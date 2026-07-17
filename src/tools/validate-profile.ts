/**
 * Standalone profile validator — the check an agent (or a human) runs after
 * editing a profile file, without booting the engine:
 *
 *   npm run validate-profile -- profiles/my-strategy.json
 *
 * Exit 0 = the engine will load AND boot this profile. Exit 1 = it won't,
 * with the same issues the engine itself would report.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  formatIssues,
  parseSettingsDocument,
  runnableIssues,
  type ValidationIssue,
} from "../settings/validate.js";

export type ProfileCheck = { ok: true } | { ok: false; issues: ValidationIssue[] };

export function checkProfileFile(path: string): ProfileCheck {
  if (!existsSync(path)) {
    return { ok: false, issues: [{ path: "(file)", message: `not found: ${path}` }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, issues: [{ path: "(file)", message: `not valid JSON: ${String(err)}` }] };
  }
  const parsed = parseSettingsDocument(raw);
  if (!parsed.ok) return parsed;
  const boot = runnableIssues(parsed.settings);
  return boot.length > 0 ? { ok: false, issues: boot } : { ok: true };
}

// CLI entry (skipped when imported by tests).
if (process.argv[1]?.endsWith("validate-profile.ts")) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npm run validate-profile -- <profile.json>");
    process.exit(1);
  }
  const result = checkProfileFile(target);
  if (result.ok) {
    console.log(`${target}: valid — the engine will load and run this profile.`);
  } else {
    console.error(`${target}: INVALID — the engine would refuse this profile:`);
    console.error(formatIssues(result.issues));
    process.exit(1);
  }
}
