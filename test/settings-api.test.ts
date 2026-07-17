/**
 * Settings API tests: the read/validate/save round-trip, every fail-closed
 * refusal, the auto-execution consent guard, revision conflicts, external-edit
 * detection (the agent path), and the restart round-trip guarantee — a saved
 * profile always loads and boots.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { UiServer } from "../src/ui/server.js";
import { WebConfirmChannel } from "../src/ui/confirm.js";
import { ExecutionGate } from "../src/execution/gate.js";
import { PaperBroker } from "../src/execution/paper-broker.js";
import { ProfileStore } from "../src/settings/profile-store.js";
import { AuditLog } from "../src/core/audit.js";
import { loadSettings } from "../src/settings/load.js";
import { ShadowAlphaSource } from "../src/sources/shadowalpha.js";
import { FixtureMcpClient } from "../src/sources/mcp-client.js";
import { MockQuoteProvider, makeSettings, newStore, tempDir } from "./helpers.js";

let server: UiServer | null = null;

// Absolute so the chdir in the restart-hint test can't break fixture loading.
const IDEAS_FIXTURE = new URL("../fixtures/shadowalpha-ideas.json", import.meta.url).pathname;

afterEach(() => {
  server?.stop();
  server = null;
});

/** A full raw profile document, as the panel would round-trip it. */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scenario: 3, mode: "paper", execution: "off", marketHoursOnly: false, ...overrides };
}

async function setup(options: { profilePath?: string | null; seedDocument?: unknown } = {}) {
  const dir = tempDir();
  const profilePath =
    options.profilePath === null ? null : (options.profilePath ?? join(dir, "profile.json"));
  if (profilePath && options.seedDocument !== undefined) {
    writeFileSync(profilePath, JSON.stringify(options.seedDocument, null, 2));
  }
  const settings = makeSettings({ ui: { enabled: true, port: 0 } });
  const store = newStore(dir);
  const quotes = new MockQuoteProvider({ NVDA: 100 });
  const broker = new PaperBroker(store, quotes, settings.paper);
  const auditPath = join(dir, "audit.jsonl");
  const profile = new ProfileStore(profilePath);
  server = new UiServer({
    settings,
    store,
    broker,
    gate: new ExecutionGate(settings, broker, quotes, new AuditLog(auditPath)),
    sources: [new ShadowAlphaSource(new FixtureMcpClient(IDEAS_FIXTURE), 0.3, 30)],
    profile,
    audit: new AuditLog(auditPath),
    auditPath,
    confirm: new WebConfirmChannel(),
  });
  const port = await server.start();
  return { base: `http://127.0.0.1:${port}`, profile, auditPath, settings, dir };
}

function auditEvents(auditPath: string): string[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).event as string);
}

describe("GET /api/settings", () => {
  it("returns running settings, saved state, field catalog, and constraints", async () => {
    const { base } = await setup();
    const body = (await (await fetch(`${base}/api/settings`)).json()) as any;
    expect(body.active.mode).toBe("paper");
    expect(body.saved.exists).toBe(false);
    expect(body.pendingRestart).toBe(false);
    expect(body.fieldCatalog.universal.map((f: any) => f.name)).toContain("strength");
    expect(body.fieldCatalog.bySource.shadowalpha.map((f: any) => f.name)).toContain("analystRating");
    expect(body.constraints.liveModeDisabledReason).toContain("live");
  });
});

