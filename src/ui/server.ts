/**
 * Local monitoring dashboard server. Serves:
 *
 *   GET  /api/snapshot                    engine state as one JSON document
 *   GET  /api/events                      SSE stream of the same snapshot
 *   POST /api/proposals/:id/confirm       answer a pending confirmation
 *   POST /api/proposals/:id/reject
 *   GET  /api/settings                    running + saved settings, field catalog
 *   POST /api/settings/validate           fail-closed dry-run of a document
 *   PUT  /api/settings                    validate → write profile file →
 *                                         restart banner (save + restart)
 *   GET  /*                               the built React app (ui/dist), or a
 *                                         help page if it hasn't been built
 *
 * SECURITY: binds to 127.0.0.1 ONLY. The confirm endpoint executes orders and
 * the settings endpoints mutate the strategy on disk; neither may ever listen
 * on the network. If you want remote access, that is your tunnel and your
 * risk — do not change the bind address casually.
 *
 * The dashboard is a WINDOW onto the engine plus two guarded actions:
 * confirm/reject goes through the same ConfirmChannel the CLI uses, and
 * settings writes go through the same fail-closed validation the boot loader
 * uses (see ./settings-api.ts). The running engine's in-memory settings never
 * change until restart.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Broker, Position, SignalSource } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { StateStore } from "../core/state.js";
import type { AuditLog } from "../core/audit.js";
import type { ExecutionGate } from "../execution/gate.js";
import type { ProfileStore } from "../settings/profile-store.js";
import type { WebConfirmChannel } from "./confirm.js";
import { ShadowAlphaPortfolioSource } from "../sources/shadowalpha-portfolio.js";
import { SettingsApi } from "./settings-api.js";
import { ConnectionsApi } from "./connections-api.js";
import { isMarketOpen } from "../engine/market-hours.js";
import { roundMoney } from "../core/normalize.js";
import { log } from "../core/log.js";

const UI_DIST = "ui/dist";
const SNAPSHOT_INTERVAL_MS = 2000;
const AUDIT_TAIL = 40;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

interface UiDeps {
  settings: Settings;
  store: StateStore;
  broker: Broker;
  gate: ExecutionGate;
  sources: SignalSource[];
  profile: ProfileStore;
  audit: AuditLog;
  auditPath: string;
  confirm: WebConfirmChannel;
  /**
   * Exits the process with RESTART_EXIT_CODE so the supervisor respawns it —
   * the dashboard's Restart button. Absent (tests) = the route returns 501.
   */
  requestRestart?: () => void;
  /** Test seam for the connections API's live token validation. */
  connections?: ConnectionsApi;
}

const MAX_BODY_BYTES = 256 * 1024;

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError(400, "request body is not valid JSON");
  }
}

export class UiServer {
  private server: Server | null = null;
  private readonly sseClients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly settingsApi: SettingsApi;
  private readonly connections: ConnectionsApi;
  private boundPort = 0;
  /** Last request from the local MCP server (an AI app driving the engine). */
  private lastMcpSeenAt: string | null = null;

  /** Last successful broker read — served (flagged stale) on transient failures. */
  private lastGoodBroker: {
    positions: Awaited<ReturnType<Broker["getPositions"]>>;
    account: { cash: number; equity: number };
  } | null = null;

  constructor(private readonly deps: UiDeps) {
    this.settingsApi = new SettingsApi(deps.settings, deps.profile, deps.audit, deps.sources);
    this.connections = deps.connections ?? new ConnectionsApi(deps.settings, deps.audit);
  }

