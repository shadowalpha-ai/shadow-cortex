/**
 * Entry rule-card evaluator tests: the op table, per-signal vs window.*
 * scopes, source/symbol filters, fail-closed on missing fields, cards-OR /
 * constraints-AND, and the DEFAULT_ENTRY_RULES posture.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTRY_RULES,
  describeRule,
  evaluateRulesForSymbol,
  type EntryRule,
} from "../src/entry/rules.js";
import { makeSignal } from "./helpers.js";

const now = new Date();

function rule(overrides: Partial<EntryRule> = {}): EntryRule {
  return {
    label: "test rule",
    source: null,
    symbols: [],
    constraints: [{ field: "strength", op: ">=", value: 0.5 }],
    ...overrides,
  };
}

describe("constraint ops", () => {
  const cases: Array<[string, number | string | boolean, boolean]> = [
    [">=", 0.8, true],
    [">=", 0.81, false],
    [">", 0.79, true],
    [">", 0.8, false],
    ["<=", 0.8, true],
    ["<", 0.8, false],
    ["==", 0.8, true],
    ["!=", 0.8, false],
    ["!=", 0.5, true],
  ];
  for (const [op, value, expected] of cases) {
    it(`strength(0.8) ${op} ${value} → ${expected}`, () => {
      const match = evaluateRulesForSymbol(
        "NVDA",
        [makeSignal({ strength: 0.8 })],
        [rule({ constraints: [{ field: "strength", op: op as never, value }] })],
        now,
      );
      expect(match !== null).toBe(expected);
    });
  }

  it("string equality works on universal and published fields", () => {
    const signals = [makeSignal({ type: "prediction", fields: { sector: "Energy" } })];
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "type", op: "==", value: "prediction" }] })],
        now,
      ),
    ).not.toBeNull();
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "sector", op: "!=", value: "Tech" }] })],
        now,
      ),
    ).not.toBeNull();
  });

  it("boolean fields compare with ==", () => {
    const signals = [makeSignal({ fields: { buyZone: true } })];
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "buyZone", op: "==", value: true }] })],
        now,
      ),
    ).not.toBeNull();
  });

  it("numeric ops on non-numeric values fail closed", () => {
    const signals = [makeSignal({ fields: { sector: "Energy" } })];
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "sector", op: ">=", value: 5 }] })],
        now,
      ),
    ).toBeNull();
  });

  it("missing fields fail every op, including != (fail closed)", () => {
    const signals = [makeSignal()]; // no confidence, no custom fields
    for (const op of ["==", "!=", ">=", "<"] as const) {
      expect(
        evaluateRulesForSymbol(
          "NVDA",
          signals,
          [rule({ constraints: [{ field: "nonexistent", op, value: 1 }] })],
          now,
        ),
      ).toBeNull();
    }
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "confidence", op: ">=", value: 0.1 }] })],
        now,
      ),
    ).toBeNull();
  });

  it("ageMinutes is computed from the signal timestamp", () => {
    const old = makeSignal({ timestamp: new Date(now.getTime() - 90 * 60_000).toISOString() });
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        [old],
        [rule({ constraints: [{ field: "ageMinutes", op: "<=", value: 60 }] })],
        now,
      ),
    ).toBeNull();
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        [old],
        [rule({ constraints: [{ field: "ageMinutes", op: ">", value: 60 }] })],
        now,
      ),
    ).not.toBeNull();
  });
});

describe("window.* constraints", () => {
  const signals = [
    makeSignal({ source: "shadowalpha", type: "consensus", strength: 0.6 }),
    makeSignal({ source: "my-screener", type: "alert", strength: 0.5 }),
  ];

  it("evaluates aggregates over the matching set", () => {
    const match = evaluateRulesForSymbol(
      "NVDA",
      signals,
      [
        rule({
          constraints: [
            { field: "strength", op: ">=", value: 0.4 },
            { field: "window.distinctSources", op: ">=", value: 2 },
            { field: "window.signalCount", op: "==", value: 2 },
            { field: "window.maxStrength", op: ">=", value: 0.6 },
          ],
        }),
      ],
      now,
    );
    expect(match).not.toBeNull();
    expect(match!.contributing).toHaveLength(2);
  });

  it("window.types uses the has op", () => {
    const has = rule({ constraints: [{ field: "window.types", op: "has", value: "alert" }] });
    expect(evaluateRulesForSymbol("NVDA", signals, [has], now)).not.toBeNull();
    const missing = rule({ constraints: [{ field: "window.types", op: "has", value: "buzz" }] });
    expect(evaluateRulesForSymbol("NVDA", signals, [missing], now)).toBeNull();
  });

  it("per-signal constraints shrink the set the window sees", () => {
    const match = evaluateRulesForSymbol(
      "NVDA",
      signals,
      [
        rule({
          constraints: [
            { field: "strength", op: ">=", value: 0.6 }, // only one signal passes
            { field: "window.distinctSources", op: ">=", value: 2 },
          ],
        }),
      ],
      now,
    );
    expect(match).toBeNull();
  });

  it("unknown window fields and has on per-signal fields fail closed", () => {
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "window.bogus", op: ">=", value: 1 }] })],
        now,
      ),
    ).toBeNull();
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [rule({ constraints: [{ field: "type", op: "has", value: "consensus" }] })],
        now,
      ),
    ).toBeNull();
  });
});

describe("card filters and combination", () => {
  it("source filter restricts the matching set", () => {
    const signals = [makeSignal({ source: "a", strength: 0.9 })];
    expect(
      evaluateRulesForSymbol("NVDA", signals, [rule({ source: "b" })], now),
    ).toBeNull();
    expect(
      evaluateRulesForSymbol("NVDA", signals, [rule({ source: "a" })], now),
    ).not.toBeNull();
  });

  it("symbols filter scopes a card to its ticker universe", () => {
    const signals = [makeSignal({ symbol: "PLTR", strength: 0.9 })];
    expect(
      evaluateRulesForSymbol("PLTR", signals, [rule({ symbols: ["NVDA"] })], now),
    ).toBeNull();
    expect(
      evaluateRulesForSymbol("PLTR", signals, [rule({ symbols: ["NVDA", "PLTR"] })], now),
    ).not.toBeNull();
  });

  it("cards OR together — the first matching card wins and is reported", () => {
    const signals = [makeSignal({ strength: 0.9 })];
    const match = evaluateRulesForSymbol(
      "NVDA",
      signals,
      [
        rule({ label: "impossible", constraints: [{ field: "strength", op: ">=", value: 2 }] }),
        rule({ label: "matches", constraints: [{ field: "strength", op: ">=", value: 0.5 }] }),
      ],
      now,
    );
    expect(match?.rule.label).toBe("matches");
  });

  it("constraints within a card AND together", () => {
    const signals = [makeSignal({ strength: 0.9, fields: { opp: 40 } })];
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        signals,
        [
          rule({
            constraints: [
              { field: "strength", op: ">=", value: 0.5 },
              { field: "opp", op: ">=", value: 70 },
            ],
          }),
        ],
        now,
      ),
    ).toBeNull();
  });
});

describe("DEFAULT_ENTRY_RULES (the unconfigured posture)", () => {
  it("two distinct sources at moderate strength → consensus card matches", () => {
    const match = evaluateRulesForSymbol(
      "NVDA",
      [makeSignal({ source: "a", strength: 0.5 }), makeSignal({ source: "b", strength: 0.5 })],
      DEFAULT_ENTRY_RULES,
      now,
    );
    expect(match?.rule.label).toBe("consensus");
  });

  it("one strong signal → strong-signal card matches", () => {
    const match = evaluateRulesForSymbol(
      "NVDA",
      [makeSignal({ strength: 0.8 })],
      DEFAULT_ENTRY_RULES,
      now,
    );
    expect(match?.rule.label).toBe("strong signal");
  });

  it("one weak signal → nothing matches", () => {
    expect(
      evaluateRulesForSymbol("NVDA", [makeSignal({ strength: 0.5 })], DEFAULT_ENTRY_RULES, now),
    ).toBeNull();
  });

  it("signals below the strength floor never count, even in aggregate", () => {
    expect(
      evaluateRulesForSymbol(
        "NVDA",
        [makeSignal({ source: "a", strength: 0.3 }), makeSignal({ source: "b", strength: 0.35 })],
        DEFAULT_ENTRY_RULES,
        now,
      ),
    ).toBeNull();
  });
});

describe("describeRule", () => {
  it("renders a readable summary", () => {
    const text = describeRule(
      rule({
        source: "shadowalpha-portfolio",
        symbols: ["NVDA"],
        constraints: [
          { field: "confidence", op: ">=", value: 0.6 },
          { field: "window.distinctSources", op: ">=", value: 2 },
        ],
      }),
    );
    expect(text).toContain("confidence >= 0.6");
    expect(text).toContain("distinctSources >= 2");
    expect(text).toContain("shadowalpha-portfolio");
    expect(text).toContain("NVDA");
  });
});
