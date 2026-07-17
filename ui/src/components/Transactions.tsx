/**
 * Executed transactions (fills), newest first — read from the append-only
 * audit log's order_executed events, so it survives restarts and shows
 * exactly what the execution layer did (paper or live).
 */

import type { Transaction } from "../types";
import { money, shares } from "../format";
import { Panel } from "./Panel";

export function Transactions({ transactions }: { transactions: Transaction[] }) {
  return (
    <Panel
      title="Transactions"
      empty="No executed orders yet."
      isEmpty={transactions.length === 0}
      scrollable
    >
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Symbol</th>
                <th className="num">Shares</th>
                <th className="num">Fill</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t, i) => (
                <tr key={`${t.ts}-${i}`}>
                  <td className="muted">{new Date(t.ts).toLocaleString()}</td>
                  <td className={t.action === "buy" ? "pnl-up" : "pnl-down"}>
                    {t.action.toUpperCase()}
                  </td>
                  <td>
                    <strong>{t.symbol}</strong>
                  </td>
                  <td className="num">{shares(t.filledShares)}</td>
                  <td className="num">{money(t.fillPrice)}</td>
                  <td className="num">{money(t.filledShares * t.fillPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
    </Panel>
  );
}
