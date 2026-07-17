/**
 * Shared Robinhood MCP parsing: the {data, guide} envelope, the everything-
 * is-a-string numerics, and agentic-account discovery — used by the broker,
 * the TA enricher, the dashboard connection flow, and the CLI connector.
 * One copy so the mappings can't silently drift; captured shapes live in
 * experimental/robinhood-mcp/sample-payloads.json.
 */

/** Every Robinhood MCP response wraps its payload as {data, guide}. */
export function unwrap(result: unknown): unknown {
  if (result && typeof result === "object" && "data" in result) {
    return (result as { data: unknown }).data;
  }
  return result;
}

/** Robinhood returns numerics as strings ("12.3400") — coerce, never let NaN through. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The active agentic-enabled account row out of a raw `get_accounts` tool
 * result (structuredContent when present, else the first text block).
 * Returns null when this login has no active agentic account.
 */
export function findAgenticAccount(result: unknown): Record<string, unknown> | null {
  const r = result as { structuredContent?: unknown; content?: unknown };
  const structured =
    (r.structuredContent as
      | { data?: { accounts?: Array<Record<string, unknown>> } }
      | undefined) ??
    (() => {
      const content = r.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.find((c) => c.type === "text")?.text;
      return text
        ? (JSON.parse(text) as { data?: { accounts?: Array<Record<string, unknown>> } })
        : undefined;
    })();
  const accounts =
    structured?.data?.accounts ??
    (structured as { accounts?: Array<Record<string, unknown>> } | undefined)?.accounts ??
    [];
  return accounts.find((a) => a.agentic_allowed === true && a.state === "active") ?? null;
}
