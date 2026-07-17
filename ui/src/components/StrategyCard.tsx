/**
 * The running strategy, in plain English, on the monitor view — so the active
 * strategy is always visible, whoever authored it (the panel, a hand-edit, or
 * an AI agent editing the profile). Loads /api/settings independently of the
 * live snapshot; it only changes on restart, so a one-time fetch is enough.
 */

import type { ReactNode } from "react";
import { useSettings } from "../useSettings";
import type { EntryRule, Settings } from "../types";

export function StrategyCard() {
  const { data } = useSettings();
  if (!data) return null;
  const s = data.active;

  return (
    <div className="panel">
      <h2>Active strategy</h2>
      <div className="strategy-grid">
        <Row label="Decider">{s.decider}</Row>
        <Row label="Entry">{entryText(s)}</Row>
        <Row label="Exit">{exitText(s)}</Row>
        <Row label="Sizing">{sizingText(s)}</Row>
        {s.entry.symbolBlocklist.length > 0 && (
          <Row label="Never trade">{s.entry.symbolBlocklist.join(", ")}</Row>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="strategy-label">{label}</span>
      <span className="strategy-value">{children}</span>
    </>
  );
}

function entryText(s: Settings): string {
  return s.entry.rules.map(ruleText).join("  ·OR·  ");
}

function ruleText(rule: EntryRule): string {
  const scope = rule.source ? `${rule.source}` : "any source";
  const syms = rule.symbols.length ? ` [${rule.symbols.join("/")}]` : "";
  const parts = rule.constraints.map((c) => `${c.field.replace("window.", "")} ${c.op} ${c.value}`);
  return `${rule.label}: ${scope}${syms} — ${parts.join(" & ")}`;
}

function exitText(s: Settings): string {
  const parts: string[] = [];
  if (s.exit.stopLossPct !== null) parts.push(`stop −${s.exit.stopLossPct}%`);
  if (s.exit.trailingStopPct !== null) parts.push(`trail ${s.exit.trailingStopPct}%`);
  if (s.exit.takeProfitPct !== null) parts.push(`target +${s.exit.takeProfitPct}%`);
  if (s.exit.trailActivationPct !== null && s.exit.trailingStopPct !== null)
    parts.push(`trail arms at +${s.exit.trailActivationPct}%`);
  if (s.exit.atrStopMultiplier !== null) parts.push(`ATR stop ${s.exit.atrStopMultiplier}×ATR(${s.exit.atrPeriod})`);
  if (s.exit.partialTpPct !== null)
    parts.push(`partial ${Math.round(s.exit.partialCloseFraction * 100)}% at +${s.exit.partialTpPct}%`);
  if (s.exit.breakevenDays !== null) parts.push(`dead-money exit after ${s.exit.breakevenDays}d`);
  if (s.exit.maxHoldDays !== null) parts.push(`max hold ${s.exit.maxHoldDays}d`);
  return parts.length ? parts.join(", ") : "no programmatic exits";
}

function sizingText(s: Settings): string {
  const unit =
    s.sizing.mode === "fixedDollar" ? `$${s.sizing.value}` :
    s.sizing.mode === "fixedShares" ? `${s.sizing.value} sh` :
    `${s.sizing.value}% equity`;
  return `${unit} / position${s.sizing.allowFractionalShares ? " (fractional)" : ""}`;
}
