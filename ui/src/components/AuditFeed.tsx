import type { AuditEvent } from "../types";
import { clock } from "../format";
import { Panel } from "./Panel";

/** Pull the human-relevant bits out of an audit payload for one-line display. */
function summarize(e: AuditEvent): string {
  const d = e.data ?? {};
  const parts: string[] = [];
  for (const key of ["symbol", "type", "direction", "rule", "reason", "resolution", "detail"]) {
    const value = (d as Record<string, unknown>)[key];
    if (typeof value === "string") parts.push(value);
  }
  const nested = (d as { proposal?: { symbol?: string; action?: string } }).proposal;
  if (nested?.action && nested.symbol) parts.unshift(`${nested.action} ${nested.symbol}`);
  const result = (d as { result?: { filledShares?: number; fillPrice?: number } }).result;
  if (result?.filledShares !== undefined) {
    parts.push(`filled ${result.filledShares} @ $${result.fillPrice}`);
  }
  return parts.join(" · ");
}

export function AuditFeed({ events }: { events: AuditEvent[] }) {
  return (
    <Panel title="Audit trail" empty="Nothing yet." isEmpty={events.length === 0}>
      {events.map((e, i) => (
          <div className="audit-row" key={`${e.ts}-${i}`}>
            <span className="audit-time">{clock(e.ts)}</span>
            <span className="audit-event">{e.event.replace(/_/g, " ")}</span>
            <span className="audit-detail">{summarize(e)}</span>
          </div>
      ))}
    </Panel>
  );
}
