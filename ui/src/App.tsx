import { useState } from "react";
import { useSnapshot } from "./useSnapshot";
import { StatusChips } from "./components/StatusChips";
import { StatTiles } from "./components/StatTiles";
import { Positions } from "./components/Positions";
import { Proposals } from "./components/Proposals";
import { AuditFeed } from "./components/AuditFeed";
import { Transactions } from "./components/Transactions";
import { StrategyCard } from "./components/StrategyCard";
import { SettingsView } from "./components/settings/SettingsView";

type Tab = "dashboard" | "settings";

export default function App() {
  const { snapshot, connected } = useSnapshot();
  const [tab, setTab] = useState<Tab>("dashboard");

  const pendingRestart = snapshot?.status.pendingRestart ?? false;
  const savedInvalid = snapshot?.status.savedProfileInvalid ?? null;

  return (
    <div className="app">
      <div className="header">
        <h1>Shadow Cortex</h1>
        {snapshot && <StatusChips status={snapshot.status} />}
        <span className="live">
          <span className={`dot ${connected ? "on" : ""}`} />
          {connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <nav className="tabs">
        <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
          Monitor
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          Settings
          {pendingRestart && <span className="tab-dot" title="restart required" />}
        </button>
      </nav>

      {pendingRestart && (
        <div className="banner warn">
          Settings were saved but the running engine still uses its startup configuration — restart
          the engine to apply them.
        </div>
      )}
      {savedInvalid && (
        <div className="banner warn">The saved profile file is invalid and won't load on restart.</div>
      )}

      {tab === "dashboard" ? (
        !snapshot ? (
          <p className="empty">
            Connecting to engine… start it with <code>npm run dev</code> in the repo root.
          </p>
        ) : (
          <>
            <StatTiles account={snapshot.account} positionCount={snapshot.positions.length} />
            <StrategyCard />
            <div className="columns">
              <div className="stack">
                <Positions positions={snapshot.positions} />
                <Transactions transactions={snapshot.transactions} />
              </div>
              <Proposals proposals={snapshot.proposals} awaiting={snapshot.awaitingConfirm} />
            </div>
            <AuditFeed events={snapshot.audit} />
          </>
        )
      ) : (
        <SettingsView />
      )}
    </div>
  );
}
