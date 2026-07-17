/**
 * Credential resolution — one place that answers "what token does the engine
 * use for ShadowAlpha?".
 *
 * Precedence: the SHADOWALPHA_MCP_TOKEN environment variable wins; otherwise
 * the token saved by the dashboard's Connections panel
 * (state/shadowalpha-token.json — owner-only file in the gitignored state/
 * dir). Profiles NEVER hold credentials; this module is why they don't have
 * to.
 *
 * SECURITY: nothing here logs a token, and status helpers expose only
 * presence — never the value.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomic } from "../core/atomic-write.js";

interface TokenFile {
  token?: string;
}

function readTokenFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as TokenFile;
    return typeof doc.token === "string" && doc.token.length > 0 ? doc.token : null;
  } catch {
    return null;
  }
}

/** The token the engine should use, or undefined (sources then run fixture-only). */
export function resolveShadowAlphaToken(tokenPath: string): string | undefined {
  return process.env.SHADOWALPHA_MCP_TOKEN ?? readTokenFile(tokenPath) ?? undefined;
}

/** Where the current token comes from — for the Connections panel status. */
export function shadowAlphaTokenSource(tokenPath: string): "env" | "file" | null {
  if (process.env.SHADOWALPHA_MCP_TOKEN) return "env";
  if (readTokenFile(tokenPath)) return "file";
  return null;
}

/** Persist a token from the Connections panel (atomic, owner-only). */
export function saveShadowAlphaToken(tokenPath: string, token: string): void {
  writeJsonAtomic(tokenPath, { token }, { mode: 0o600 });
}

export function deleteShadowAlphaToken(tokenPath: string): void {
  if (existsSync(tokenPath)) unlinkSync(tokenPath);
}
