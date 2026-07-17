/**
 * Standalone validator + shared-path tests: the CLI's check function must
 * agree with the boot loader in every case, and the diff util that feeds
 * audit events and the restart banner must be exact.
 */

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProfileFile } from "../src/tools/validate-profile.js";
import { loadSettings, SettingsError } from "../src/settings/load.js";
import { diffSettings, canonicalEqual } from "../src/settings/diff.js";
import { tempDir } from "./helpers.js";

function profileFile(contents: unknown): string {
  const path = join(tempDir(), "profile.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("checkProfileFile agrees with the boot loader", () => {
  const cases: Array<[string, unknown]> = [
    ["valid scenario 3", { scenario: 3 }],
    ["schema violation", { mode: "yolo" }],
    ["scenario 2 missing execution", { scenario: 2, mode: "paper" }],
    ["scenario 2 without stops", { scenario: 2, mode: "paper", execution: "auto", exit: { stopLossPct: null, trailingStopPct: null } }],
    ["malformed json", "{nope"],
  ];

  for (const [name, contents] of cases) {
    it(name, () => {
      const path = profileFile(contents);
      const check = checkProfileFile(path);
      let loaderAccepts = true;
      try {
        loadSettings(path);
      } catch (err) {
        expect(err).toBeInstanceOf(SettingsError);
        loaderAccepts = false;
      }
      expect(check.ok).toBe(loaderAccepts);
    });
  }

  it("additionally refuses profiles that would not boot (live mode)", () => {
    // The loader accepts live mode (the orchestrator refuses it at boot);
    // the CLI folds that boot check in so agents catch it early.
    const check = checkProfileFile(profileFile({ mode: "live" }));
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.issues[0]!.path).toBe("liveBroker"); // live w/o broker → points at liveBroker
  });

  it("reports a missing file", () => {
    expect(checkProfileFile("/nonexistent/profile.json")).toMatchObject({ ok: false });
  });
});

describe("diffSettings", () => {
  it("reports flat dot-paths for nested changes", () => {
    const changes = diffSettings(
      { caps: { maxDailyLoss: 100, maxOpenPositions: 5 }, mode: "paper" },
      { caps: { maxDailyLoss: 250, maxOpenPositions: 5 }, mode: "paper" },
    );
    expect(changes).toEqual([{ path: "caps.maxDailyLoss", from: 100, to: 250 }]);
  });

  it("treats arrays as leaf values and reports additions/removals", () => {
    const changes = diffSettings(
      { entry: { symbolBlocklist: [] } },
      { entry: { symbolBlocklist: ["TSLA"], rules: null } },
    );
    expect(changes).toContainEqual({ path: "entry.symbolBlocklist", from: [], to: ["TSLA"] });
    expect(changes).toContainEqual({ path: "entry.rules", from: undefined, to: null });
  });

  it("canonicalEqual ignores key order", () => {
    expect(canonicalEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(canonicalEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});
