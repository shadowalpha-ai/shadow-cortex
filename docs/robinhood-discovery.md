# Robinhood MCP discovery readout

The official Robinhood agentic-trading MCP (live since May 2026, beta,
endpoint `https://agent.robinhood.com/mcp/trading`) is the reference live
broker. **The read-tool discovery ran on 2026-07-15** against a real, funded
agentic account; scrubbed captures live in
`experimental/robinhood-mcp/sample-payloads.json` and the adapter's read
mappings conform to them. Write-tool (order) response shapes remain uncaptured
— that requires placing a real order and stays behind an explicit human
go-ahead.

## Verified findings (2026-07-15)

### Response envelope & types

- **Every response is wrapped `{"data": {...}, "guide": "..."}`.** `guide` is
  prose telling the calling AI how to present the data (which fields are
  authoritative, display masking rules, fallback logic). Adapters unwrap
  `data` and ignore `guide` — but the guides are excellent embedded docs;
  read them when extending the adapter.
- **All numerics are strings**, often high-precision (`"12.3400"`,
  `"211.790000"`). Coerce and reject NaN (`num()` in the adapter).

### Account model (containment is real and enforced)

- **`get_accounts`** (no params) lists all brokerage accounts with an
  `agentic_allowed` boolean. It is **caller-relative**: `true` means *this
  agent* may act on the account. The user's main/default account and other
  cash accounts read `false`; only the dedicated agentic account reads `true`.
- **Every account-scoped tool requires `account_number`** (`get_portfolio`,
  `get_equity_positions`, `get_equity_orders`, `get_equity_tradability`,
  order tools). There is no implicit "current account" — calling with the
  default account's number happily returns the *main* account's data, so the
  adapter discovers the agentic account itself (`accountNumber()` in
  `broker.ts`) instead of trusting config.

### Portfolio & positions

- `get_portfolio` → `data.{total_value, equity_value, options_value, cash,
  pending_deposits, currency, buying_power:{buying_power,
  unleveraged_buying_power, display_currency}}`. **`buying_power.buying_power`
  is the authoritative spendable figure** (per its own guide); the adapter
  maps it to engine `cash`, and `total_value` to `equity`.
- `get_equity_positions` → `data.positions[]` with `quantity`,
  `intraday_quantity`, `shares_available_for_sells`, `average_buy_price`,
  `type`. **No market price on rows** — the guide says to join with
  `get_equity_quotes`; the adapter batches one quote call for all held
  symbols. `average_buy_price` may be omitted while a position reconciles
  (adapter falls back to current price as a conservative provisional basis).

### Quotes (management-loop pricing)

- `get_equity_quotes` → `data.results[]`, each pairing `quote` (live) with
  `close` (official prior-session settled close). The live quote carries BOTH
  `last_trade_price` (regular session) and `last_non_reg_trade_price`
  (extended hours), each with a venue timestamp — **current price = whichever
  print is fresher**, which the adapter implements. Bid/ask and
  `previous_close` are present. Quotes DO come back outside regular hours
  (captured pre-market: extended-hours print was the fresh one), so the
  management loop can value positions and track high-water marks off-hours.

### Orders & tradability

- `get_equity_orders` requires `account_number`; supports `placed_agent`
  filtering (agent-placed orders are distinguishable — useful for audit).
  Dollar-based orders may report `quantity: null` until fills accumulate.
- `review_equity_order` / `place_equity_order` accept **either `quantity` or
  `dollar_amount`** (notional dollar orders are first-class), plus
  `limit_price`/`stop_price`/`time_in_force`/`market_hours`, and `ref_id`
  (idempotency UUID) on place. Quantity is a **string** in the schema —
  fractional supported. Per the tradability guide, **fractional and
  dollar-based orders execute only in regular market hours**.
- `get_equity_tradability` confirms per-symbol/per-account tradability
  including `fractional_tradability` — NVDA/PLTR: fractional-tradable.

### The full catalog (48 tools)

Beyond what the adapter uses today: equity historicals + **server-computed
technical indicators** (`get_equity_technical_indicators`: RSI, MACD,
Bollinger, SMA…), fundamentals, level-2 book, earnings calendar/results, full
options data + single-leg option orders, watchlists (CRUD), and saved
**scanners** (`create_scan`/`run_scan`). A future TA signal source can lean on
Robinhood's own indicator computation instead of computing in-house.

### get_equity_technical_indicators — shape CAPTURED 2026-07-17

Captured live through the engine's own OAuth (NVDA, `interval: "day"`);
trimmed samples in `sample-payloads.json`, mapping pinned in
`src/enrichment/robinhood-ta.ts` (no longer provisional).

