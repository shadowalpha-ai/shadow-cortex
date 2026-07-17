/**
 * The locked core data shapes (see PRD "Core data shapes").
 *
 * These are the contracts the whole engine is built on. Nothing downstream of
 * a source adapter may depend on where a signal came from — `Signal` is the
 * only contract the core knows. Share quantities are decimal everywhere
 * (fractional-capable); round shares to 6 dp and money to cents at boundaries.
 */

import type { Settings } from "../settings/schema.js";

export type Direction = "bullish" | "bearish";

/** A labeled data value an adapter publishes for rule criteria. */
export type FieldValue = number | string | boolean;

/** One entry in a source's field catalog — what the rule builder imports. */
export interface FieldDef {
  name: string;
  kind: "number" | "string" | "boolean";
  description: string;
  /**
   * Optional enumeration of known values (e.g. configured portfolio names).
   * UI-advisory only — the rule builder renders a dropdown instead of a text
   * input. The engine's constraint evaluation is unchanged and fails closed
   * on any mismatch regardless.
   */
  values?: string[];
  /**
   * A sensible starting comparison for the rule builder (UI-advisory): the
   * op/value a new constraint on this field begins with, so a fresh row
   * means something instead of an arbitrary ">= 0".
   */
  defaultOp?: "==" | "!=" | ">=" | ">" | "<=" | "<" | "has";
  defaultValue?: number | string | boolean;
}

export interface Signal {
  symbol: string;
  /** Adapter-defined kind, e.g. "consensus" | "buzz" | "alert" | "technical". */
  type: string;
  direction: Direction;
  /** Normalized magnitude, 0..1. */
  strength: number;
  /** Which adapter emitted this, e.g. "shadowalpha". */
  source: string;
  /** ISO 8601. */
  timestamp: string;
  /** Optional source certainty, 0..1. */
  confidence?: number;
  /**
   * The adapter's labeled data dictionary — entry rules constrain these by
   * name. Every published field should appear in the adapter's fieldCatalog.
   */
  fields: Record<string, FieldValue>;
  /** Idempotency key: source + symbol + type + time bucket. */
  dedupeKey: string;
  /** The untouched upstream payload, for audit and debugging. */
  raw: unknown;
}

export type ProposalAction = "buy" | "sell";

/** A proposal, never an auto-execution. Only the execution layer executes. */
export interface Proposal {
  id: string;
  symbol: string;
  action: ProposalAction;
  direction: Direction;
  /** Name of the decider (or exit policy) that produced it. */
  decider: string;
  /** dedupeKeys of the signals that drove an entry proposal. */
  contributingSignals?: string[];
  suggestedShares: number;
  referencePrice: number;
  /** Suggested broker-side protective stop price, if any. */
  protectiveStop?: number;
  rationale: string;
  createdAt: string;
  /** Confirming an expired proposal is refused. */
  expiresAt: string;
  /** Max % drift from referencePrice allowed at execution time. */
  priceBandPct: number;
}

/** Reconciled from the broker every management tick — the broker wins. */
export interface Position {
  symbol: string;
  shares: number;
  /** Average per-share cost. */
  costBasis: number;
  currentPrice: number;
  unrealizedPnlPct: number;
  /** Persisted in the state store; the broker cannot give this back. */
  highWaterMark: number;
  openedAt: string;
}

export interface Quote {
  symbol: string;
  price: number;
  asOf: string;
}

export interface DecisionContext {
  signals: Signal[];
  positions: Position[];
  quotes: Record<string, Quote>;
  /** Account equity (cash + market value), for percent-of-equity sizing. */
  equity: number;
  /**
   * Per-symbol enrichment fields (e.g. `ta.rsi14`), fetched by the intake
   * loop for the symbols under decision. Optional: absent = no enrichment,
   * and any rule constraint on an enrichment field fails closed.
   */
  enrichment?: Record<string, Record<string, FieldValue>>;
  settings: Settings;
  now: Date;
  /**
   * Optional hook: deciders report symbols they considered and DROPPED, with
   * the reason. Silent no-matches are how misconfigured strategies hide —
   * the intake loop audits these as `entry_skipped` so "signals arrived but
   * nothing proposed" is always explained somewhere visible.
   */
  onSkip?: (skip: { symbol: string; reason: string }) => void;
}

export interface Decider {
  name: string;
  decide(ctx: DecisionContext): Promise<Proposal[]>;
  /**
   * Optional: report that the last decide() was deferred (e.g. an LLM cost
   * throttle) and is ready to run again. The intake loop then re-decides the
   * current window even without fresh signals — deferrals are delayed, never
   * silently dropped.
   */
  wantsRetry?(now?: Date): boolean;
}

/** A signal source is a POLLER: the intake loop calls poll() every cadence tick. */
export interface SignalSource {
  name: string;
  /**
   * The fields this source publishes on its signals, for the rule builder.
   * A source with caller-defined fields may declare an empty catalog.
   */
  fieldCatalog: FieldDef[];
  poll(): Promise<Signal[]>;
}

export interface QuoteProvider {
  name: string;
  getQuote(symbol: string): Promise<Quote>;
  /** Replayable providers advance one step per management tick. */
  advance?(): void;
}

export interface OrderRequest {
  symbol: string;
  action: ProposalAction;
  shares: number;
}

export interface OrderResult {
  symbol: string;
  action: ProposalAction;
  filledShares: number;
  fillPrice: number;
  filledAt: string;
}

export interface BrokerPosition {
  symbol: string;
  shares: number;
  costBasis: number;
  currentPrice: number;
  openedAt: string;
}

export interface Broker {
  name: string;
  getPositions(): Promise<BrokerPosition[]>;
  getAccount(): Promise<{ cash: number; equity: number }>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
}

/** Pending proposal lifecycle status, kept in the state store. */
export type ProposalStatus =
  | "open"
  | "executed"
  | "rejected"
  | "refused"
  | "expired";

export interface PendingProposal {
  proposal: Proposal;
  status: ProposalStatus;
  resolvedAt?: string;
  resolution?: string;
}