  /** Resolves with the bound port (useful with port 0 in tests). */
  start(): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error("Dashboard request failed", err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    this.server = server;

    this.timer = setInterval(() => {
      void this.broadcast();
    }, SNAPSHOT_INTERVAL_MS);
    this.timer.unref();

    return new Promise((resolve) => {
      server.listen(this.deps.settings.ui.port, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.deps.settings.ui.port;
        this.boundPort = port;
        log.info(`Dashboard: http://127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (req.headers["x-shadow-cortex-client"] === "mcp") {
      this.lastMcpSeenAt = new Date().toISOString();
      // Persist (throttled to 1/min) so the chip survives engine restarts.
      const stored = this.deps.store.state.localAiLastSeenAt;
      if (!stored || Date.parse(this.lastMcpSeenAt) - Date.parse(stored) > 60_000) {
        this.deps.store.state.localAiLastSeenAt = this.lastMcpSeenAt;
        this.deps.store.save();
      }
    }

    const json = (result: { status: number; body: unknown }): void => {
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    };

    if (req.method === "GET" && path === "/api/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await this.snapshot()));
      return;
    }

    if (path === "/mcp") {
      // The paste-a-link connector: Claude Desktop → Settings → Connectors →
      // Add custom connector → http://127.0.0.1:<port>/mcp. Stateless — a
      // fresh server+transport per request; tools proxy back into this same
      // process's API (loopback), so liveness tracking works unchanged.
      const { buildServer } = await import("../tools/mcp-server.js");
      const { StreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/streamableHttp.js"
      );
      this.lastMcpSeenAt = new Date().toISOString();
      const mcp = buildServer(`http://127.0.0.1:${this.boundPort}`);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }


    if (path === "/api/settings" || path === "/api/settings/validate") {
      try {
        if (req.method === "GET" && path === "/api/settings") {
          json(this.settingsApi.getSettings());
        } else if (req.method === "POST" && path === "/api/settings/validate") {
          json(this.settingsApi.validate(await readJsonBody(req)));
        } else if (req.method === "PUT" && path === "/api/settings") {
          const client = req.headers["x-shadow-cortex-client"];
          json(
            await this.settingsApi.put(
              await readJsonBody(req),
              typeof client === "string" ? client : "unknown",
            ),
          );
        } else {
          json({ status: 405, body: { error: { code: "method_not_allowed", message: req.method ?? "" } } });
        }
      } catch (err) {
        if (err instanceof BodyError) {
          json({ status: err.status, body: { error: { code: "bad_body", message: err.message } } });
        } else {
          throw err;
        }
      }
      return;
    }

    if (req.method === "GET" && path === "/api/portfolios") {
      json(await this.portfolios());
      return;
    }

    if (path.startsWith("/api/connections") || path === "/api/engine/restart") {
      try {
        await this.handleConnections(req, res, path, url, json);
      } catch (err) {
        if (err instanceof BodyError) {
          json({ status: err.status, body: { error: { code: "bad_body", message: err.message } } });
        } else {
          throw err;
        }
      }
      return;
    }

    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(await this.snapshot())}\n\n`);
      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
      return;
    }

    const action = path.match(/^\/api\/proposals\/([^/]+)\/(confirm|reject)$/);
    if (req.method === "POST" && action) {
      const [, id, verb] = action;
      const resolved = this.deps.confirm.resolve(id!, verb === "confirm");
      res.writeHead(resolved ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: resolved }));
      return;
    }

    if (req.method === "GET") {
      this.serveStatic(path, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  // --- connections (ShadowAlpha token, Robinhood OAuth, engine restart) ---

  private async handleConnections(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
    json: (result: { status: number; body: unknown }) => void,
  ): Promise<void> {
    if (req.method === "GET" && path === "/api/connections/local-ai/extension") {
      const { buildExtension } = await import("../tools/extension.js");
      const dxt = await buildExtension(`http://127.0.0.1:${this.boundPort}`);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="shadow-cortex.dxt"',
        "content-length": dxt.length,
      });
      res.end(dxt);
      return;
    }

    if (req.method === "GET" && path === "/api/connections") {
      json({
        status: 200,
        body: {
          ...this.connections.status(),
          // The local AI app (Claude Desktop etc.) connection: liveness +
          // a ready-to-paste setup snippet with the real absolute path.
          localAi: {
            lastSeenAt: this.lastMcpSeenAt ?? this.deps.store.state.localAiLastSeenAt ?? null,
            connectorUrl: `http://127.0.0.1:${this.boundPort}/mcp`,
            configSnippet: JSON.stringify(
              {
                mcpServers: {
                  "shadow-cortex": {
                    command: "npx",
                    args: ["-y", "tsx", `${process.cwd()}/src/tools/mcp-server.ts`],
                  },
                },
              },
              null,
              2,
            ),
          },
        },
      });
      return;
    }

    if (path === "/api/connections/shadowalpha") {
      if (req.method === "POST") {
        const body = (await readJsonBody(req)) as { token?: unknown };
        json(await this.connections.connectShadowAlpha(body?.token));
        return;
      }
      if (req.method === "DELETE") {
        json(this.connections.disconnectShadowAlpha());
        return;
      }
    }

    if (req.method === "POST" && path === "/api/connections/robinhood/start") {
      const callbackUrl = `http://127.0.0.1:${this.boundPort}/api/connections/robinhood/callback`;
      json(await this.connections.startRobinhoodOauth(callbackUrl));
      return;
    }

    if (req.method === "GET" && path === "/api/connections/robinhood/callback") {
      const outcome = await this.connections.finishRobinhoodOauth(
        url.searchParams.get("code"),
        url.searchParams.get("error"),
        url.searchParams.get("state"),
      );
      res.writeHead(outcome.status, { "content-type": "text/html" });
      res.end(outcome.html);
      return;
    }

    if (req.method === "DELETE" && path === "/api/connections/robinhood") {
      json(this.connections.disconnectRobinhood());
      return;
    }

    if (req.method === "POST" && path === "/api/engine/restart") {
      if (!this.deps.requestRestart) {
        json({
          status: 501,
          body: { error: { code: "restart_unavailable", message: "This engine was not started under the supervisor." } },
        });
        return;
      }
      json({ status: 200, body: { ok: true, restarting: true } });
      // Let the response flush before the process goes down.
      setTimeout(() => this.deps.requestRestart!(), 250);
      return;
    }

    json({ status: 405, body: { error: { code: "method_not_allowed", message: req.method ?? "" } } });
  }

