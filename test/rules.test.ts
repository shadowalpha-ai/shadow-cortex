import { describe, expect, it } from "vitest";
import { RulesDecider } from "../src/deciders/rules.js";
import type { DecisionContext, Quote } from "../src/core/types.js";
import { makePosition, makeSettings, makeSignal } from "./helpers.js";

const decider = new RulesDecider();

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const quotes: Record<string, Quote> = {
    NVDA: { symbol: "NVDA", price: 100, asOf: new Date().toISOString() },
    PLTR: { symbol: "PLTR", price: 50, asOf: new Date().toISOString() },
  };
  return {
    signals: [],
    positions: [],
    quotes,
    equity: 10_000,
    settings: makeSettings(),
    now: new Date(),
    ...overrides,
  };
}

describe("rules decider entry logic", () => {
  it("fires on multi-source consensus", async () => {
    const proposals = await decider.decide(
      ctx({
        signals: [
          makeSignal({ source: "shadowalpha", strength: 0.5 }),
          makeSignal({ source: "my-screener", strength: 0.5, type: "alert" }),
        ],
      }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.action).toBe("buy");
    expect(proposals[0]!.symbol).toBe("NVDA");
    expect(proposals[0]!.contributingSignals).toHaveLength(2);
  });

  it("does not fire on a single weak source", async () => {
    const proposals = await decider.decide(
      ctx({ signals: [makeSignal({ strength: 0.5 })] }),
    );
    expect(proposals).toHaveLength(0);
  });

  it("fires on a strong single-source signal", async () => {
    const proposals = await decider.decide(
      ctx({ signals: [makeSignal({ strength: 0.8 })] }),
    );
    expect(proposals).toHaveLength(1);
  });

  it("ignores signals below minSignalStrength even in aggregate", async () => {
    const proposals = await decider.decide(
      ctx({
        signals: [
          makeSignal({ source: "a", strength: 0.3 }),
          makeSignal({ source: "b", strength: 0.35 }),
        ],
      }),
    );
    expect(proposals).toHaveLength(0);
  });

  it("is long-only: bearish signals never produce proposals", async () => {
    const proposals = await decider.decide(
      ctx({ signals: [makeSignal({ direction: "bearish", strength: 0.9 })] }),
    );
    expect(proposals).toHaveLength(0);
  });

  it("skips symbols already held (no scale-in)", async () => {
    const proposals = await decider.decide(
      ctx({
        signals: [makeSignal({ strength: 0.9 })],
        positions: [makePosition({ symbol: "NVDA" })],
      }),
    );
    expect(proposals).toHaveLength(0);
  });

  it("enforces type confluence via window.types cards", async () => {
    const settings = makeSettings({
      entry: {
        rules: [
          {
            label: "confluence",
            source: null,
            symbols: [],
            constraints: [
              { field: "strength", op: ">=", value: 0.4 },
              { field: "window.types", op: "has", value: "consensus" },
              { field: "window.types", op: "has", value: "buzz" },
            ],
          },
        ],
      },
    });
    const withoutBuzz = await decider.decide(
      ctx({ settings, signals: [makeSignal({ strength: 0.9 })] }),
    );
    expect(withoutBuzz).toHaveLength(0);

    const withBuzz = await decider.decide(
      ctx({
        settings,
        signals: [
          makeSignal({ strength: 0.9 }),
          makeSignal({ type: "buzz", strength: 0.5 }),
        ],
      }),
    );
    expect(withBuzz).toHaveLength(1);
  });

  it("sizes fixed-dollar orders fractionally and sets a protective stop", async () => {
    const proposals = await decider.decide(ctx({ signals: [makeSignal({ strength: 0.9 })] }));
    const p = proposals[0]!;
    expect(p.suggestedShares).toBeCloseTo(0.25); // $25 / $100
    expect(p.referencePrice).toBe(100);
    expect(p.protectiveStop).toBe(95); // default stopLossPct 5
  });

  it("skips symbols with no quote", async () => {
    const proposals = await decider.decide(
      ctx({ signals: [makeSignal({ symbol: "ZZZZ", strength: 0.9 })] }),
    );
    expect(proposals).toHaveLength(0);
  });
});
