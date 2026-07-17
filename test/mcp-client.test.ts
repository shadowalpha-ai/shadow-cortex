/**
 * MCP client plumbing: lenient JSON parsing for upstream payloads that emit
 * bare NaN/Infinity value tokens (observed live on the ShadowAlpha
 * leaderboard) — invalid JSON that must sanitize to null, never crash a poll.
 */

import { describe, expect, it } from "vitest";
import { parseLenientJson } from "../src/sources/mcp-client.js";

describe("lenient JSON parsing (upstream NaN guard)", () => {
  it("replaces bare NaN/Infinity value tokens with null", () => {
    const parsed = parseLenientJson('{"rating_score": NaN, "x": [1, Infinity, -Infinity]}') as {
      rating_score: unknown;
      x: unknown[];
    };
    expect(parsed.rating_score).toBeNull();
    expect(parsed.x).toEqual([1, null, null]);
  });

  it("leaves NaN inside string values untouched", () => {
    const parsed = parseLenientJson('{"quote": "this stock is NaN% overvalued", "v": NaN}') as {
      quote: string;
      v: unknown;
    };
    expect(parsed.quote).toBe("this stock is NaN% overvalued");
    expect(parsed.v).toBeNull();
  });
});
