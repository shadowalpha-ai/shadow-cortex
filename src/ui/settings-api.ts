/**
 * Settings API logic behind the dashboard routes — kept separate from the
 * HTTP transport in server.ts.
 *
 * Apply semantics are save + restart: a successful PUT validates through the
 * exact same fail-closed path the boot loader uses, writes the profile file
 * atomically, and audits the change. The RUNNING engine keeps its in-memory
 * settings; `pendingRestart` tells the dashboard to show the banner. External
 * edits to the profile file (your Claude, any editor) are picked up via
 * mtime and surface the same way.
 */

import type { SignalSource } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { AuditLog } from "../core/audit.js";
import { ProfileStore } from "../settings/profile-store.js";
import {
  BROKER_QUOTES_REQUIRE_LIVE_BROKER,
  LIVE_MODE_NOT_CONNECTED,
  formatIssues,
  parseSettingsDocument,
  runnableIssues,
  type ValidationIssue,
} from "../settings/validate.js";
import { hasRobinhoodTokens } from "../execution/robinhood-oauth.js";
import { availableFieldCatalog } from "../enrichment/catalog.js";
import { canonicalEqual, diffSettings } from "../settings/diff.js";

export interface ApiResult {
  status: number;
  body: unknown;
}

function errorBody(code: string, message: string, issues?: ValidationIssue[]): unknown {
  return { error: { code, message, ...(issues ? { issues } : {}) } };
}

interface SavedState {
  raw: unknown | null;
  effective: Settings | null;
  /** Human-readable reason the on-disk profile won't load, if any. */
  invalid: string | null;
  revision: string | null;
  mtimeMs: number | null;
}

