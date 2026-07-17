/**
 * Structured editor over the full settings document. Every section maps to a
 * schema block; the whole draft is round-tripped on save so preset precedence
 * (scenario 1/2 needing explicit mode/execution) holds.
 */

import { usePortfolios } from "../../usePortfolios";
import { useState, type ReactNode } from "react";
import type { FieldCatalog, Settings, ValidationIssue } from "../../types";
import { ChipListInput, NullableNumberField, NumberField, SelectField, ToggleField } from "./fields";
import { EntryRulesEditor } from "./EntryRulesEditor";
import { FEED_INFO, defaultFeedBlock } from "./feeds";

interface Props {
  draft: Settings;
  onChange: (draft: Settings) => void;
  catalog: FieldCatalog;
  constraints: { liveModeDisabledReason: string | null; brokerQuotesDisabledReason: string | null };
  issues: ValidationIssue[];
}

export function SettingsForm({ draft, onChange, catalog, constraints, issues }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...draft, [key]: value });
  const issuesFor = (prefix: string) => issues.filter((i) => i.path.startsWith(prefix));

  return (
    <div className="settings-form">
      <Section title="Mode & execution" issues={issuesFor("mode").concat(issuesFor("execution"), issuesFor("scenario"))}>
        <SelectField
          label="Scenario"
          value={draft.scenario}
          options={[
            { value: 1 as const, label: "1 — full AI agent" },
            { value: 2 as const, label: "2 — AI enters, rules exit" },
            { value: 3 as const, label: "3 — advise, you execute" },
          ]}
          onChange={(v) => set("scenario", v)}
          hint="Scenario 1/2 require explicit mode & execution below."
        />
        <SelectField
          label="Mode"
          value={draft.mode}
          options={[
            { value: "paper" as const, label: "paper" },
            { value: "live" as const, label: "live" },
          ]}
          disabledOptions={constraints.liveModeDisabledReason ? new Set(["live"] as const) : undefined}
          onChange={(v) => set("mode", v)}
          hint={constraints.liveModeDisabledReason ?? "Live reads the real Robinhood agentic account. Pair with execution: off to monitor without trading."}
        />
        <SelectField
          label="Execution"
          value={draft.execution}
          options={[
            { value: "off" as const, label: "off — log proposals only" },
            { value: "confirm" as const, label: "confirm — you approve each" },
            { value: "auto" as const, label: "auto — execute within caps" },
          ]}
          onChange={(v) => set("execution", v)}
          hint="Switching to auto asks for explicit confirmation on save."
        />
        <SelectField
          label="Decider"
          value={draft.decider}
          options={[
            { value: "rules" as const, label: "rules (deterministic)" },
            { value: "claude" as const, label: "claude (needs ANTHROPIC_API_KEY)" },
          ]}
          onChange={(v) => set("decider", v)}
        />
      </Section>

      <Section title="Risk caps" issues={issuesFor("caps")}>
        <NullableNumberField label="Max shares / order" value={draft.caps.maxSharesPerOrder} enabledDefault={10}
          onChange={(v) => set("caps", { ...draft.caps, maxSharesPerOrder: v })} />
        <NullableNumberField label="Max open positions" value={draft.caps.maxOpenPositions} enabledDefault={5}
          onChange={(v) => set("caps", { ...draft.caps, maxOpenPositions: v })} />
        <NullableNumberField label="Max $ / position" value={draft.caps.maxDollarsPerPosition} enabledDefault={500}
          onChange={(v) => set("caps", { ...draft.caps, maxDollarsPerPosition: v })} />
        <NullableNumberField label="Max daily loss ($)" value={draft.caps.maxDailyLoss} enabledDefault={100}
          hint="Halts NEW entries for the day. Exits always run."
          onChange={(v) => set("caps", { ...draft.caps, maxDailyLoss: v })} />
      </Section>

      <Section title="Exit policy" issues={issuesFor("exit")}>
        <NullableNumberField label="Stop-loss %" value={draft.exit.stopLossPct} enabledDefault={5}
          onChange={(v) => set("exit", { ...draft.exit, stopLossPct: v })} />
        <NullableNumberField label="Trailing stop %" value={draft.exit.trailingStopPct} enabledDefault={7}
          onChange={(v) => set("exit", { ...draft.exit, trailingStopPct: v })} />
        <NullableNumberField label="Take-profit %" value={draft.exit.takeProfitPct} enabledDefault={15}
          onChange={(v) => set("exit", { ...draft.exit, takeProfitPct: v })} />
        <NullableNumberField label="Trail activation (%)" value={draft.exit.trailActivationPct} enabledDefault={4}
          hint="The trailing stop arms only after the position has been up this much — entry noise can't trail you straight out."
          onChange={(v) => set("exit", { ...draft.exit, trailActivationPct: v })} />
        <NullableNumberField label="ATR stop (× ATR)" value={draft.exit.atrStopMultiplier} enabledDefault={1.1}
          hint="Volatility stop: exit when price falls this many ATRs below the peak. Scales to how much the symbol actually moves."
          onChange={(v) => set("exit", { ...draft.exit, atrStopMultiplier: v })} />
        {draft.exit.atrStopMultiplier !== null && (
          <NumberField label="ATR period (days)" value={draft.exit.atrPeriod}
            onChange={(v) => set("exit", { ...draft.exit, atrPeriod: v })} />
        )}
        <NullableNumberField label="Partial take-profit (%)" value={draft.exit.partialTpPct} enabledDefault={10}
          hint="At this gain, sell a fraction once and let the rest run."
          onChange={(v) => set("exit", { ...draft.exit, partialTpPct: v })} />
        {draft.exit.partialTpPct !== null && (
          <NumberField label="Partial close fraction" value={draft.exit.partialCloseFraction} step={0.05}
            hint="0.5 = sell half at the partial target."
            onChange={(v) => set("exit", { ...draft.exit, partialCloseFraction: v })} />
        )}
        <NullableNumberField label="Breakeven / dead-money (days)" value={draft.exit.breakevenDays} enabledDefault={5}
          hint="If the position hasn't achieved the minimum move after this many days, exit and free the capital."
          onChange={(v) => set("exit", { ...draft.exit, breakevenDays: v })} />
        {draft.exit.breakevenDays !== null && (
          <NullableNumberField label="Breakeven min move (%)" value={draft.exit.breakevenMinMovePct} enabledDefault={0}
            hint="Default 0 = must at least be at breakeven."
            onChange={(v) => set("exit", { ...draft.exit, breakevenMinMovePct: v })} />
        )}
        <NullableNumberField label="Max hold (days)" value={draft.exit.maxHoldDays} enabledDefault={3}
          onChange={(v) => set("exit", { ...draft.exit, maxHoldDays: v })} />
        <NullableNumberField label="Exit rejection cooldown (min)" value={draft.exit.rejectionCooldownMinutes} enabledDefault={30}
          hint="After you reject a SELL, don't re-ask about that symbol for this long. Careful: a rejected stop-loss stays quiet for the whole window even if the price keeps falling."
          onChange={(v) => set("exit", { ...draft.exit, rejectionCooldownMinutes: v })} />
      </Section>

      <Section title="Sizing" issues={issuesFor("sizing")}>
        <SelectField
          label="Mode"
          value={draft.sizing.mode}
          options={[
            { value: "fixedDollar" as const, label: "fixed dollar" },
            { value: "fixedShares" as const, label: "fixed shares" },
            { value: "percentOfEquity" as const, label: "percent of equity" },
          ]}
          onChange={(v) => set("sizing", { ...draft.sizing, mode: v })}
        />
        <NumberField label="Value" value={draft.sizing.value}
          onChange={(v) => set("sizing", { ...draft.sizing, value: v })}
          hint="Dollars, shares, or percent — per the mode." />
        <ToggleField label="Allow fractional shares" value={draft.sizing.allowFractionalShares}
          onChange={(v) => set("sizing", { ...draft.sizing, allowFractionalShares: v })} />
      </Section>

      <Section title="Cadence & signal windows" issues={issuesFor("cadence").concat(issuesFor("signalTtl"), issuesFor("dedupe"))}>
        <NumberField label="Intake poll (ms)" value={draft.cadence.intakePollMs}
          onChange={(v) => set("cadence", { ...draft.cadence, intakePollMs: v })} />
        <NumberField label="Management poll (ms)" value={draft.cadence.managementPollMs}
          onChange={(v) => set("cadence", { ...draft.cadence, managementPollMs: v })} />
        <NumberField label="Signal TTL (min)" value={draft.signalTtlMinutes}
          onChange={(v) => set("signalTtlMinutes", v)} />
        <NumberField label="Dedupe window (min)" value={draft.dedupeWindowMinutes}
          onChange={(v) => set("dedupeWindowMinutes", v)} />
        <ToggleField label="Market hours only" value={draft.marketHoursOnly}
          hint="When the market is closed: signal intake pauses (no new proposals) and entry execution defers. Exits always run. Weekdays 9:30–4:00 ET; no holiday calendar."
          onChange={(v) => set("marketHoursOnly", v)} />
      </Section>

      <Section
        title="Data sources"
        issues={issuesFor("sources").concat(issuesFor("enrichment"), issuesFor("quoteSource"))}
      >
        <SourcesEditor draft={draft} set={set} constraints={constraints} />
      </Section>

      <Section title="Entry criteria" issues={issuesFor("entry")}>
        <NullableNumberField label="Min reward/risk ratio" value={draft.entry.minRewardRiskRatio} enabledDefault={2}
          hint="Take-profit distance ÷ stop distance must be at least this. Needs both a target and a stop set; with either off, entries are refused while this gate is on."
          onChange={(v) => set("entry", { ...draft.entry, minRewardRiskRatio: v })} />
        <NullableNumberField label="Entry rejection cooldown (min)" value={draft.entry.rejectionCooldownMinutes} enabledDefault={30}
          hint="After you reject a BUY, don't re-propose that symbol for this long."
          onChange={(v) => set("entry", { ...draft.entry, rejectionCooldownMinutes: v })} />
        <EntryRulesEditor
          entry={draft.entry}
          draft={draft}
          catalog={catalog}
          onChange={(entry) => set("entry", entry)}
          onChangeDraft={onChange}
        />
      </Section>

      <p className="paper-note">
        Note: <code>paper.startingCash</code> and seed positions only apply against a fresh
        state file — an existing paper book is not reseeded.
      </p>
    </div>
  );
}

