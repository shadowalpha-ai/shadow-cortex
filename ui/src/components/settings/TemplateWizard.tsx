/**
 * The template wizard — plain-English questions that fill in a complete rule
 * card. Opens when a template is picked from the "Add a rule" dropdown; on
 * Add, the parent enables any feed the template needs and appends the card.
 */

import { Modal } from "../Modal";
import { useState } from "react";
import type { RuleTemplate } from "./templates";

export function TemplateWizard({
  template,
  portfolioChoices,
  onApply,
  onCancel,
}: {
  template: RuleTemplate;
  portfolioChoices: string[];
  onApply: (answers: Record<string, number | string>) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number | string>>(() =>
    Object.fromEntries(
      template.questions.map((q) => [
        q.id,
        q.type === "portfolio" ? (portfolioChoices[0] ?? "") : q.defaultValue,
      ]),
    ),
  );
  const set = (id: string, value: number | string) => setAnswers({ ...answers, [id]: value });

  const portfolioQuestionUnanswerable = template.questions.some(
    (q) => q.type === "portfolio" && portfolioChoices.length === 0,
  );
  const incomplete = template.questions.some(
    (q) => q.type === "portfolio" && String(answers[q.id] ?? "") === "",
  );

  return (
    <Modal
      title={template.title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="reject" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="confirm"
            disabled={portfolioQuestionUnanswerable || incomplete}
            onClick={() => onApply(answers)}
          >
            Add rule
          </button>
        </>
      }
    >
        <p>{template.description}</p>

        {portfolioQuestionUnanswerable ? (
          <p className="card-warn">
            No portfolios available to pick from — connect ShadowAlpha (Settings → Connections)
            or check your portfolio list, then try again.
          </p>
        ) : (
          template.questions.map((q) => (
            <label className="field" key={q.id}>
              <span className="field-label">{q.label}</span>
              {q.type === "number" ? (
                <input
                  type="number"
                  step="any"
                  value={String(answers[q.id])}
                  onChange={(e) => set(q.id, Number(e.target.value))}
                />
              ) : (
                <select
                  value={String(answers[q.id])}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const opt = q.options?.find((o) => String(o.value) === raw);
                    set(q.id, opt ? opt.value : raw);
                  }}
                >
                  {q.type === "portfolio"
                    ? portfolioChoices.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))
                    : q.options?.map((o) => (
                        <option key={String(o.value)} value={String(o.value)}>
                          {o.label}
                        </option>
                      ))}
                </select>
              )}
              {q.help && <span className="field-hint">{q.help}</span>}
            </label>
          ))
        )}

    </Modal>
  );
}
