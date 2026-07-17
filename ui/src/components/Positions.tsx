import type { Position } from "../types";
import { money, shares, signedPct } from "../format";
import { Panel } from "./Panel";

export function Positions({ positions }: { positions: Position[] }) {
  return (
    <Panel title="Positions" empty="No open positions." isEmpty={positions.length === 0} scrollable>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Shares</th>
              <th className="num">Cost</th>
              <th className="num">Price</th>
              <th className="num">Value</th>
              <th className="num">Peak</th>
              <th className="num">P&L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol}>
                <td>
                  <strong>{p.symbol}</strong>
                </td>
                <td className="num">{shares(p.shares)}</td>
                <td className="num">{money(p.costBasis)}</td>
                <td className="num">{money(p.currentPrice)}</td>
                <td className="num">{money(p.shares * p.currentPrice)}</td>
                <td className="num">{money(p.highWaterMark)}</td>
                <td className={`num ${p.unrealizedPnlPct >= 0 ? "pnl-up" : "pnl-down"}`}>
                  {signedPct(p.unrealizedPnlPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
    </Panel>
  );
}
