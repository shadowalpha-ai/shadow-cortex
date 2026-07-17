/** Small controlled form primitives shared across the settings panel. */

import type { ReactNode } from "react";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  hint,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  step?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        step={step ?? "any"}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

/** A number that can be disabled (null) — every cap and stop uses this. */
export function NullableNumberField({
  label,
  value,
  onChange,
  hint,
  enabledDefault = 0,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
  enabledDefault?: number;
}) {
  const enabled = value !== null;
  return (
    <Field label={label} hint={hint}>
      <div className="nullable">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? enabledDefault : null)}
        />
        <input
          type="number"
          step="any"
          disabled={!enabled}
          value={enabled ? value : ""}
          placeholder="disabled"
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </Field>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
  disabledOptions,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hint?: string;
  disabledOptions?: Set<T>;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const opt = options.find((o) => String(o.value) === raw);
          if (opt) onChange(opt.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} disabled={disabledOptions?.has(o.value)}>
            {o.label}
            {disabledOptions?.has(o.value) ? " (unavailable)" : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ToggleField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </Field>
  );
}

/** Comma / enter separated chips — for tickers, handles, signal types. */
export function ChipListInput({
  label,
  values,
  onChange,
  placeholder,
  hint,
  uppercase,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
  uppercase?: boolean;
}) {
  const add = (raw: string) => {
    const cleaned = raw.trim();
    if (!cleaned) return;
    const v = uppercase ? cleaned.toUpperCase() : cleaned;
    if (!values.includes(v)) onChange([...values, v]);
  };
  return (
    <Field label={label} hint={hint}>
      <div className="chips-input">
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
          placeholder={placeholder ?? "add…"}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).value = "";
            }
          }}
          onBlur={(e) => {
            add(e.target.value);
            e.target.value = "";
          }}
        />
      </div>
    </Field>
  );
}
