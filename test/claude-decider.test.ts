/**
 * Claude decider cost brakes: bursts DEFER (retried via wantsRetry, never
 * dropped), a spent daily budget skips LOUDLY via onSkip, and both knobs
 * disable with null. All against a fake Anthropic client — no key, no
 * network.
 */

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeDecider } from "../src/deciders/claude.js";
import type { DecisionContext } from "../src/core/types.js";
import { makeSettings, makeSignal } from "./helpers.js";

function fakeClient(): { client: Anthropic; calls: () => number } {
  let n = 0;
  const client = {
    messages: {
      create: async () => {
        n += 1;
        return {
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decisions: [{ symbol: "NVDA", action: "buy", reasoning: "test" }],
              }),
            },
          ],
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => n };
}

function ctxAt(
  now: Date,
  onSkip?: DecisionContext["onSkip"],
): DecisionContext {
  return {
    signals: [makeSignal({ strength: 0.9 })],
    positions: [],
    quotes: { NVDA: { symbol: "NVDA", price: 100, asOf: now.toISOString() } },
    equity: 10_000,
    settings: makeSettings(),
    now,
    onSkip,
  };
}

function decider(
  overrides: Partial<{ maxCallsPerDay: number | null; minSecondsBetweenCalls: number | null }>,
) {
  const { client, calls } = fakeClient();
  const d = new ClaudeDecider(
    { model: "claude-opus-4-8", maxCallsPerDay: 500, minSecondsBetweenCalls: 30, ...overrides },
    client,
  );
  return { d, calls };
}

const T0 = new Date("2026-07-17T14:00:00Z");
const plus = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("min-interval throttle", () => {
  it("defers a burst and retries it after the interval — delayed, not dropped", async () => {
    const { d, calls } = decider({ minSecondsBetweenCalls: 30 });

    expect(await d.decide(ctxAt(T0))).toHaveLength(1); // first call goes through
    expect(calls()).toBe(1);

    expect(await d.decide(ctxAt(plus(10)))).toEqual([]); // burst: deferred
    expect(calls()).toBe(1); // no API call spent
    expect(d.wantsRetry(plus(10))).toBe(false); // interval not yet passed
    expect(d.wantsRetry(plus(31))).toBe(true); // now the loop should re-ask

    expect(await d.decide(ctxAt(plus(31)))).toHaveLength(1); // retry decides the window
    expect(calls()).toBe(2);
    expect(d.wantsRetry(plus(31))).toBe(false); // nothing pending anymore
  });

  it("null disables the interval brake", async () => {
    const { d, calls } = decider({ minSecondsBetweenCalls: null });
    await d.decide(ctxAt(T0));
    await d.decide(ctxAt(plus(1)));
    expect(calls()).toBe(2);
  });
});

describe("daily call budget", () => {
  it("skips loudly once spent and resumes the next UTC day", async () => {
    const { d, calls } = decider({ maxCallsPerDay: 1, minSecondsBetweenCalls: null });

    expect(await d.decide(ctxAt(T0))).toHaveLength(1);
    expect(calls()).toBe(1);

    const skips: Array<{ symbol: string; reason: string }> = [];
    expect(await d.decide(ctxAt(plus(60), (s) => skips.push(s)))).toEqual([]);
    expect(calls()).toBe(1); // budget blocked the API call
    expect(skips).toHaveLength(1);
    expect(skips[0]!.symbol).toBe("NVDA");
    expect(skips[0]!.reason).toContain("budget");
    expect(d.wantsRetry(plus(120))).toBe(false); // budget is not a deferral

    const nextDay = new Date("2026-07-18T00:01:00Z");
    expect(await d.decide(ctxAt(nextDay))).toHaveLength(1); // day rolled over
    expect(calls()).toBe(2);
  });
});