  // --- portfolios (the rule-builder / sources picker) ---

  private async portfolios(): Promise<{ status: number; body: unknown }> {
    const source = this.deps.sources.find(
      (s): s is ShadowAlphaPortfolioSource => s instanceof ShadowAlphaPortfolioSource,
    );
    if (!source) {
      return {
        status: 404,
        body: {
          error: {
            code: "no_portfolio_source",
            message:
              'No shadowalpha-portfolio source configured — add one under "sources" in the profile to pick portfolios here.',
          },
        },
      };
    }
    try {
      const listing = await source.listPortfolios();
      return {
        status: 200,
        body: {
          portfolios: listing.map((p) => ({
            id: p.id ?? null,
            name: p.name ?? null,
            status: p.status ?? null,
            winRatePct: p.performance?.win_rate_pct ?? null,
            returnPct: p.performance?.total_return_pct ?? null,
          })),
        },
      };
    } catch (err) {
      return {
        status: 502,
        body: { error: { code: "portfolio_list_failed", message: String(err) } },
      };
    }
  }

  // --- snapshot ---

  private async snapshot(): Promise<Record<string, unknown>> {
    const { settings, store, broker, gate } = this.deps;
    const now = new Date();

    // Read-only view: merge broker truth with stored high-water marks WITHOUT
    // writing state — reconciliation belongs to the engine loops, not the UI.
    // A transiently failing broker read serves the last good values, flagged
    // stale — never fabricated zeros.
    let brokerStale = false;
    let brokerPositions: Awaited<ReturnType<typeof broker.getPositions>>;
    let account: { cash: number; equity: number };
    try {
      brokerPositions = await broker.getPositions();
      account = await broker.getAccount();
      this.lastGoodBroker = { positions: brokerPositions, account };
    } catch (err) {
      if (!this.lastGoodBroker) throw err;
      log.warn(`Broker read failed — serving last known account data (${String(err)})`);
      ({ positions: brokerPositions, account } = this.lastGoodBroker);
      brokerStale = true;
    }
    const positions: Position[] = brokerPositions.map((p) => {
      const hwm = Math.max(
        store.state.highWaterMarks[p.symbol] ?? Math.max(p.costBasis, p.currentPrice),
        p.currentPrice,
      );
      return {
        ...p,
        highWaterMark: hwm,
        unrealizedPnlPct:
          p.costBasis > 0 ? roundMoney(((p.currentPrice - p.costBasis) / p.costBasis) * 100) : 0,
      };
    });

    const anchor = store.state.dailyLossAnchor;
    const positionsValue = roundMoney(
      positions.reduce((sum, p) => sum + p.shares * p.currentPrice, 0),
    );

    return {
      status: {
        scenario: settings.scenario,
        mode: settings.mode,
        execution: settings.execution,
        decider: settings.decider,
        entriesHalted: gate.entriesHalted,
        marketOpen: isMarketOpen(now),
        marketHoursOnly: settings.marketHoursOnly,
        pendingRestart: this.settingsApi.pendingRestart(),
        savedProfileInvalid: this.settingsApi.savedProfileInvalid(),
        brokerStale,
        startedAt: this.startedAt,
      },
      account: {
        ...account,
        positionsValue,
        dailyPnl: anchor ? roundMoney(account.equity - anchor.equity) : 0,
        /** Day-start equity the daily P&L is measured against. */
        anchorEquity: anchor?.equity ?? account.equity,
        maxDailyLoss: settings.caps.maxDailyLoss,
      },
      positions,
      proposals: [...store.state.pendingProposals].reverse().slice(0, 25),
      awaitingConfirm: this.deps.confirm.list(),
      transactions: this.transactionsTail(),
      audit: this.auditTail(),
      now: now.toISOString(),
    };
  }

