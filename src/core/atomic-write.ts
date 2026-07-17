/**
 * Crash-safe JSON persistence: write a tmp file, then atomically rename it
 * over the target, so a crash mid-write can never truncate state, strategy,
 * or credentials. The one implementation for every file the engine persists.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(
  path: string,
  value: unknown,
  opts: { mode?: number; trailingNewline?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(value, null, 2) + (opts.trailingNewline ? "\n" : "");
  writeFileSync(tmp, json, opts.mode !== undefined ? { mode: opts.mode } : {});
  renameSync(tmp, path);
  // writeFileSync's mode applies only on create — enforce on overwrite too.
  if (opts.mode !== undefined) chmodSync(path, opts.mode);
}
