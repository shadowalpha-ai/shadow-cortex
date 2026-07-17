/**
 * Settings fail-closed tests: SAFE_DEFAULTS posture, refusal on invalid
 * profiles, and the preset-precedence rule (a scenario preset must never
 * silently enable automation).
 */

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAFE_DEFAULTS, SettingsError, loadSettings } from "../src/settings/load.js";
import { SettingsSchema } from "../src/settings/schema.js";
import { tempDir } from "./helpers.js";

function profileFile(contents: unknown): string {
  const path = join(tempDir(), "profile.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("SAFE_DEFAULTS", () => {
  it("ships paper mode, execution off, rules decider, conservative caps populated", () => {
    const s = SAFE_DEFAULTS();
    expect(s.mode).toBe("paper");
    expect(s.execution).toBe("off");
    expect(s.decider).toBe("rules");
    expect(s.scenario).toBe(3);
    expect(s.caps.maxSharesPerOrder).not.toBeNull();
    expect(s.caps.maxDollarsPerPosition).not.toBeNull();
    expect(s.caps.maxDailyLoss).not.toBeNull();
    expect(s.marketHoursOnly).toBe(true);
  });

  it("no profile path falls back to SAFE_DEFAULTS", () => {
    expect(loadSettings(undefined)).toEqual(SAFE_DEFAULTS());
  });
});

describe("fail-closed validation", () => {
  it("refuses to run on a missing profile path", () => {
    expect(() => loadSettings("/nonexistent/profile.json")).toThrow(SettingsError);
  });

  it("refuses to run on malformed JSON", () => {
    expect(() => loadSettings(profileFile("{not json"))).toThrow(SettingsError);
  });

  it("refuses to run on schema violations instead of guessing", () => {
    expect(() => loadSettings(profileFile({ mode: "yolo" }))).toThrow(SettingsError);
    expect(() => loadSettings(profileFile({ caps: { maxDailyLoss: -5 } }))).toThrow(
      SettingsError,
    );
  });
});

describe("preset precedence (scenario never enables automation silently)", () => {
  it("scenario 2 without explicit mode/execution refuses to run", () => {
    expect(() => loadSettings(profileFile({ scenario: 2 }))).toThrow(/explicitly/);
    expect(() => loadSettings(profileFile({ scenario: 2, mode: "paper" }))).toThrow(
      /explicitly/,
    );
  });

  it("scenario 2 without a programmatic stop refuses to run", () => {
    expect(() =>
      loadSettings(
        profileFile({
          scenario: 2,
          mode: "paper",
          execution: "auto",
          exit: { stopLossPct: null, trailingStopPct: null },
        }),
      ),
    ).toThrow(/programmatic stop/);
  });

  it("a fully explicit scenario 2 profile loads", () => {
    const settings = loadSettings(
      profileFile({ scenario: 2, mode: "paper", execution: "auto" }),
    );
    expect(settings.execution).toBe("auto");
  });

  it("scenario 3 may omit mode/execution and gets the safe defaults", () => {
    const settings = loadSettings(profileFile({ scenario: 3 }));
    expect(settings.mode).toBe("paper");
    expect(settings.execution).toBe("off");
  });
});

describe("shadowalpha-portfolio source schema", () => {
  it("parses with defaults and requires at least one portfolio", () => {
    const good = SettingsSchema.parse({
      sources: [{ type: "shadowalpha-portfolio", portfolios: ["Momentum"] }],
    });
    const src = good.sources[0]!;
    expect(src.type).toBe("shadowalpha-portfolio");
    if (src.type === "shadowalpha-portfolio") {
      expect(src.transport).toBe("fixture");
      expect(src.listRefreshMinutes).toBe(15);
    }
    expect(() =>
      SettingsSchema.parse({ sources: [{ type: "shadowalpha-portfolio", portfolios: [] }] }),
    ).toThrow();
  });
});

describe("ShadowAlpha rate budget (30 req/min)", () => {
  it("refuses a polling config that would be throttled all day", async () => {
    const { runnableIssues } = await import("../src/settings/validate.js");
    const { makeSettings } = await import("./helpers.js");
    // Mirrors a real incident: 5s intake polling across a live buzz source
    // + two followed portfolios ≈ 36 req/min → all-day throttling.
    const over = makeSettings({
      cadence: { intakePollMs: 5000, managementPollMs: 10000 },
      sources: [
        { type: "shadowalpha", transport: "live", minStrength: 0.3 },
        {
          type: "shadowalpha-portfolio",
          transport: "live",
          portfolios: ["Alpha Momentum", "Deep Value Picks"],
        },
      ],
    });
    const issues = runnableIssues(over);
    const rateIssue = issues.find((i) => i.path === "cadence.intakePollMs");
    expect(rateIssue).toBeDefined();
    expect(rateIssue!.message).toContain("30");

    // Same sources at 60s polling ≈ 3 req/min — fine.
    const ok = makeSettings({
      cadence: { intakePollMs: 60000, managementPollMs: 10000 },
      sources: over.sources,
    });
    expect(ok.mode).toBe("paper");
    expect(runnableIssues(ok).find((i) => i.path === "cadence.intakePollMs")).toBeUndefined();
  });

  it("ignores fixture transports — they never hit the API", async () => {
    const { runnableIssues } = await import("../src/settings/validate.js");
    const { makeSettings } = await import("./helpers.js");
    const fixture = makeSettings({
      cadence: { intakePollMs: 1000, managementPollMs: 10000 },
      sources: [{ type: "shadowalpha", transport: "fixture", minStrength: 0 }],
    });
    expect(runnableIssues(fixture).find((i) => i.path === "cadence.intakePollMs")).toBeUndefined();
  });
});

describe("AI decider heads-up warning", () => {
  it("warns when decider is claude but the engine has no ANTHROPIC_API_KEY", async () => {
    const { runnableWarnings, DECIDER_CLAUDE_NO_KEY } = await import("../src/settings/validate.js");
    const { makeSettings } = await import("./helpers.js");
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      const claude = makeSettings({ decider: "claude" });
      // Schema populates the cost brakes with conservative defaults.
      expect(claude.claude).toMatchObject({ maxCallsPerDay: 500, minSecondsBetweenCalls: 30 });
      expect(runnableWarnings(claude).map((w) => w.message)).toEqual([DECIDER_CLAUDE_NO_KEY]);
      expect(runnableWarnings(makeSettings())).toEqual([]); // rules decider: quiet

      process.env.ANTHROPIC_API_KEY = "sk-test";
      expect(runnableWarnings(claude)).toEqual([]); // key present: quiet
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
