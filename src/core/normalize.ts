/**
 * Core-provided normalization helpers. Source adapters use these instead of
 * reimplementing dedupe keys, direction mapping, or strength scaling.
 */

import type { Direction } from "./types.js";

/** Round share quantities to 6 dp (fractional-share precision). */
export function roundShares(shares: number): number {
  return Math.round(shares * 1e6) / 1e6;
}

/** Round money to cents. */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Clamp any numeric strength into 0..1. */
export function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Map a signed value (e.g. ShadowAlpha `opp`, −100..100) to a direction. */
export function directionFromSign(value: number): Direction {
  return value >= 0 ? "bullish" : "bearish";
}

/**
 * Idempotency key: source + symbol + type + time bucket. Two upstream events
 * for the same (source, symbol, type) inside one bucket dedupe to one signal.
 */
export function makeDedupeKey(
  source: string,
  symbol: string,
  type: string,
  timestamp: string,
  bucketMinutes: number,
): string {
  const ms = Date.parse(timestamp);
  const bucket = Math.floor(ms / (bucketMinutes * 60_000));
  return `${source}:${symbol.toUpperCase()}:${type}:${bucket}`;
}

let idCounter = 0;

/** Cheap unique id for proposals — readable in logs, unique per process + time. */
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function minutesFromNow(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

/**
 * Upstream timestamps arrive as ISO or as "YYYY-MM-DD HH:MM:SS+00:00" —
 * normalize both to strict ISO, or null when unparseable (fail closed).
 */
export function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
