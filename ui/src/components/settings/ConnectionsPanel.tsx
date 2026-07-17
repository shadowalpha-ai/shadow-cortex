/**
 * Connections panel — connect ShadowAlpha and Robinhood without a terminal.
 *
 * ShadowAlpha: paste a token → the engine live-validates it before saving.
 * Robinhood: full browser OAuth — Connect opens Robinhood's approval page and
 * the dashboard's own callback finishes the exchange.
 * Both apply on restart, so the panel also carries the Restart button (the
 * engine exits with a restart code and the supervisor respawns it).
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface ConnectionsStatus {
  shadowalpha: { connected: boolean; source: "env" | "file" | null };
  robinhood: { connected: boolean; account: string | null };
  localAi?: { lastSeenAt: string | null; connectorUrl: string; configSnippet: string };
}

async function fetchStatus(): Promise<ConnectionsStatus | null> {
  try {
    const res = await fetch("/api/connections");
    return res.ok ? ((await res.json()) as ConnectionsStatus) : null;
  } catch {
    return null;
  }
}

export function ConnectionsPanel() {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const oauthPoll = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const s = await fetchStatus();
    if (s) setStatus(s);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (oauthPoll.current !== null) window.clearInterval(oauthPoll.current);
    };
  }, [refresh]);

  const connectShadowAlpha = async () => {
    setBusy("shadowalpha");
    setMessage(null);
    try {
      const res = await fetch("/api/connections/shadowalpha", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json();
      if (res.ok) {
        setToken("");
        setMessage({ kind: "ok", text: "ShadowAlpha token verified and saved. Restart the engine to start using live data." });
        await refresh();
      } else {
        setMessage({ kind: "warn", text: body?.error?.message ?? "Token rejected." });
      }
    } catch (err) {
      setMessage({ kind: "warn", text: String(err) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (service: "shadowalpha" | "robinhood") => {
    if (!window.confirm(`Disconnect ${service}? The engine loses access on next restart.`)) return;
    setBusy(service);
    try {
      const res = await fetch(`/api/connections/${service}`, { method: "DELETE" });
      const body = await res.json();
      setMessage(
        res.ok
          ? { kind: "ok", text: `${service} disconnected. Restart the engine to apply.` }
          : { kind: "warn", text: body?.error?.message ?? "Disconnect failed." },
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const connectRobinhood = async () => {
    setBusy("robinhood");
    setMessage(null);
    try {
      const res = await fetch("/api/connections/robinhood/start", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMessage({ kind: "warn", text: body?.error?.message ?? "Could not start the Robinhood connection." });
        return;
      }
      if (body.alreadyConnected) {
        setMessage({ kind: "ok", text: "Robinhood is already connected — the stored token is valid." });
        await refresh();
        return;
      }
      window.open(body.authorizeUrl, "_blank", "noopener");
      setMessage({
        kind: "ok",
        text: "Approve the connection in the Robinhood tab that just opened (check your Robinhood app too). This panel updates when it completes.",
      });
      // Poll until the callback lands (or the user gives up).
      if (oauthPoll.current !== null) window.clearInterval(oauthPoll.current);
      const startedAt = Date.now();
      oauthPoll.current = window.setInterval(async () => {
        const s = await fetchStatus();
        if (s?.robinhood.connected) {
          window.clearInterval(oauthPoll.current!);
          oauthPoll.current = null;
          setStatus(s);
          setMessage({
            kind: "ok",
            text: `Robinhood connected${s.robinhood.account ? ` — agentic account ${s.robinhood.account}` : ""}. Restart the engine to use it.`,
          });
        } else if (Date.now() - startedAt > 5 * 60_000) {
          window.clearInterval(oauthPoll.current!);
          oauthPoll.current = null;
        }
      }, 2000);
    } finally {
      setBusy(null);
    }
  };

  const restartEngine = async () => {
    if (!window.confirm("Restart the engine now? Open proposals expire on their normal TTL; state is saved first.")) return;
    setRestarting(true);
    try {
      const res = await fetch("/api/engine/restart", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage({ kind: "warn", text: body?.error?.message ?? "Restart unavailable." });
        setRestarting(false);
        return;
      }
    } catch {
      /* the process is going down — expected */
    }
    // The old process keeps serving ~250ms while the response flushes — wait
    // past that before polling, or we'd "detect" the dying engine and reload
    // into nothing. Then poll until the supervisor's respawn answers.
    window.setTimeout(() => {
      const poll = window.setInterval(async () => {
        try {
          const res = await fetch("/api/snapshot");
          if (res.ok) {
            window.clearInterval(poll);
            window.location.reload();
          }
        } catch {
          /* still down */
        }
      }, 1000);
    }, 1500);
  };

  const sa = status?.shadowalpha;
  const rh = status?.robinhood;
  const ai = status?.localAi;
  const [showAiSetup, setShowAiSetup] = useState(false);
  const aiActive =
    !!ai?.lastSeenAt && Date.now() - Date.parse(ai.lastSeenAt) < 10 * 60_000;

  return (
    <section className="settings-section connections">
      <h3>Connections</h3>
      <div className="connections-body">
        <div className="connection-row">
          <div className="connection-info">
            <div className="connection-title">
              <strong>ShadowAlpha MCP</strong>
              <StatusChip
                ok={!!sa?.connected}
                label={
                  sa?.connected
                    ? sa.source === "env"
                      ? "Connected (env var)"
                      : "Connected"
                    : "Not connected"
                }
              />
            </div>
            <span className="field-hint">
              Live signals and your portfolios/curations. Paste your ShadowAlpha MCP token —
              it's verified against the live server, then stored locally (never in the profile
              or the repo).
            </span>
          </div>
          <div className="connection-actions">
            {sa?.connected && sa.source === "file" ? (
              <button disabled={busy !== null} onClick={() => disconnect("shadowalpha")}>
                Disconnect
              </button>
            ) : sa?.source === "env" ? null : (
              <>
                <input
                  type="password"
                  placeholder="paste ShadowAlpha MCP token…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button
                  className="confirm"
                  disabled={busy !== null || token.trim().length === 0}
                  onClick={connectShadowAlpha}
                >
                  {busy === "shadowalpha" ? "Verifying…" : "Connect"}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="connection-row">
          <div className="connection-info">
            <div className="connection-title">
              <strong>Robinhood (agentic trading)</strong>
              <StatusChip
                ok={!!rh?.connected}
                label={rh?.connected ? `Connected${rh.account ? ` — ${rh.account}` : ""}` : "Not connected"}
              />
            </div>
            <span className="field-hint">
              Live account monitoring and (when you choose) execution — always confined to your
              dedicated agentic account. Connect opens Robinhood's approval page in a new tab.
            </span>
          </div>
          <div className="connection-actions">
            {rh?.connected ? (
              <button disabled={busy !== null} onClick={() => disconnect("robinhood")}>
                Disconnect
              </button>
            ) : (
              <button className="confirm" disabled={busy !== null} onClick={connectRobinhood}>
                {busy === "robinhood" ? "Starting…" : "Connect Robinhood"}
              </button>
            )}
          </div>
        </div>

        <div className="connection-row">
          <div className="connection-info">
            <div className="connection-title">
              <strong>Local AI application (MCP)</strong>
              <StatusChip
                ok={aiActive}
                label={
                  aiActive
                    ? `Active — last seen ${new Date(ai!.lastSeenAt!).toLocaleTimeString()}`
                    : ai?.lastSeenAt
                      ? `Last seen ${new Date(ai.lastSeenAt).toLocaleString()}`
                      : "No AI contact yet"
                }
              />
            </div>
            <span className="field-hint">
              Let Claude Desktop (or any MCP-capable AI app) drive the engine conversationally:
              monitor the account, tune the strategy, confirm proposals, restart. Same fail-closed
              gates as this dashboard — the AI gets a steering wheel, not a bypass.
            </span>
          </div>
          <div className="connection-actions">
            <button onClick={() => setShowAiSetup((v) => !v)}>
              {showAiSetup ? "Hide setup" : "Setup instructions"}
            </button>
          </div>
        </div>
        {showAiSetup && ai && (
          <div className="ai-setup">
            <p className="field-hint">
              <strong>Claude Desktop — one-click extension:</strong> download the file below,
              double-click it, and click Install in the dialog Claude Desktop opens. That's it —
              then just ask Claude: "how's my Shadow Cortex account doing?", "tighten the
              trailing stop to 3% and restart the engine", "confirm the NVDA proposal". This row
              shows Active once the AI makes its first call.
            </p>
            <a className="download-button" href="/api/connections/local-ai/extension" download>
              ⬇ Download Claude Desktop extension (.dxt)
            </a>
            <p className="field-hint">
              (Claude Desktop's "Add custom connector" field only accepts remote https servers —
              a local engine connects through the extension instead. Never tunnel the engine to
              the internet just to get an https link.)
            </p>
            <p className="field-hint">
              <strong>Other local AI apps</strong> (Cursor, custom agents — anything that accepts
              a local MCP URL):
            </p>
            <div className="connector-link-row">
              <code className="connector-link">{ai.connectorUrl}</code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(ai.connectorUrl);
                }}
              >
                Copy link
              </button>
            </div>
            <details className="ai-advanced">
              <summary className="field-hint">Manual setup (advanced — any MCP client)</summary>
              <p className="field-hint">
                Add this to the client's MCP config (Claude Desktop: <code>~/Library/Application
                Support/Claude/claude_desktop_config.json</code>), then restart it:
              </p>
              <pre className="ai-setup-snippet">{ai.configSnippet}</pre>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(ai.configSnippet);
                }}
              >
                Copy config
              </button>
            </details>
          </div>
        )}

        {message && <div className={`banner${message.kind === "warn" ? " warn" : ""}`}>{message.text}</div>}

        <div className="connection-row restart-row">
          <span className="field-hint">
            Connections and saved settings apply when the engine restarts.
          </span>
          <button disabled={restarting} onClick={restartEngine}>
            {restarting ? "Restarting…" : "Restart engine"}
          </button>
        </div>
      </div>
    </section>
  );
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`chip ${ok ? "chip-ok" : "chip-off"}`}>{label}</span>;
}
