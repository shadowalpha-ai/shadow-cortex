/**
 * The settings tab. Edits the running configuration through a structured form
 * or a raw-JSON editor; both save through the same fail-closed API. Apply
 * semantics are save + restart: a successful save writes the profile file and
 * shows a restart banner — the running engine keeps its settings until you
 * restart it.
 */

import { useMemo, useState } from "react";
import type { SaveResult, Settings, ValidationIssue } from "../../types";
import { saveDocument, useSettings } from "../../useSettings";
import { SettingsForm } from "./SettingsForm";
import { JsonEditor } from "./JsonEditor";
import { ConfirmAutoModal } from "./ConfirmAutoModal";
import { ConnectionsPanel } from "./ConnectionsPanel";

export function SettingsView() {
  const { data, loadError, reload } = useSettings();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAuto, setPendingAuto] = useState<unknown | null>(null);

  // Initialize the draft from the running configuration once loaded.
  const baseline = data?.active ?? null;
  const activeDraft = draft ?? baseline;

  useMemo(() => {
    if (baseline && draft === null) setDraft(structuredClone(baseline));
  }, [baseline, draft]);

  if (loadError) return <p className="empty">Couldn't load settings: {loadError}</p>;
  if (!data || !activeDraft) return <p className="empty">Loading settings…</p>;

  const currentDocument = (): unknown => {
    if (mode === "json") return JSON.parse(jsonText);
    return activeDraft;
  };

  const doSave = async (confirmAuto: boolean) => {
    setIssues([]);
    setError(null);
    let document: unknown;
    try {
      document = currentDocument();
    } catch (err) {
      setError(`Invalid JSON: ${String(err)}`);
      return;
    }
    const outcome = await saveDocument(document, {
      confirmAuto,
      ifRevision: data.saved.revision,
    });
    if (outcome.ok && outcome.result) {
      setSaved(outcome.result);
      setPendingAuto(null);
      await reload();
    } else if (outcome.needsConfirmAuto) {
      setPendingAuto(document);
    } else if (outcome.revisionConflict) {
      setError("The profile changed on disk since you loaded it. Reload to see the current values.");
    } else if (outcome.issues) {
      setIssues(outcome.issues);
    } else {
      setError(outcome.error ?? "Save failed.");
    }
  };

  const switchMode = (next: "form" | "json") => {
    if (next === "json" && activeDraft) setJsonText(JSON.stringify(activeDraft, null, 2));
    if (next === "form") {
      try {
        setDraft(JSON.parse(jsonText) as Settings);
      } catch {
        /* keep the current draft if the JSON is mid-edit */
      }
    }
    setMode(next);
  };

  return (
    <div className="settings-view">
      <ConnectionsPanel />
      {data.savedProfileInvalid && (
        <div className="banner warn">
          Saved profile file is invalid and won't load on restart:
          <pre>{data.savedProfileInvalid}</pre>
        </div>
      )}
      {saved && (
        <div className="banner">
          Saved to <code>{saved.savedTo}</code>.{" "}
          {saved.pendingRestart
            ? "Restart the engine to apply these changes."
            : "This matches the running configuration."}
          {saved.restartHint && (
            <>
              {" "}
              Restart with <code>{saved.restartHint}</code>.
            </>
          )}
          {saved.diff.length > 0 && (
            <ul className="diff">
              {saved.diff.map((c, i) => (
                <li key={i}>
                  <code>{c.path}</code>: {JSON.stringify(c.from)} → {JSON.stringify(c.to)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="settings-toolbar">
        <div className="mode-toggle">
          <button className={mode === "form" ? "active" : ""} onClick={() => switchMode("form")}>
            Form
          </button>
          <button className={mode === "json" ? "active" : ""} onClick={() => switchMode("json")}>
            JSON
          </button>
        </div>
        <div className="toolbar-actions">
          <button onClick={reload}>Reload from disk</button>
          <button className="confirm" onClick={() => doSave(false)}>
            Save
          </button>
        </div>
      </div>

      {error && <div className="banner warn">{error}</div>}
      {issues.length > 0 && (
        <div className="banner warn">
          <strong>Cannot save — fix these first:</strong>
          <ul className="issues">
            {issues.map((i, idx) => (
              <li key={idx}>
                <code>{i.path}</code>: {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {mode === "form" ? (
        <SettingsForm
          draft={activeDraft}
          onChange={setDraft}
          catalog={data.fieldCatalog}
          constraints={data.constraints}
          issues={issues}
        />
      ) : (
        <JsonEditor text={jsonText} onChange={setJsonText} />
      )}

      {pendingAuto !== null && (
        <ConfirmAutoModal onConfirm={() => doSave(true)} onCancel={() => setPendingAuto(null)} />
      )}
    </div>
  );
}
