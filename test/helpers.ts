/**
 * Shared test utilities. Everything runs with ZERO external credentials and
 * no network — the API key is scrubbed so key-gated paths take their offline
 * fallbacks, exactly as CLAUDE.md requires.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsSchema, type Settings } from "../src/settings/schema.js";
import { StateStore } from "../src/core/state.js";
import { AuditLog } from "../src/core/audit.js";
import type {
  Position,
  Proposal,
  Quote,
  QuoteProvider,
  Signal,
} from "../src/core/types.js";

delete process.env.ANTHROPIC_API_KEY;

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "shadow-cortex-test-"));
}

export function newStore(dir: string = tempDir()): StateStore {
  return new StateStore(join(dir, "state.json"));
}

export function newAudit(dir: string = tempDir()): AuditLog {
  return new AuditLog(join(dir, "audit.jsonl"));
}

export function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  // Credential paths default into a temp dir so tests NEVER read the real
  // state/ directory — a developer's live tokens must not change test results.
  const paths = {
    robinhoodOauth: join(tempDir(), "no-oauth.json"),
    shadowalphaToken: join(tempDir(), "no-token.json"),
    ...(overrides.paths as Record<string, unknown> | undefined),
  };
  return SettingsSchema.parse({ marketHoursOnly: false, ...overrides, paths });
}

export class MockQuoteProvider implements QuoteProvider {
  readonly name = "mock";
  constructor(public prices: Record<string, number>) {}
  async getQuote(symbol: string): Promise<Quote> {
    const price = this.prices[symbol.toUpperCase()];
    if (price === undefined) throw new Error(`no mock price for ${symbol}`);
    return { symbol: symbol.toUpperCase(), price, asOf: new Date().toISOString() };
  }
}

export function makeSignal(overrides: Partial<Signal> = {}): Signal {
  const base: Signal = {
    symbol: "NVDA",
    type: "consensus",
    direction: "bullish",
    strength: 0.8,
    source: "shadowalpha",
    timestamp: new Date().toISOString(),
    fields: {},
    dedupeKey: `test:${Math.random()}`,
    raw: {},
  };
  return { ...base, ...overrides };
}

export function makePosition(overrides: Partial<Position> = {}): Position {
  const base: Position = {
    symbol: "HOOD",
    shares: 10,
    costBasis: 68,
    currentPrice: 70,
    unrealizedPnlPct: 2.94,
    highWaterMark: 70,
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
  return { ...base, ...overrides };
}

export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const base: Proposal = {
    id: `prop_test_${Math.random().toString(36).slice(2)}`,
    symbol: "NVDA",
    action: "buy",
    direction: "bullish",
    decider: "test",
    suggestedShares: 1,
    referencePrice: 100,
    rationale: "test proposal",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    priceBandPct: 1,
  };
  return { ...base, ...overrides };
}