type SourceConfig = Settings["sources"][number];

/**
 * The data-source catalog, grouped by CONNECTION. Every data type each
 * connection offers is listed: signal feeds (events that become signals),
 * symbol enrichment (per-symbol fields rule cards can constrain), price data,
 * and types the MCP offers that aren't wired as criteria yet. Entry criteria
 * then map the ingested data to rules in the section below.
 */
function SourcesEditor({
  draft,
  set,
  constraints,
}: {
  draft: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  constraints: { liveModeDisabledReason: string | null; brokerQuotesDisabledReason: string | null };
}) {
  const sources = draft.sources;
  const feedIndex = (type: SourceConfig["type"]) => sources.findIndex((s) => s.type === type);

  const transports = new Set(sources.map((s) => s.transport));
  const dataMode: "fixture" | "live" | "mixed" =
    transports.size <= 1 ? ([...transports][0] ?? "fixture") : "mixed";
  const setAllTransports = (transport: "fixture" | "live") => {
    set("sources", sources.map((s) => ({ ...s, transport })));
    set("enrichment", {
      ...draft.enrichment,
      shadowalpha: { ...draft.enrichment.shadowalpha, transport },
    });
  };

  const toggleFeed = (type: "shadowalpha" | "shadowalpha-predictions" | "shadowalpha-portfolio", on: boolean) => {
    if (on) {
      set("sources", [...sources, defaultFeedBlock(type, dataMode === "live" ? "live" : "fixture")]);
    } else {
      set("sources", sources.filter((s) => s.type !== type));
    }
  };

  const sa = draft.enrichment.shadowalpha;
  const ta = draft.enrichment.ta;
  const setTa = (patch: Partial<typeof ta>) =>
    set("enrichment", { ...draft.enrichment, ta: { ...ta, ...patch } });

  const portfolioIdx = feedIndex("shadowalpha-portfolio");

  return (
    <div className="sources-editor">
      {/* ── ShadowAlpha ─────────────────────────────────────────────── */}
      <div className="group-card source-card">
        <div className="card-head">
          <span className="chip">ShadowAlpha MCP — one connection</span>
          {dataMode === "fixture" && <span className="chip warn">demo data</span>}
        </div>
        <SelectField
          label="Data"
          value={dataMode}
          options={[
            { value: "fixture" as const, label: "Demo — built-in sample data, no account needed" },
            { value: "live" as const, label: "Live — your ShadowAlpha account" },
            ...(dataMode === "mixed"
              ? [{ value: "mixed" as const, label: "Mixed (types differ — set per type in JSON)" }]
              : []),
          ]}
          onChange={(v) => {
            if (v !== "mixed") setAllTransports(v);
          }}
        />

        <p className="catalog-heading">Signal feeds — events that become signals</p>
        {(["shadowalpha", "shadowalpha-predictions", "shadowalpha-portfolio"] as const).map((type) => {
          const idx = feedIndex(type);
          const enabled = idx >= 0;
          const source = enabled ? sources[idx]! : null;
          return (
            <div className="feed-row" key={type}>
              <div className="feed-info">
                <label className="feed-toggle">
                  <input type="checkbox" checked={enabled} onChange={(e) => toggleFeed(type, e.target.checked)} />
                  <strong>{FEED_INFO[type]?.title}</strong> <code className="feed-id">{type}</code>
                </label>
                <span className="field-hint">{FEED_INFO[type]?.blurb}</span>
              </div>
              {enabled && source?.type === "shadowalpha-portfolio" && (
                <PortfolioPicker
                  values={source.portfolios}
                  transport={source.transport}
                  onChange={(portfolios) =>
                    set("sources", sources.map((s, i) => (i === portfolioIdx ? { ...s, portfolios } as SourceConfig : s)))
                  }
                />
              )}
            </div>
          );
        })}

        <p className="catalog-heading">Symbol enrichment — per-symbol fields for rule cards</p>
        <div className="feed-row">
          <div className="feed-info">
            <strong>AI conviction analysis</strong> <code className="feed-id">conviction.*</code>
            <span className="field-hint">
              Bull/bear case per candidate symbol (bullPoints, bearPoints, consensusCount, avgShadowScore,
              buyZoneActive). Nothing to enable — fetched automatically when a rule references a
              conviction.* datapoint.
            </span>
          </div>
        </div>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Symbol prediction stats</strong> <code className="feed-id">predictions.*</code>
            <span className="field-hint">
              How the symbol's tracked predictions are doing (count, bullishPct, avgConfidence,
              avgLivePnlPct; last {sa.daysBack} days). Fetched automatically when a rule references a
              predictions.* datapoint.
            </span>
          </div>
        </div>

        <p className="catalog-heading">Also part of this connection</p>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Social posts / chatter</strong>
            <span className="field-hint">
              Raw posts carry no direction, so they aren't a standalone feed — the Stock ideas scanner
              aggregates them into buzz / spikeRatio / recent3dSources.
            </span>
          </div>
        </div>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Analyst profiles & leaderboard</strong>
            <span className="field-hint">
              Joined automatically onto Analyst-prediction signals as analystRatingScore /
              analystBlendedWinRate — no separate toggle.
            </span>
          </div>
        </div>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Price data (get_price)</strong>
            <span className="field-hint">Selectable under Price data below.</span>
          </div>
        </div>
        <p className="field-hint">
          Rate budget: ShadowAlpha allows 30 requests/min. Each enabled feed polls once per intake
          cycle; enrichment adds one call per candidate symbol (cached {sa.cacheMinutes} min). With
          several feeds live, keep the intake poll at a minute or more.
        </p>
      </div>

      {/* ── Robinhood ───────────────────────────────────────────────── */}
      <div className="group-card source-card">
        <div className="card-head">
          <span className="chip">Robinhood MCP — one connection</span>
          {ta.provider === "fixture" && <span className="chip warn">TA on demo data</span>}
        </div>

        <p className="catalog-heading">Symbol enrichment — per-symbol fields for rule cards</p>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Technical indicators</strong> <code className="feed-id">ta.*</code>
            <span className="field-hint">
              Server-computed RSI / SMA / EMA / MACD / Bollinger per candidate symbol (ta.rsi14,
              ta.sma200, ta.bbUpper20, …). Nothing to enable — computed automatically when a rule
              references a ta.* datapoint.
            </span>
          </div>
          <SelectField
            label="Computed by"
            value={ta.provider}
            options={[
              { value: "fixture" as const, label: "Demo values (offline)" },
              { value: "robinhood" as const, label: "Robinhood (live; needs connection)" },
            ]}
            onChange={(provider) => setTa({ provider })}
          />
        </div>

        <p className="catalog-heading">Also part of this connection</p>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Price data (broker quotes)</strong>
            <span className="field-hint">The transactable price — selectable under Price data below.</span>
          </div>
        </div>
        <div className="feed-row">
          <div className="feed-info">
            <strong>Fundamentals · Earnings calendar · Options data · Scanners</strong>
            <span className="field-hint">
              Available in the Robinhood MCP, not yet wired as entry-criteria fields — natural next
              adapters (e.g. earnings.daysToNext as a "no buys before earnings" gate).
            </span>
          </div>
        </div>
      </div>

      {/* ── Price data ──────────────────────────────────────────────── */}
      <div className="group-card source-card">
        <div className="card-head">
          <span className="chip">Price data — one switch</span>
        </div>
        <SelectField
          label="Prices come from"
          value={draft.quoteSource}
          options={[
            { value: "fixture" as const, label: "Demo — replayed fixture prices" },
            { value: "shadowalpha" as const, label: "ShadowAlpha — get_price" },
            { value: "broker" as const, label: "Robinhood — transactable broker quotes" },
          ]}
          disabledOptions={constraints.brokerQuotesDisabledReason ? new Set(["broker"] as const) : undefined}
          onChange={(v) => set("quoteSource", v)}
          hint={
            constraints.brokerQuotesDisabledReason ??
            "Prices the management loop values positions with and proposals reference. Robinhood gives the transactable price; ShadowAlpha works without a broker connection."
          }
        />
      </div>

      <p className="field-hint">
        Feeds and enrichment publish the fields; the Entry criteria section below maps them to rules.
        Finer per-type options live in the JSON tab.
      </p>
    </div>
  );
}

