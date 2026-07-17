/**
 * Mirror of the engine's /api/snapshot shape (src/ui/server.ts). The heavy
 * strategy shapes (Settings, FieldDef) are imported type-only from the engine
 * so there is one definition, not two — vite erases these at build.
 */

import type { Settings } from "../../src/settings/schema.js";
import type { FieldDef } from "../../src/core/types.js";

export type { Settings, FieldDef };

export interface Status {
  scenario: 1 | 2 | 3;
  mode: "paper" | "live";
  execution: "off" | "confirm" | "auto";
  decider: string;
  entriesHalted: boolean;
  marketOpen: boolean;
  marketHoursOnly: boolean;
  pendingRestart: boolean;
  savedProfileInvalid: string | null;
  brokerStale?: boolean;
  startedAt: string;
}

export interface Account {
  cash: number;
  equity: number;
  /** Market value of all open positions (equity = cash + this). */
  positionsValue: number;
  dailyPnl: number;
  /** Day-start equity the daily P&L is measured against. */
  anchorEquity: number;
  maxDailyLoss: number | null;
}

export interface Position {
  symbol: string;
  shares: number;
  costBasis: number;
  currentPrice: number;
  unrealizedPnlPct: number;
  highWaterMark: number;
  openedAt: string;
}

export interface Proposal {
  id: string;
  symbol: string;
  action: "buy" | "sell";
  decider: string;
  suggestedShares: number;
  referencePrice: number;
  protectiveStop?: number;
  rationale: string;
  createdAt: string;
  expiresAt: string;
}

export type ProposalStatus = "open" | "executed" | "rejected" | "refused" | "expired";

export interface PendingProposal {
  proposal: Proposal;
  status: ProposalStatus;
  resolvedAt?: string;
  resolution?: string;
}

export interface AwaitingConfirm {
  proposal: Proposal;
  narrated: string;
}

export interface AuditEvent {
  ts: string;
  event: string;
  data: Record<string, unknown>;
}

export interface Transaction {
  ts: string;
  symbol: string;
  action: "buy" | "sell";
  filledShares: number;
  fillPrice: number;
  filledAt: string;
}

export interface Snapshot {
  status: Status;
  account: Account;
  positions: Position[];
  proposals: PendingProposal[];
  awaitingConfirm: AwaitingConfirm[];
  transactions: Transaction[];
  audit: AuditEvent[];
  now: string;
}

// --- /api/settings shapes ---

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface FieldChange {
  path: string;
  from: unknown;
  to: unknown;
}

/** The FULL available catalog (every feed + enrichment group, enabled or not). */
import type { AvailableFieldCatalog } from "../../src/enrichment/catalog.js";
export type FieldCatalog = AvailableFieldCatalog;

/** One rule card in entry.rules — derived from the engine schema, not remirrored. */
export type EntryRule = Settings["entry"]["rules"][number];
export type Constraint = EntryRule["constraints"][number];
export type ConstraintOp = Constraint["op"];

export interface SettingsResponse {
  active: Settings;
  saved: { raw: unknown | null; path: string; exists: boolean; revision: string | null };
  pendingRestart: boolean;
  savedProfileInvalid: string | null;
  diff: FieldChange[];
  fieldCatalog: FieldCatalog;
  constraints: { liveModeDisabledReason: string | null; brokerQuotesDisabledReason: string | null };
}

export interface SaveResult {
  ok: boolean;
  savedTo: string;
  revision: string | null;
  pendingRestart: boolean;
  diff: FieldChange[];
  restartHint?: string;
}

export interface ApiError {
  error: { code: string; message: string; issues?: ValidationIssue[] };
}