- **Envelope**: `{data: {symbol, interval, bounds, indicators: [{type,
  params, series: [{begins_at, …}]}]}, guide}`. Series is chronological
  (oldest → newest); values are **numbers** — unlike the account endpoints'
  string numerics.
- **Per-point keys by type**: `rsi`/`sma`/`ema` → `value`; `macd` →
  `histogram`/`macd`/`signal`; `bollinger_bands` → `lower`/`middle`/`upper`.
- **Wire names**: `type: "bollinger"` is REJECTED (`invalid indicator
  type`) — the name is `bollinger_bands`. Full accepted list: ema, sma,
  rsi, momentum, roc, cci, williams_r, atr, mfi, adx, donchian_channels,
  bollinger_bands, macd, keltner_channels, supertrend, vwap, obv,
  pivot_points — plenty of headroom for future `ta.*` menu growth (ATR,
  ADX, VWAP…).
- Params: `period` for ema/sma/rsi (+cci/atr/mfi/etc.), the
  `fast_period`/`slow_period`/`signal_period` trio for macd, `num_std` for
  bollinger_bands. `bounds` (regular/extended), `adjustment_type`
  (none/split/all), and `end_time` exist; the provider uses the defaults.

## Engine-side OAuth observations (2026-07-16)

Captured while building the engine's own connection (dashboard Connections
panel / `npm run robinhood:connect`):

- **Authorization-server metadata** (`agent.robinhood.com/.well-known/
  oauth-authorization-server/mcp/trading`): authorize =
  `https://robinhood.com/oauth`, token = `https://api.robinhood.com/oauth2/token/`,
  dynamic registration = `https://agent.robinhood.com/oauth/trading/register`,
  scopes = `["internal"]` (the only one), PKCE S256, public clients
  (`token_endpoint_auth_methods_supported: ["none"]`).
- **Dynamic registration works** — a client_id is issued — but the server
  ignores the requested `client_name` and returns its own (observed:
  "Robinhood Trading"). Redirect URIs echo back as requested (loopback
  `http://127.0.0.1:<port>/...` accepted).
- **Open issue:** a spec-correct authorize URL (code + PKCE + registered
  client + scope internal + resource) initially landed the user on the
  `/agentic` settings page with NO consent prompt. The one deviation from
  known-working flows was a missing `state` parameter — now added (also the
  proper CSRF check). If consent still doesn't render in the browser, check
  the **Robinhood mobile app** for a pending approval — the product's
  connection model is browser + in-app approval.

## Auth & unattended operation (partially answered)

- **Initial OAuth is one-time-interactive** (browser + Robinhood app approval)
  — confirmed. The registered agent shows as "Claude" in Robinhood's
  `/agentic` settings page.
- **Client-version pitfall (observed):** OAuth completed on Claude Code CLI
  2.1.70 stored an unusable (empty) token while `claude mcp list` still showed
  "✓ Connected" (that check is reachability, not auth). Re-authenticating on
  CLI ≥ 2.1.210 fixed it. If tools report "requires authentication" despite a
  green checkmark: `claude install latest`, then `/mcp` → re-authenticate.
- **Token lifetime / silent-refresh behavior: still unknown.** Needs a
  multi-hour observation window before scenarios 1/2 are recommended
  unattended on this MCP. Record findings here.
- **Rate limits: not yet probed** under polling load.
- **ToS / design-intent:** the MCP is built for interactive agent use with a
  human present; confirm unattended programmatic polling is permitted before
  recommending scenarios 1/2 on it.

## Still to capture (needs explicit go-ahead — real order)

- [ ] `review_equity_order` response — exact preview/warning structure (the
      pre-trade safety surface). The adapter's warning extraction is
      defensive-by-guess until then.
- [ ] `place_equity_order` response — state values, fill representation,
      partial fills, timestamps.
- [ ] A real (non-empty) `get_equity_positions` row — the fixture row is
      synthesized from the tool's own field guide; re-capture after the first
      real fill, including whether `created_at` exists on rows.
- [ ] Token lifetime & refresh behavior (see above).

## How this was captured (repeatable procedure)

From a Claude Code session in this repo (the MCP is registered in project
config), headless nested calls work:

```sh
env -u CLAUDECODE ~/.local/bin/claude -p \
  'Call the robinhood-trading tool <name> with <args> and print the raw JSON result verbatim.' \
  --allowedTools "mcp__robinhood-trading" --max-turns 12
```

(`CLAUDECODE` must be unset to bypass the nested-session guard; use the
up-to-date binary — see the version pitfall above.) Scrub account numbers,
nicknames, and balances before pasting captures into
`sample-payloads.json`; `npm test` then pins the mappings.
