/**
 * Raw-document editor — the power-user / paste-from-any-LLM path. Whatever you
 * paste is validated server-side on save through the exact same fail-closed
 * path as the form.
 */

import { useState } from "react";
import type { ValidationIssue } from "../../types";
import { validateDocument } from "../../useSettings";

export function JsonEditor({
  text,
  onChange,
}: {
  text: string;
  onChange: (text: string) => void;
}) {
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [ok, setOk] = useState(false);

  const check = async () => {
    setOk(false);
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (err) {
      setIssues([{ path: "(json)", message: String(err) }]);
      return;
    }
    const result = await validateDocument(document);
    if (result.ok) {
      setIssues(null);
      setOk(true);
    } else {
      setIssues(result.issues);
    }
  };

  return (
    <div className="json-editor">
      <textarea
        spellCheck={false}
        value={text}
        onChange={(e) => {
          onChange(e.target.value);
          setOk(false);
        }}
      />
      <div className="json-actions">
        <button type="button" onClick={check}>
          Validate
        </button>
        {ok && <span className="valid-badge">valid — safe to save</span>}
      </div>
      {issues && (
        <ul className="issues">
          {issues.map((i, idx) => (
            <li key={idx}>
              <code>{i.path}</code>: {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