export class SettingsApi {
  private saved: SavedState = {
    raw: null,
    effective: null,
    invalid: null,
    revision: null,
    mtimeMs: null,
  };
  /** Serializes concurrent PUTs; the revision guard resolves true conflicts. */
  private putQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly active: Settings,
    private readonly profile: ProfileStore,
    private readonly audit: AuditLog,
    private readonly sources: SignalSource[],
  ) {
    this.refreshSaved();
  }

  // --- saved-state tracking (also drives the monitor banner) ---

  refreshSaved(): void {
    let raw: unknown | null;
    try {
      raw = this.profile.readRaw();
    } catch (err) {
      this.saved = {
        raw: null,
        effective: null,
        invalid: `profile file is not valid JSON: ${String(err)}`,
        revision: this.profile.revision(),
        mtimeMs: this.profile.mtimeMs(),
      };
      return;
    }
    if (raw === null) {
      this.saved = { raw: null, effective: null, invalid: null, revision: null, mtimeMs: null };
      return;
    }
    const parsed = parseSettingsDocument(raw);
    this.saved = {
      raw,
      effective: parsed.ok ? parsed.settings : null,
      invalid: parsed.ok ? null : `profile file would not load:\n${formatIssues(parsed.issues)}`,
      revision: this.profile.revision(),
      mtimeMs: this.profile.mtimeMs(),
    };
  }

  /** Cheap per-broadcast check: re-read the file only when its mtime moved. */
  refreshIfFileChanged(): void {
    if (this.profile.mtimeMs() !== this.saved.mtimeMs) this.refreshSaved();
  }

  pendingRestart(): boolean {
    return this.saved.effective !== null && !canonicalEqual(this.active, this.saved.effective);
  }

  savedProfileInvalid(): string | null {
    return this.saved.invalid;
  }

  // --- routes ---

  getSettings(): ApiResult {
    this.refreshSaved();
    return {
      status: 200,
      body: {
        // Freshness marker: AI clients quote this so a stale readout is
        // self-evident (a Desktop AI once reported yesterday's rules).
        asOf: new Date().toISOString(),
        active: this.active,
        saved: {
          raw: this.saved.raw,
          path: this.profile.path,
          exists: this.profile.exists(),
          revision: this.saved.revision,
        },
        pendingRestart: this.pendingRestart(),
        savedProfileInvalid: this.saved.invalid,
        diff: this.saved.effective ? diffSettings(this.active, this.saved.effective) : [],
        fieldCatalog: availableFieldCatalog(this.active),
        // null = the option is currently usable on this machine.
        constraints: {
          liveModeDisabledReason: this.liveModeDisabledReason(),
          brokerQuotesDisabledReason: this.liveModeDisabledReason()
            ? BROKER_QUOTES_REQUIRE_LIVE_BROKER
            : null,
        },
      },
    };
  }

  /** Why "live" can't be selected right now, or null when it can. */
  private liveModeDisabledReason(): string | null {
    if (!hasRobinhoodTokens(this.active.paths.robinhoodOauth)) return LIVE_MODE_NOT_CONNECTED;
    return null;
  }

  validate(body: unknown): ApiResult {
    const document = (body as { settings?: unknown })?.settings;
    const outcome = this.validateDocument(document);
    if (!outcome.ok) return outcome.error;
    return {
      status: 200,
      body: { ok: true, effective: outcome.settings, diff: diffSettings(this.active, outcome.settings) },
    };
  }

  put(body: unknown, client = "unknown"): Promise<ApiResult> {
    const run = this.putQueue.then(() => this.putLocked(body, client));
    this.putQueue = run.catch(() => undefined);
    return run;
  }

  private putLocked(body: unknown, client: string): ApiResult {
    const request = body as {
      settings?: unknown;
      confirmAuto?: boolean;
      ifRevision?: string;
    };

    const outcome = this.validateDocument(request?.settings);
    if (!outcome.ok) {
      this.audit.write("settings_change_rejected", { issues: outcome.issues });
      return outcome.error;
    }
    const next = outcome.settings;

    // Turning autonomous execution ON requires explicit, structural consent.
    const previousExecution = this.saved.effective?.execution ?? this.active.execution;
    if (next.execution === "auto" && previousExecution !== "auto" && request.confirmAuto !== true) {
      return {
        status: 409,
        body: errorBody(
          "confirm_auto_required",
          'Switching execution to "auto" makes the engine place orders without asking. ' +
            "Re-send with confirmAuto: true to confirm.",
        ),
      };
    }

    if (request.ifRevision !== undefined && request.ifRevision !== this.profile.revision()) {
      return {
        status: 409,
        body: errorBody(
          "revision_conflict",
          "The profile file changed since you loaded it — reload from disk and re-apply your edits.",
        ),
      };
    }

    const previousEffective = this.saved.effective ?? this.active;
    this.profile.writeAtomic(request.settings);
    this.refreshSaved();

    const diff = diffSettings(previousEffective, next);
    // `client` answers "who saved this?" during postmortems — the 2026-07-16
    // rule inversion was unattributable without it.
    this.audit.write("settings_changed", { path: this.profile.path, diff, client });

    return {
      status: 200,
      body: {
        ok: true,
        savedTo: this.profile.path,
        revision: this.saved.revision,
        pendingRestart: this.pendingRestart(),
        diff: diffSettings(this.active, next),
        ...(this.profile.wasExplicit
          ? {}
          : { restartHint: `npm start -- --profile ${this.profile.path}` }),
      },
    };
  }

  /** Shared by validate + put: schema/preset rules AND boot viability. */
  private validateDocument(
    document: unknown,
  ):
    | { ok: true; settings: Settings }
    | { ok: false; issues: ValidationIssue[]; error: ApiResult } {
    if (document === undefined) {
      const issues = [{ path: "(root)", message: 'body must be { "settings": { ... } }' }];
      return {
        ok: false,
        issues,
        error: { status: 400, body: errorBody("invalid_body", "missing settings document", issues) },
      };
    }
    const parsed = parseSettingsDocument(document);
    if (!parsed.ok) {
      return {
        ok: false,
        issues: parsed.issues,
        error: {
          status: 400,
          body: errorBody("invalid_settings", "the profile failed validation", parsed.issues),
        },
      };
    }
    const boot = runnableIssues(parsed.settings);
    if (boot.length > 0) {
      return {
        ok: false,
        issues: boot,
        error: {
          status: 400,
          body: errorBody("invalid_settings", "the profile would refuse to boot", boot),
        },
      };
    }
    return { ok: true, settings: parsed.settings };
  }
}