  /**
   * Executed orders (fills), newest first — read from the append-only audit
   * log, scoped to the current mode so paper fills never appear while
   * monitoring a live account (events before mode-stamping count as paper).
   */
  private transactionsTail(limit = 30): unknown[] {
    if (!existsSync(this.deps.auditPath)) return [];
    const lines = readFileSync(this.deps.auditPath, "utf8").trimEnd().split("\n");
    const out: unknown[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as {
          ts?: string;
          event?: string;
          data?: { result?: Record<string, unknown>; mode?: string };
        };
        if (entry.event !== "order_executed" || !entry.data?.result) continue;
        if ((entry.data.mode ?? "paper") !== this.deps.settings.mode) continue;
        out.push({ ts: entry.ts, ...entry.data.result });
      } catch {
        /* skip unparseable lines */
      }
    }
    return out;
  }

  private auditTail(): unknown[] {
    if (!existsSync(this.deps.auditPath)) return [];
    const lines = readFileSync(this.deps.auditPath, "utf8").trimEnd().split("\n");
    return lines
      .slice(-AUDIT_TAIL)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);
  }

  private async broadcast(): Promise<void> {
    // External profile edits (an agent, an editor) surface within one tick.
    this.settingsApi.refreshIfFileChanged();
    if (this.sseClients.size === 0) return;
    const data = `data: ${JSON.stringify(await this.snapshot())}\n\n`;
    for (const client of this.sseClients) client.write(data);
  }

  // --- static files (the built React app) ---

  private serveStatic(path: string, res: ServerResponse): void {
    const requested = path === "/" ? "/index.html" : path;
    const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const file = join(UI_DIST, safe);

    if (existsSync(file) && !file.includes("..")) {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    // SPA fallback → index.html; otherwise a help page if the UI isn't built.
    const index = join(UI_DIST, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(index));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      "<!doctype html><body style='font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:3rem'>" +
        "<h2>Shadow Cortex is running — the dashboard isn't built yet</h2>" +
        "<p>Build it once: <code>npm run ui:build</code>, then reload this page.</p>" +
        "<p>Or run the hot-reloading dev server: <code>npm run ui:dev</code> " +
        "(opens on its own port and proxies to this engine).</p>" +
        `<p>The JSON API is live either way: <a href="/api/snapshot" style="color:#58a6ff">/api/snapshot</a></p></body>`,
    );
  }
}
