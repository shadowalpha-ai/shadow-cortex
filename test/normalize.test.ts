import { describe, expect, it } from "vitest";
import {
  clampStrength,
  directionFromSign,
  makeDedupeKey,
  roundMoney,
  roundShares,
} from "../src/core/normalize.js";
import { ShadowAlphaSource } from "../src/sources/shadowalpha.js";
import type { McpToolClient } from "../src/sources/mcp-client.js";

function fakeMcp(response: unknown): McpToolClient {
  return { callTool: async () => response };
}

describe("normalization helpers", () => {
  it("clamps strength into 0..1 and zeroes non-finite input", () => {
    expect(clampStrength(1.4)).toBe(1);
    expect(clampStrength(-0.2)).toBe(0);
    expect(clampStrength(Number.NaN)).toBe(0);
    expect(clampStrength(0.55)).toBe(0.55);
  });

  it("maps signed values to directions", () => {
    expect(directionFromSign(82)).toBe("bullish");
    expect(directionFromSign(-3)).toBe("bearish");
  });

  it("buckets dedupe keys by time window", () => {
    const a = makeDedupeKey("src", "nvda", "consensus", "2026-07-14T10:01:00Z", 30);
    const b = makeDedupeKey("src", "NVDA", "consensus", "2026-07-14T10:20:00Z", 30);
    const c = makeDedupeKey("src", "NVDA", "consensus", "2026-07-14T10:45:00Z", 30);
    expect(a).toBe(b); // same 30-minute bucket, case-insensitive symbol
    expect(a).not.toBe(c); // next bucket
  });

  it("rounds shares to 6dp and money to cents", () => {
    expect(roundShares(0.1234567)).toBe(0.123457);
    expect(roundMoney(10.005)).toBe(10.01);
  });
});

describe("ShadowAlpha adapter normalization", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    symbol: "NVDA",
    opp: 82,
    spike_ratio: 9.5,
    bullish_count: 14,
    bearish_count: 3,
    buy_zone_active: true,
    timestamp: "2026-07-14T10:00:00Z",
    ...overrides,
  });

  it("maps opp to a consensus signal and spike_ratio to a buzz signal", async () => {
    const source = new ShadowAlphaSource(fakeMcp({ ideas: [row()] }), 0.3, 30);
    const signals = await source.poll();
    expect(signals).toHaveLength(2);

    const consensus = signals.find((s) => s.type === "consensus")!;
    expect(consensus.direction).toBe("bullish");
    expect(consensus.strength).toBeCloseTo(0.82);
    expect(consensus.confidence).toBe(0.9); // buy_zone_active

    const buzz = signals.find((s) => s.type === "buzz")!;
    expect(buzz.strength).toBeCloseTo(9.5 / 20);
    expect(buzz.direction).toBe("bullish"); // bullish_count > bearish_count
  });

  it("maps negative opp to bearish", async () => {
    const source = new ShadowAlphaSource(
      fakeMcp({ ideas: [row({ opp: -60, spike_ratio: 0 })] }),
      0.3,
      30,
    );
    const signals = await source.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.direction).toBe("bearish");
  });

  it("skips rows with missing or zero opp (null-as-0.0 trap)", async () => {
    const source = new ShadowAlphaSource(
      fakeMcp({ ideas: [row({ opp: 0 }), row({ opp: null }), row({ symbol: undefined })] }),
      0,
      30,
    );
    expect(await source.poll()).toHaveLength(0);
  });

  it("filters signals below minStrength", async () => {
    const source = new ShadowAlphaSource(
      fakeMcp({ ideas: [row({ opp: 20, spike_ratio: 0 })] }),
      0.5,
      30,
    );
    expect(await source.poll()).toHaveLength(0);
  });

  it("survives empty and malformed responses without throwing", async () => {
    expect(await new ShadowAlphaSource(fakeMcp(null), 0.3, 30).poll()).toEqual([]);
    expect(await new ShadowAlphaSource(fakeMcp("oops"), 0.3, 30).poll()).toEqual([]);
    expect(await new ShadowAlphaSource(fakeMcp({}), 0.3, 30).poll()).toEqual([]);
  });

  it("produces identical dedupe keys for the same upstream event", async () => {
    const source = new ShadowAlphaSource(fakeMcp({ ideas: [row()] }), 0.3, 30);
    const first = await source.poll();
    const second = await source.poll();
    expect(first[0]!.dedupeKey).toBe(second[0]!.dedupeKey);
  });
});
