/**
 * Append-only audit trail (JSONL). Every proposal, confirm/reject, execution,
 * refusal, and exit is written here — this file is the engine's memory of
 * what it did and why.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEvent =
  | "signal_ingested"
  | "entry_skipped"
  | "proposal_created"
  | "proposal_dropped"
  | "proposal_suppressed"
  | "proposal_expired"
  | "proposal_confirmed"
  | "proposal_rejected"
  | "execution_refused"
  | "order_executed"
  | "exit_triggered"
  | "entries_halted"
  | "settings_changed"
  | "settings_change_rejected"
  | "connection_changed"
  | "book_changed"
  | "engine_started"
  | "engine_stopped"
  | "error";

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(event: AuditEvent, data: unknown): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, data });
    appendFileSync(this.path, line + "\n");
  }
}
