import { Panel } from "./Panel";
import type { AwaitingConfirm, PendingProposal } from "../types";
import { answerProposal } from "../useSnapshot";
import { clock, money, shares } from "../format";

export function Proposals({
  proposals,
  awaiting,
}: {
  proposals: PendingProposal[];
  awaiting: AwaitingConfirm[];
}) {
  const awaitingIds = new Set(awaiting.map((a) => a.proposal.id));
  return (
    <Panel
      title="Proposals"
      empty="No proposals yet — waiting on signals."
      isEmpty={proposals.length === 0}
      scrollable
    >
        {proposals.map(({ proposal: p, status, resolution }) => (
          <div className="proposal" key={p.id}>
            <div className="head">
              <span className="action">
                {p.action.toUpperCase()} ${p.symbol}
              </span>
              <span className={`status ${status}`}>{status}</span>
              <span className="meta">{p.decider}</span>
            </div>
            <div className="rationale">{p.rationale}</div>
            <div className="meta">
              {shares(p.suggestedShares)} sh @ ~{money(p.referencePrice)} ≈{" "}
              {money(p.suggestedShares * p.referencePrice)}
              {p.protectiveStop !== undefined && ` · stop ${money(p.protectiveStop)}`}
              {" · "}
              {clock(p.createdAt)}
              {resolution && ` · ${resolution}`}
            </div>
            {awaitingIds.has(p.id) && (
              <div className="confirm-bar">
                <button className="confirm" onClick={() => answerProposal(p.id, "confirm")}>
                  Confirm {p.action}
                </button>
                <button className="reject" onClick={() => answerProposal(p.id, "reject")}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
    </Panel>
  );
}
