import type { Status } from "../types";

export function StatusChips({ status }: { status: Status }) {
  return (
    <span className="chips">
      <span className="chip">scenario {status.scenario}</span>
      <span className="chip">{status.mode}</span>
      <span className="chip">execution: {status.execution}</span>
      <span className="chip">decider: {status.decider}</span>
      <span className="chip">
        market {status.marketOpen ? "open" : "closed"}
        {!status.marketHoursOnly && " (gate off)"}
      </span>
      {status.entriesHalted && <span className="chip warn">⚠ entries halted — daily loss cap</span>}
      {status.brokerStale && <span className="chip warn">⚠ broker read failing — showing last known data</span>}
    </span>
  );
}
