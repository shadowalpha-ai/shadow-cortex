/**
 * `npm run robinhood:connect` — one-time interactive OAuth for the Robinhood
 * agentic-trading MCP. Registers the engine as its own OAuth client (dynamic
 * registration, PKCE public client), walks the browser flow via a loopback
 * callback, persists tokens to state/robinhood-oauth.json (0600), and
 * verifies the connection by listing accounts and printing the
 * agentic-enabled one (masked — this tool never prints tokens or full
 * account numbers).
 *
 * The engine itself never runs this flow: it reads the token file and fails
 * closed with a pointer here when interaction would be required.
 */

import { MCP_CLIENT_INFO } from "../sources/mcp-client.js";
import { findAgenticAccount } from "../execution/robinhood-shared.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider } from "../execution/robinhood-oauth.js";

const DEFAULT_URL = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_TOKEN_PATH = "state/robinhood-oauth.json";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

interface RawAccount {
  account_number?: string;
  nickname?: string;
  agentic_allowed?: boolean;
  state?: string;
}

function mask(accountNumber: string): string {
  return `••••${accountNumber.slice(-4)}`;
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;
  const tokenPath = process.env.ROBINHOOD_OAUTH_PATH ?? DEFAULT_TOKEN_PATH;

  // 1. Loopback callback listener on an ephemeral port.
  const server = createServer();
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out after 5 minutes waiting for the browser callback")),
      CALLBACK_TIMEOUT_MS,
    );
    timer.unref();
    server.on("request", (req, res) => {
      const requested = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (requested.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = requested.searchParams.get("code");
      const error = requested.searchParams.get("error");
      const state = requested.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html><body style='font-family:system-ui;padding:3rem'>" +
          (code
            ? "<h2>Shadow Cortex is connected to Robinhood.</h2><p>You can close this tab and return to the terminal.</p>"
            : `<h2>Authorization failed.</h2><p>${error ?? "No code returned."} Return to the terminal.</p>`) +
          "</body>",
      );
      clearTimeout(timer);
      const expectedState = provider.consumeState();
      if (code && expectedState && state !== expectedState) {
        reject(new Error("state mismatch — callback does not belong to this connection attempt"));
      } else if (code) resolve(code);
      else reject(new Error(`authorization failed: ${error ?? "no code returned"}`));
    });
  });

  // 2. Provider in interactive mode: it opens (or prints) the auth URL.
  const provider = new FileOAuthProvider(tokenPath, {
    redirectUrl,
    onRedirect: (authUrl) => {
      console.log("\nAuthorize Shadow Cortex in your browser (Robinhood will also ask in-app):\n");
      console.log(`  ${authUrl.toString()}\n`);
      if (process.platform === "darwin") {
        spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();
      }
    },
  });

  // 3. Connect; UnauthorizedError means the browser flow has been kicked off.
  console.log(`Connecting to ${url} …`);
  let client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  try {
    await client.connect(transport);
    console.log("Existing token is valid — no re-authorization needed.");
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    const code = await codePromise;
    await transport.finishAuth(code);
    // Fresh connection with the newly-saved tokens.
    client = new Client(MCP_CLIENT_INFO);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));
    console.log("Authorized — tokens saved.");
  }

  // 4. Verify: list accounts, show the agentic one (masked).
  const result = await client.callTool({ name: "get_accounts", arguments: {} });
  const agentic = findAgenticAccount(result) as RawAccount | null;

  if (!agentic?.account_number) {
    console.error(
      "\nConnected, but NO agentic-enabled account is accessible to this client.\n" +
        "Create and fund one in the Robinhood app (Investing → Agentic trading), then re-run this.",
    );
    process.exit(2);
  }

  console.log(`\nAgentic account found: ${mask(agentic.account_number)}${agentic.nickname ? ` ("${agentic.nickname}")` : ""}`);
  console.log(`Tokens: ${tokenPath} (owner-only permissions; never commit state/)`);
  console.log(
    '\nNext: in your profile set  "mode": "live", "liveBroker": "robinhood", "execution": "off"\n' +
      'and optionally "quoteSource": "broker" — the dashboard will monitor the real agentic\n' +
      "account without ever placing an order while execution is off.",
  );
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nrobinhood:connect failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
