/**
 * The entry-criteria builder. Each rule card reads as a sentence:
 *
 *   WHEN a signal arrives from [feed] for [symbols]
 *   AND ALL of the following hold:
 *     [data source ▾] [datapoint ▾] [op ▾] [value]
 *     …
 *
 * Cards OR together (visual "or" divider); conditions AND. The two-step
 * source→datapoint picker is pure presentation — the persisted constraint
 * stays {field, op, value}; the category derives from the field's prefix
 * (see ruleCategories.ts). Everything is draft-aware: toggles in Data
 * sources light up or grey out options here instantly, and any condition
 * the engine's fail-closed evaluation would silently never match gets a
 * visible warning saying exactly why.
 */

import { useState } from "react";
import { usePortfolios } from "../../usePortfolios";
import type { Constraint, ConstraintOp, EntryRule, FieldCatalog, FieldDef, Settings } from "../../types";
import { defaultFeedBlock, feedLabelWithProvider } from "./feeds";
import { RULE_TEMPLATES, type RuleTemplate } from "./templates";
import { TemplateWizard } from "./TemplateWizard";
import {
  categoriesForCard,
  categoryForField,
  draftState,
  findFieldDef,
  lintConstraint,
  type Category,
  type DraftState,
} from "./ruleCategories";

const NUMERIC_OPS: ConstraintOp[] = [">=", ">", "<=", "<", "==", "!="];
const STRING_OPS: ConstraintOp[] = ["==", "!="];
const LIST_OPS: ConstraintOp[] = ["has"];

function opsForKind(kind: FieldDef["kind"], isWindowList: boolean): ConstraintOp[] {
  if (isWindowList) return LIST_OPS;
  if (kind === "number") return NUMERIC_OPS;
  if (kind === "boolean") return ["=="];
  return STRING_OPS;
}

function defaultConstraintFor(def: FieldDef | undefined, field: string): Constraint {
  const isList = field === "window.types";
  const kind = def?.kind ?? "number";
  const op = def?.defaultOp ?? opsForKind(kind, isList)[0]!;
  let value: Constraint["value"];
  if (def?.defaultValue !== undefined) value = def.defaultValue;
  else if (isList || kind === "string") value = def?.values?.[0] ?? "";
  else if (kind === "boolean") value = true;
  else value = 0;
  return { field, op, value };
}

function coerceValue(raw: string, kind: FieldDef["kind"]): number | string | boolean {
  if (kind === "number") return Number(raw);
  if (kind === "boolean") return raw === "true";
  return raw;
}

