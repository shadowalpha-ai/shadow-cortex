import { useCallback, useEffect, useState } from "react";
import type { ApiError, SaveResult, SettingsResponse, ValidationIssue } from "./types";

async function readError(res: Response): Promise<ApiError["error"]> {
  try {
    return ((await res.json()) as ApiError).error;
  } catch {
    return { code: "http_error", message: `HTTP ${res.status}` };
  }
}

export function useSettings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as SettingsResponse);
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loadError, reload };
}

export interface SaveOutcome {
  ok: boolean;
  result?: SaveResult;
  issues?: ValidationIssue[];
  error?: string;
  needsConfirmAuto?: boolean;
  revisionConflict?: boolean;
}

export async function validateDocument(
  document: unknown,
): Promise<{ ok: true; diff: unknown[] } | { ok: false; issues: ValidationIssue[] }> {
  const res = await fetch("/api/settings/validate", {
    method: "POST",
    body: JSON.stringify({ settings: document }),
  });
  if (res.ok) {
    const body = (await res.json()) as { diff: unknown[] };
    return { ok: true, diff: body.diff };
  }
  const error = await readError(res);
  return { ok: false, issues: error.issues ?? [{ path: "(root)", message: error.message }] };
}

export async function saveDocument(
  document: unknown,
  opts: { confirmAuto?: boolean; ifRevision?: string | null } = {},
): Promise<SaveOutcome> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    // Attribution for the audit log: which client made this save.
    headers: { "x-shadow-cortex-client": "dashboard" },
    body: JSON.stringify({
      settings: document,
      ...(opts.confirmAuto ? { confirmAuto: true } : {}),
      ...(opts.ifRevision ? { ifRevision: opts.ifRevision } : {}),
    }),
  });
  if (res.ok) return { ok: true, result: (await res.json()) as SaveResult };

  const error = await readError(res);
  if (error.code === "confirm_auto_required") return { ok: false, needsConfirmAuto: true };
  if (error.code === "revision_conflict") return { ok: false, revisionConflict: true, error: error.message };
  if (error.issues) return { ok: false, issues: error.issues };
  return { ok: false, error: error.message };
}
