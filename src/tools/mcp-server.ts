/**
 * Shadow Cortex MCP server — the chat-AI control surface.
 *
 * Coding agents drive the engine by editing the profile file; chat apps
 * (Claude Desktop, or any MCP-capable client) drive it through THIS: a stdio
 * MCP server that wraps the engine's localhost HTTP API as tools. The AI can
 * monitor the account, read and change the strategy (same fail-closed
 * validation as every other path), confirm or reject proposals, and start or
 * restart the engine.
 *
 * SECURITY MODEL: this process talks only to 127.0.0.1 — it exposes nothing
 * on any network; the MCP client owns the stdio pipe. Every mutation goes
 * through the engine's own gates: strategy saves through fail-closed
 * validation (with the same explicit-consent handshake for enabling auto
 * execution), and confirming a proposal is exactly the dashboard's Confirm
 * button — caps, price bands, and market-hours checks still decide whether
 * anything executes. The AI gets a steering wheel, not a bypass.
 *
 * Register in Claude Desktop (claude_desktop_config.json):
 *   { "mcpServers": { "shadow-cortex": {
 *       "command": "npx",
 *       "args": ["-y", "tsx", "/ABS/PATH/TO/repo/src/tools/mcp-server.ts"] } } }
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// When running from the packaged Claude Desktop extension, the repo path is
// baked into the bundle's env; from the repo, derive it from this file.
const REPO_ROOT = process.env.SHADOW_CORTEX_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_ENGINE_URL = process.env.SHADOW_CORTEX_URL ?? "http://127.0.0.1:7777";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function buildServer(engineUrl: string = DEFAULT_ENGINE_URL): McpServer {
  const server = new McpServer({ name: "shadow-cortex", version: "0.1.0" });

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${engineUrl}${path}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), "x-shadow-cortex-client": "mcp" },
      });
    } catch {
      throw new Error(
        `The engine isn't reachable at ${engineUrl}. Start it with the start_engine tool (or \`npm run dev\` in ${REPO_ROOT}).`,
      );
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; issues?: Array<{ path: string; message: string }> };
    } | null;
    if (!res.ok) {
      const message = body?.error?.message ?? `engine returned HTTP ${res.status} for ${path}`;
      const issues = body?.error?.issues;
      // Surface the structured issues — the AI needs them to fix the document.
      throw new Error(
        issues?.length
          ? `${message}\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`
          : message,
      );
    }
    return body;
  }

  const run = (fn: () => Promise<ToolResult>) => async (): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return text(String(err instanceof Error ? err.message : err), true);
    }
  };

  server.registerTool(
    "get_status",
    {
      description:
        "Engine status + account snapshot: mode, execution posture, market state, cash/equity/daily P&L, position count, proposals awaiting confirmation.",
    },
    run(async () => {
      const s = (await api("/api/snapshot")) as Record<string, any>;
      return text({
        status: s.status,
        account: s.account,
        positionCount: s.positions.length,
        awaitingConfirmation: s.awaitingConfirm.map((a: any) => ({
          id: a.proposal.id,
          summary: `${a.proposal.action.toUpperCase()} ${a.proposal.symbol} — ${a.proposal.rationale}`,
        })),
      });
    }),
  );

  server.registerTool(
    "get_positions",
    { description: "Open positions with cost basis, current price, peak, and unrealized P&L." },
    run(async () => text(((await api("/api/snapshot")) as Record<string, any>).positions)),
  );

  server.registerTool(
    "get_proposals",
    {
      description:
        "Recent proposals (open and resolved) with rationales, plus which ones are awaiting a confirm/reject decision right now.",
    },
    run(async () => {
      const s = (await api("/api/snapshot")) as Record<string, any>;
      return text({ proposals: s.proposals, awaitingConfirm: s.awaitingConfirm });
    }),
  );

  server.registerTool(
    "get_transactions",
    { description: "Executed fills (buys/sells) for the current book, newest first." },
    run(async () => text(((await api("/api/snapshot")) as Record<string, any>).transactions)),
  );

  server.registerTool(
    "get_audit",
    {
      description: "The tail of the append-only audit log — every signal, proposal, decision, and fill.",
    },
    run(async () => text(((await api("/api/snapshot")) as Record<string, any>).audit)),
  );

  server.registerTool(
    "confirm_proposal",
    {
      description:
        "Approve a proposal awaiting confirmation — equivalent to the dashboard's Confirm button. If the engine's gates (caps, price band, market hours) pass, THE ORDER EXECUTES. Get ids from get_status/get_proposals.",
      inputSchema: { id: z.string().describe("Proposal id, e.g. prop_...") },
    },
    async ({ id }: { id: string }) => {
      try {
        await api(`/api/proposals/${encodeURIComponent(id)}/confirm`, { method: "POST" });
        return text(`Confirmed ${id}. The execution gate decides from here; check get_transactions / get_audit for the outcome.`);
      } catch (err) {
        return text(String(err instanceof Error ? err.message : err), true);
      }
    },
  );

  server.registerTool(
    "reject_proposal",
    {
      description: "Decline a proposal awaiting confirmation (starts the symbol's rejection cooldown).",
      inputSchema: { id: z.string() },
    },
    async ({ id }: { id: string }) => {
      try {
        await api(`/api/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" });
        return text(`Rejected ${id}.`);
      } catch (err) {
        return text(String(err instanceof Error ? err.message : err), true);
      }
    },
  );

  server.registerTool(
    "get_strategy",
    {
      description:
        "The full strategy: running settings, what's saved on disk, whether a restart is pending, and the field catalog for building entry rules. ALWAYS call this fresh before reporting the strategy — never answer from memory of an earlier read, and quote the response's asOf timestamp so the user can see how current it is.",
    },
    run(async () => text(await api("/api/settings"))),
  );

  server.registerTool(
    "validate_strategy",
    {
      description:
        "Dry-run a FULL settings document through the engine's fail-closed validation without saving. Always validate before save_strategy. Round-trip the whole document from get_strategy's saved.raw (or active) — never a fragment.",
      inputSchema: { settings: z.record(z.string(), z.unknown()).describe("The complete settings document") },
    },
    async ({ settings }: { settings: Record<string, unknown> }) => {
      try {
        return text(
          await api("/api/settings/validate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ settings }),
          }),
        );
      } catch (err) {
        return text(String(err instanceof Error ? err.message : err), true);
      }
    },
  );

  server.registerTool(
    "save_strategy",
    {
      description:
        "Save a FULL settings document as the active profile (applies on restart — call restart_engine after). Enabling auto execution requires confirmAuto: true, mirroring the dashboard's explicit-consent modal; only pass it when the user has clearly said they want autonomous execution.",
      inputSchema: {
        settings: z.record(z.string(), z.unknown()),
        confirmAuto: z.boolean().optional(),
      },
    },
    async ({ settings, confirmAuto }: { settings: Record<string, unknown>; confirmAuto?: boolean }) => {
      try {
        return text(
          await api("/api/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ settings, ...(confirmAuto ? { confirmAuto: true } : {}) }),
          }),
        );
      } catch (err) {
        return text(String(err instanceof Error ? err.message : err), true);
      }
    },
  );

  server.registerTool(
    "list_portfolios",
    { description: "The user's ShadowAlpha portfolios/curations (for copy-trading rules)." },
    run(async () => text(await api("/api/portfolios"))),
  );

  server.registerTool(
    "get_connections",
    { description: "Whether ShadowAlpha and Robinhood are connected (booleans and a masked account only)." },
    run(async () => text(await api("/api/connections"))),
  );

  server.registerTool(
    "restart_engine",
    {
      description:
        "Restart the running engine so saved settings/connections apply. The supervisor respawns it within a couple of seconds.",
    },
    run(async () => {
      await api("/api/engine/restart", { method: "POST" });
      return text("Restarting — the supervisor respawns the engine in a few seconds. Re-check with get_status.");
    }),
  );

  server.registerTool(
    "start_engine",
    {
      description:
        "Start the engine (supervised `npm run dev`) if it isn't running. Uses the repo's default profile; the engine's own safe defaults and gates apply.",
    },
    run(async () => {
      try {
        await api("/api/snapshot");
        return text(`The engine is already running at ${engineUrl}.`);
      } catch {
        /* not running — start it */
      }
      spawn("npm", ["run", "dev"], { cwd: REPO_ROOT, detached: true, stdio: "ignore" }).unref();
      return text(
        `Starting the engine from ${REPO_ROOT} (supervised). Give it a few seconds, then call get_status; the dashboard will be at ${engineUrl}.`,
      );
    }),
  );

  return server;
}

/**
 * Liveness heartbeat: ping the engine (with the client header) immediately
 * and every `intervalMs`, so the dashboard's "Local AI application" chip
 * shows Active as soon as the MCP host launches this server — not only
 * after the first tool call. Fire-and-forget: an unreachable engine is
 * fine (the chip just stays grey until it's back). The timer is unref'd so
 * it never keeps the process alive; callers (tests) may clearInterval it.
 */
export function startLivenessHeartbeat(
  engineUrl: string = DEFAULT_ENGINE_URL,
  intervalMs = 5 * 60_000,
): NodeJS.Timeout {
  const ping = async (): Promise<void> => {
    try {
      await fetch(`${engineUrl}/api/connections`, {
        headers: { "x-shadow-cortex-client": "mcp" },
      });
    } catch {
      /* engine not running — nothing to mark */
    }
  };
  void ping();
  const timer = setInterval(() => void ping(), intervalMs);
  timer.unref?.();
  return timer;
}

// Entry point: serve over stdio (what Claude Desktop launches).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = buildServer();
  startLivenessHeartbeat();
  await server.connect(new StdioServerTransport());
}