export function EntryRulesEditor({
  entry,
  draft,
  catalog,
  onChange,
  onChangeDraft,
}: {
  entry: Settings["entry"];
  draft: Settings;
  catalog: FieldCatalog;
  onChange: (entry: Settings["entry"]) => void;
  onChangeDraft: (next: Settings) => void;
}) {
  const rules = entry.rules;
  const state = draftState(draft);
  const setRules = (next: EntryRule[]) => onChange({ ...entry, rules: next });
  const updateRule = (i: number, rule: EntryRule) =>
    setRules(rules.map((r, idx) => (idx === i ? rule : r)));

  // Portfolio names for the copy-trade template (live list when connected,
  // fixture list otherwise; falls back to the draft's configured names).
  const portfolioChoices = usePortfolios()
    .filter((x) => x.name && x.status !== "paused")
    .map((x) => x.name!);
  const copyTradeChoices = portfolioChoices.length > 0 ? portfolioChoices : state.portfolios;

  const [activeTemplate, setActiveTemplate] = useState<RuleTemplate | null>(null);

  /**
   * Apply a completed template: enable any feed it needs, follow the chosen
   * portfolio when there is one, and append the built card — one action.
   */
  const applyTemplate = (template: RuleTemplate, answers: Record<string, number | string>) => {
    let sources = draft.sources;
    const anyLive = sources.some((s) => s.transport === "live");
    for (const feed of template.requiresFeeds) {
      if (!sources.some((s) => s.type === feed)) {
        sources = [...sources, defaultFeedBlock(feed as Parameters<typeof defaultFeedBlock>[0], anyLive ? "live" : "fixture")];
      }
    }
    const portfolioAnswer = template.questions.find((q) => q.type === "portfolio");
    if (portfolioAnswer) {
      const portfolio = String(answers[portfolioAnswer.id]);
      sources = sources.map((s) =>
        s.type === "shadowalpha-portfolio" && !s.portfolios.includes(portfolio)
          ? { ...s, portfolios: [...s.portfolios, portfolio] }
          : s,
      );
    }
    onChangeDraft({
      ...draft,
      sources,
      entry: { ...draft.entry, rules: [...rules, template.build(answers)] },
    });
    setActiveTemplate(null);
  };

  return (
    <div className="entry-rules">
      {state.enabledFeeds.size === 0 && (
        <p className="card-warn">
          No signal feeds are enabled in Data sources — no rule can trigger.
        </p>
      )}
      {rules.map((rule, i) => (
        <div key={i} className="rule-card-slot">
          {i > 0 && <div className="or-divider">or</div>}
          <RuleCard
            rule={rule}
            state={state}
            catalog={catalog}
            onChange={(r) => updateRule(i, r)}
            onRemove={() => setRules(rules.filter((_, idx) => idx !== i))}
            onDuplicate={() =>
              setRules([...rules.slice(0, i + 1), { ...rule, label: `${rule.label} copy` }, ...rules.slice(i + 1)])
            }
          />
        </div>
      ))}
      <div className="template-bar">
        <select
          className="template-select"
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            if (id === "custom") {
              setRules([
                ...rules,
                {
                  label: `rule ${rules.length + 1}`,
                  source: null,
                  symbols: [],
                  constraints: [{ field: "strength", op: ">=", value: 0.6 }],
                },
              ]);
              return;
            }
            const template = RULE_TEMPLATES.find((t) => t.id === id);
            if (template) setActiveTemplate(template);
          }}
        >
          <option value="">+ Add a rule…</option>
          {RULE_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
          <option value="custom">Custom (blank rule)</option>
        </select>
        <span className="field-hint">
          Templates ask a couple of questions and set everything up — feeds included. Save +
          restart to apply.
        </span>
      </div>

      {activeTemplate && (
        <TemplateWizard
          template={activeTemplate}
          portfolioChoices={copyTradeChoices}
          onApply={(answers) => applyTemplate(activeTemplate, answers)}
          onCancel={() => setActiveTemplate(null)}
        />
      )}
    </div>
  );
}