describe("POST /api/settings/validate", () => {
  it("accepts a valid document and returns the effective settings + diff", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/settings/validate`, {
      method: "POST",
      body: JSON.stringify({ settings: document({ caps: { maxDailyLoss: 250 } }) }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.effective.caps.maxDailyLoss).toBe(250);
    expect(body.diff.some((c: any) => c.path === "caps.maxDailyLoss")).toBe(true);
  });

  it("rejects schema violations with structured issues", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/settings/validate`, {
      method: "POST",
      body: JSON.stringify({ settings: document({ mode: "yolo" }) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("invalid_settings");
    expect(body.error.issues[0].path).toBe("mode");
  });

  it("enforces preset precedence through the API (scenario 2 without explicit execution)", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/settings/validate`, {
      method: "POST",
      body: JSON.stringify({ settings: { scenario: 2, mode: "paper" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.issues.some((i: any) => i.message.includes("explicitly"))).toBe(true);
  });

  it("rejects documents that would refuse to boot: live mode and broker quotes", async () => {
    const { base } = await setup();
    // Live mode without a broker/connection points at liveBroker; broker
    // quotes without the live broker point at quoteSource.
    for (const [field, value, issuePath] of [
      ["mode", "live", "liveBroker"],
      ["quoteSource", "broker", "quoteSource"],
    ] as const) {
      const res = await fetch(`${base}/api/settings/validate`, {
        method: "POST",
        body: JSON.stringify({ settings: document({ [field]: value }) }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.issues[0].path).toBe(issuePath);
    }
  });

  it("rejects invalid entry rules fail-closed", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/settings/validate`, {
      method: "POST",
      body: JSON.stringify({
        settings: document({
          entry: { rules: [{ label: "bad", constraints: [{ field: "x", op: "~=", value: 1 }] }] },
        }),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/settings", () => {
  it("writes the profile atomically, audits the diff, and flags pendingRestart", async () => {
    const { base, profile, auditPath } = await setup();
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ settings: document({ caps: { maxDailyLoss: 250 } }) }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pendingRestart).toBe(true);
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = JSON.parse(readFileSync(profile.path, "utf8"));
    expect(onDisk.caps.maxDailyLoss).toBe(250);
    expect(auditEvents(auditPath)).toContain("settings_changed");

    // The banner shows up in the snapshot too.
    const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as any;
    expect(snap.status.pendingRestart).toBe(true);
  });

  it("attributes each save to the client that made it (postmortem trail)", async () => {
    const { base, auditPath } = await setup();
    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "x-shadow-cortex-client": "mcp" },
      body: JSON.stringify({ settings: document({ caps: { maxDailyLoss: 250 } }) }),
    });
    const change = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; data: { client?: string } })
      .find((e) => e.event === "settings_changed");
    expect(change?.data.client).toBe("mcp");
  });

  it("restart round-trip: the saved file loads and equals the API's effective settings", async () => {
    const { base, profile } = await setup();
    const doc = document({ caps: { maxSharesPerOrder: 3 }, exit: { trailingStopPct: 9 } });
    await fetch(`${base}/api/settings`, { method: "PUT", body: JSON.stringify({ settings: doc }) });
    const validated = (await (
      await fetch(`${base}/api/settings/validate`, {
        method: "POST",
        body: JSON.stringify({ settings: doc }),
      })
    ).json()) as any;
    expect(loadSettings(profile.path)).toEqual(validated.effective);
  });

  it("invalid documents write nothing and audit the rejection", async () => {
    const { base, profile, auditPath } = await setup();
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ settings: document({ caps: { maxDailyLoss: -5 } }) }),
    });
    expect(res.status).toBe(400);
    expect(profile.exists()).toBe(false);
    expect(auditEvents(auditPath)).toContain("settings_change_rejected");
  });

  it("requires structural consent to switch execution to auto", async () => {
    const { base } = await setup();
    const doc = document({ execution: "auto" });
    const denied = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ settings: doc }),
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as any).error.code).toBe("confirm_auto_required");

    const allowed = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ settings: doc, confirmAuto: true }),
    });
    expect(allowed.status).toBe(200);
  });

  it("detects revision conflicts from concurrent edits", async () => {
    const { base, profile } = await setup();
    await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ settings: document() }),
    });
    const staleRevision = profile.revision();
    // Someone (an agent, an editor) changes the file behind our back.
    writeFileSync(profile.path, JSON.stringify(document({ signalTtlMinutes: 99 })));

    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ settings: document(), ifRevision: staleRevision }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("revision_conflict");
  });

  it("offers a restart hint when the engine was booted without a profile", async () => {
    const dir = tempDir();
    const originalCwd = process.cwd();
    process.chdir(dir); // so the default profiles/custom.json lands in a temp dir
    try {
      const { base } = await setup({ profilePath: null });
      const res = await fetch(`${base}/api/settings`, {
        method: "PUT",
        body: JSON.stringify({ settings: document() }),
      });
      const body = (await res.json()) as any;
      expect(body.savedTo).toBe("profiles/custom.json");
      expect(body.restartHint).toContain("--profile profiles/custom.json");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("guards the request body: oversized → 413, malformed → 400", async () => {
    const { base } = await setup();
    const big = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: `{"settings": {"x": "${"y".repeat(300 * 1024)}"}}`,
    });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/api/settings`, { method: "PUT", body: "{not json" });
    expect(bad.status).toBe(400);
  });
});

describe("external edits (the agent path)", () => {
  it("a direct file edit surfaces as pendingRestart with a diff", async () => {
    const { base, profile } = await setup({ seedDocument: document() });
    writeFileSync(profile.path, JSON.stringify(document({ caps: { maxDailyLoss: 42 } })));

    const body = (await (await fetch(`${base}/api/settings`)).json()) as any;
    expect(body.pendingRestart).toBe(true);
    expect(body.diff.some((c: any) => c.path === "caps.maxDailyLoss" && c.to === 42)).toBe(true);
  });

  it("a broken on-disk profile is reported without touching the running engine", async () => {
    const { base, profile } = await setup({ seedDocument: document() });
    writeFileSync(profile.path, "{broken json");

    const body = (await (await fetch(`${base}/api/settings`)).json()) as any;
    expect(body.savedProfileInvalid).toContain("not valid JSON");
    const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as any;
    expect(snap.status.savedProfileInvalid).toContain("not valid JSON");
    expect(snap.status.mode).toBe("paper"); // engine unaffected
  });
});
