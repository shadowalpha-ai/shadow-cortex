import type { Account } from "../types";
import { money, signedMoney } from "../format";

export function StatTiles({
  account,
  positionCount,
}: {
  account: Account;
  positionCount: number;
}) {
  const pnlClass = account.dailyPnl >= 0 ? "pnl-up" : "pnl-down";
  return (
    <div className="tiles">
      <div className="tile">
        <div className="label">Equity</div>
        <div className="value">{money(account.equity)}</div>
        <div className="sub">cash + positions</div>
      </div>
      <div className="tile">
        <div className="label">Cash</div>
        <div className="value">{money(account.cash)}</div>
      </div>
      <div className="tile">
        <div className="label">Daily P&L</div>
        <div className={`value ${pnlClass}`}>{signedMoney(account.dailyPnl)}</div>
        <div className="sub">vs {money(account.anchorEquity)} at day start</div>
        <div className="sub">
          {account.maxDailyLoss !== null
            ? `halts entries at −${money(account.maxDailyLoss)}`
            : "daily-loss cap disabled"}
        </div>
      </div>
      <div className="tile">
        <div className="label">Open positions</div>
        <div className="value">{positionCount}</div>
        <div className="sub">{money(account.positionsValue)} at market</div>
      </div>
    </div>
  );
}