function RuleCard({
  rule,
  state,
  catalog,
  onChange,
  onRemove,
  onDuplicate,
}: {
  rule: EntryRule;
  state: DraftState;
  catalog: FieldCatalog;
  onChange: (r: EntryRule) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const categories = categoriesForCard(catalog, state, rule.source);
  const knownFeeds = Object.keys(catalog.bySource);
  const triggerUnknown = rule.source !== null && !knownFeeds.includes(rule.source);
  const triggerOff = rule.source !== null && !triggerUnknown && !state.enabledFeeds.has(rule.source);

  const setConstraint = (i: number, c: Constraint) =>
    onChange({ ...rule, constraints: rule.constraints.map((x, idx) => (idx === i ? c : x)) });

  return (
    <div className="group-card">
      <div className="card-head">
        <input
          className="rule-label"
          value={rule.label}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
        />
        <div className="card-actions">
          <button type="button" onClick={onDuplicate}>
            Duplicate
          </button>
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      <p className="catalog-heading">When a signal arrives</p>
      <div className="rule-when">
        <span className="word">from</span>
        <select
          value={rule.source ?? ""}
          onChange={(e) => onChange({ ...rule, source: e.target.value || null })}
        >
          <option value="">any enabled feed</option>
          {triggerUnknown && <option value={rule.source!}>{rule.source} (unknown feed)</option>}
          {knownFeeds.map((s) => (
            <option key={s} value={s} disabled={!state.enabledFeeds.has(s)}>
              {feedLabelWithProvider(s)}
              {!state.enabledFeeds.has(s) ? " (off — enable in Data sources)" : ""}
            </option>
          ))}
        </select>
        {rule.source === "shadowalpha" && state.minStrength !== null && (
          <span className="word" title="The source drops weaker signals before they reach any rule — set in Data sources">
            at strength ≥ {state.minStrength}
          </span>
        )}
        {rule.source === "shadowalpha-portfolio" && (
          <>
            <span className="word">following</span>
            {state.portfolios.length > 0 ? (
              state.portfolios.map((p) => (
                <span key={p} className="chip" title="Followed portfolios are picked in Data sources">
                  {p}
                </span>
              ))
            ) : (
              <span className="word">(none yet)</span>
            )}
          </>
        )}
        <span className="word">for</span>
        <TickerChips values={rule.symbols} onChange={(symbols) => onChange({ ...rule, symbols })} />
      </div>
      {(triggerOff || triggerUnknown) && (
        <p className="card-warn">
          {triggerUnknown
            ? `"${rule.source}" isn't a known feed — this card will never match.`
            : "This feed is off — the card will never match (enable it in Data sources)."}
        </p>
      )}
      {rule.source === "shadowalpha-portfolio" &&
        !triggerOff &&
        !triggerUnknown &&
        state.portfolios.length === 0 && (
          <p className="card-warn">
            No portfolios are followed — pick at least one in Data sources, or this card can
            never fire.
          </p>
        )}

      <p className="catalog-heading">And all of the following hold</p>
      <div className="constraints">
        {rule.constraints.map((c, i) => (
          <ConditionRow
            key={i}
            constraint={c}
            categories={categories}
            catalog={catalog}
            state={state}
            source={rule.source}
            onChange={(next) => setConstraint(i, next)}
            onRemove={() =>
              onChange({ ...rule, constraints: rule.constraints.filter((_, idx) => idx !== i) })
            }
            removable={true}
          />
        ))}
        {rule.constraints.length === 0 && (
          <span className="field-hint">
            {rule.source === "shadowalpha-portfolio" && state.portfolios.length > 0
              ? `No conditions — every buy made by ${state.portfolios.join(" or ")} is copied as a proposal. Your caps, blocklist, and cooldowns still apply.`
              : "No conditions — every signal from the trigger proposes a buy. Your caps, blocklist, and cooldowns still apply."}
          </span>
        )}
        <button
          type="button"
          className="add-row"
          onClick={() =>
            onChange({ ...rule, constraints: [...rule.constraints, { field: "strength", op: ">=", value: 0.5 }] })
          }
        >
          + condition
        </button>
      </div>

      <p className="rule-preview">{describeRule(rule, state.portfolios)}</p>
    </div>
  );
}

function ConditionRow({
  constraint,
  categories,
  catalog,
  state,
  source,
  onChange,
  onRemove,
  removable,
}: {
  constraint: Constraint;
  categories: Category[];
  catalog: FieldCatalog;
  state: DraftState;
  source: string | null;
  onChange: (c: Constraint) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const categoryId = categoryForField(constraint.field);
  const category = categories.find((c) => c.id === categoryId)!;
  const def = findFieldDef(constraint.field, categories);
  const isWindowList = constraint.field === "window.types";
  // Unknown fields (hand-edited profiles) keep a sensible editor: infer the
  // kind from the stored value rather than assuming number.
  const kind: FieldDef["kind"] = def?.kind ?? (typeof constraint.value as FieldDef["kind"]);
  const warning = lintConstraint(constraint, categories, catalog, state, source);
  const fieldKnown = def !== undefined;

  const switchCategory = (id: string) => {
    const next = categories.find((c) => c.id === id);
    const firstGroup = next?.groups.find((g) => g.enabled && g.fields.length > 0);
    const firstField = firstGroup?.fields[0];
    if (!firstField) return; // nothing selectable in that category — ignore
    onChange(defaultConstraintFor(firstField, firstField.name));
  };

  const switchField = (name: string) => {
    onChange(defaultConstraintFor(findFieldDef(name, categories), name));
  };

  return (
    <div className="condition">
      <div className="predicate-row">
        <select value={categoryId} onChange={(e) => switchCategory(e.target.value)}>
          {categories.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.enabled && c.id !== categoryId}>
              {c.label}
              {!c.enabled ? ` (${c.disabledHint})` : ""}
            </option>
          ))}
        </select>

        <select value={constraint.field} onChange={(e) => switchField(e.target.value)}>
          {!fieldKnown && <option value={constraint.field}>{constraint.field} (unknown)</option>}
          {category.groups.map((group) =>
            group.fields.length === 0 ? null : (
              <optgroup
                key={group.label}
                label={group.enabled ? group.label : `${group.label} (${group.disabledHint})`}
              >
                {group.fields.map((f) => (
                  <option key={f.name} value={f.name} disabled={!group.enabled}>
                    {f.name}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>

        <select
          value={constraint.op}
          onChange={(e) => onChange({ ...constraint, op: e.target.value as ConstraintOp })}
        >
          {opsForKind(kind, isWindowList).map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>

        {kind === "boolean" ? (
          <select
            value={String(constraint.value)}
            onChange={(e) => onChange({ ...constraint, value: e.target.value === "true" })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : kind === "string" && def?.values?.length ? (
          // Enumerated field (e.g. configured portfolio names) → pick, don't type.
          <select
            value={String(constraint.value)}
            onChange={(e) => onChange({ ...constraint, value: e.target.value })}
          >
            {!def.values.includes(String(constraint.value)) && (
              <option value={String(constraint.value)}>{String(constraint.value) || "choose…"}</option>
            )}
            {def.values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={kind === "number" ? "number" : "text"}
            step="any"
            value={String(constraint.value)}
            onChange={(e) => onChange({ ...constraint, value: coerceValue(e.target.value, kind) })}
          />
        )}

        <button type="button" className="remove-row" onClick={onRemove} disabled={!removable}>
          ×
        </button>
      </div>
      {warning ? (
        <span className="constraint-warn">⚠ {warning}</span>
      ) : (
        def?.description && <span className="field-hint">{def.description}</span>
      )}
    </div>
  );
}

function TickerChips({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips-input">
      {values.length === 0 && <span className="field-hint">any symbol —</span>}
      {values.map((v) => (
        <span key={v} className="chip removable">
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        placeholder="add ticker…"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
            if (v && !values.includes(v)) onChange([...values, v]);
            (e.target as HTMLInputElement).value = "";
          }
        }}
      />
    </div>
  );
}

/** Plain-English readback — client-only, mirrors the engine's describeRule intent. */
function describeRule(rule: EntryRule, followedPortfolios: string[] = []): string {
  // The portfolio feed is scoped by which curations you follow (Data sources),
  // so the readback names them — unless a portfolioName condition narrows it.
  const followScope =
    rule.source === "shadowalpha-portfolio" &&
    followedPortfolios.length > 0 &&
    !rule.constraints.some((c) => c.field === "portfolioName")
      ? ` (following ${followedPortfolios.join(" and ")})`
      : "";
  const scope = [
    rule.source
      ? `a ${feedLabelWithProvider(rule.source)} signal${followScope}`
      : "a signal from any enabled feed",
    rule.symbols.length ? `on ${rule.symbols.join("/")}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (rule.constraints.length === 0) return `Buy on every ${scope}.`;
  // String comparisons read as words ("portfolioName is not X"), because
  // "!=" glyphs are exactly how an exclusion once hid in plain sight.
  const opWord = (c: Constraint) =>
    typeof c.value === "string" ? (c.op === "==" ? "is" : c.op === "!=" ? "is not" : c.op) : c.op;
  const parts = rule.constraints.map(
    (c) => `${describeField(c.field)} ${opWord(c)} ${c.value}`,
  );
  return `Buy when ${scope} has ${parts.join(" and ")}.`;
}

function describeField(field: string): string {
  const dot = field.indexOf(".");
  return dot === -1 ? field : `${field.slice(0, dot)} ${field.slice(dot + 1)}`;
}