/** Portfolio chips + a picker fed live from the engine (GET /api/portfolios). */
function PortfolioPicker({
  values,
  transport,
  onChange,
}: {
  values: string[];
  transport: "fixture" | "live";
  onChange: (v: string[]) => void;
}) {
  const available = usePortfolios();
  const demo = transport === "fixture";
  const addable = available.filter((p) => p.name && !values.includes(p.name));
  return (
    <div className="portfolio-field">
      <ChipListInput
        label="Portfolios / curations"
        values={values}
        placeholder="portfolio name or id…"
        hint={
          demo
            ? "These are made-up sample portfolios (fixture transport) — switch Transport to live and connect ShadowAlpha to see your real curations."
            : "Which of your ShadowAlpha portfolios to follow. At least one."
        }
        onChange={onChange}
      />
      {addable.length > 0 && (
        <select
          className="portfolio-picker"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange([...values, e.target.value]);
          }}
        >
          <option value="">{demo ? "add from sample portfolios (demo)…" : "add from your portfolios…"}</option>
          {addable.map((p) => (
            <option key={p.name!} value={p.name!}>
              {p.name}
              {demo ? " [demo]" : ""}
              {p.status === "paused" ? " (paused)" : ""}
              {p.winRatePct !== null ? ` — ${p.winRatePct}% win rate` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Section({ title, issues, children }: { title: string; issues: ValidationIssue[]; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <div className="section-body">{children}</div>
      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i, idx) => (
            <li key={idx}>
              <code>{i.path}</code>: {i.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
