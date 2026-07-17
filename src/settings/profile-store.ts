/**
 * The active profile file on disk — the strategy's single source of truth,
 * and the interface agents edit. When the engine boots with SAFE_DEFAULTS
 * (no --profile), dashboard saves land in profiles/custom.json; the engine
 * NEVER auto-adopts that file on a later profile-less boot — that would
 * silently change what an unconfigured run does.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeJsonAtomic } from "../core/atomic-write.js";

const DEFAULT_SAVE_PATH = "profiles/custom.json";

export class ProfileStore {
  readonly path: string;
  /** false = the engine booted without --profile; saves need a restart hint. */
  readonly wasExplicit: boolean;

  constructor(path: string | null) {
    this.path = path ?? DEFAULT_SAVE_PATH;
    this.wasExplicit = path !== null;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /** The raw document, or null when the file doesn't exist. Throws on bad JSON. */
  readRaw(): unknown | null {
    if (!this.exists()) return null;
    return JSON.parse(readFileSync(this.path, "utf8"));
  }

  /** sha-256 of the file bytes — the optimistic-concurrency revision. */
  revision(): string | null {
    if (!this.exists()) return null;
    return createHash("sha256").update(readFileSync(this.path)).digest("hex");
  }

  mtimeMs(): number | null {
    if (!this.exists()) return null;
    return statSync(this.path).mtimeMs;
  }

  /** tmp + rename so a crash never truncates the user's strategy. */
  writeAtomic(raw: unknown): void {
    writeJsonAtomic(this.path, raw, { trailingNewline: true });
  }
}
