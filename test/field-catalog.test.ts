/**
 * Field-catalog honesty: every field an adapter publishes on its fixture
 * signals must be declared in its static catalog — the rule builder's
 * dropdowns must never lie.
 */

import { describe, expect, it } from "vitest";
import { ShadowAlphaSource } from "../src/sources/shadowalpha.js";
import { ShadowAlphaPortfolioSource } from "../src/sources/shadowalpha-portfolio.js";
import { FixtureMcpClient } from "../src/sources/mcp-client.js";
import { collectFieldCatalog } from "../src/sources/registry.js";
import type { SignalSource } from "../src/core/types.js";

async function assertHonest(source: SignalSource): Promise<void> {
  const declared = new Set(source.fieldCatalog.map((f) => f.name));
  const signals = await source.poll();
  expect(signals.length).toBeGreaterThan(0);
  for (const signal of signals) {
    for (const published of Object.keys(signal.fields)) {
      expect(declared, `${source.name} publishes undeclared field "${published}"`).toContain(
        published,
      );
    }
  }
}

describe("field-catalog honesty", () => {
  it("shadowalpha publishes only declared fields", async () => {
    await assertHonest(
      new ShadowAlphaSource(new FixtureMcpClient("fixtures/shadowalpha-ideas.json"), 0.3, 30),
    );
  });

  it("shadowalpha-portfolio publishes only declared fields", async () => {
    await assertHonest(
      new ShadowAlphaPortfolioSource(new FixtureMcpClient("fixtures/portfolio-signals.json"), {
        portfolios: ["Momentum"],
        listRefreshMinutes: 15,
      }),
    );
  });

  it("collectFieldCatalog aggregates universal, window, and per-source fields", () => {
    const shadowalpha = new ShadowAlphaSource(
      new FixtureMcpClient("fixtures/shadowalpha-ideas.json"),
      0.3,
      30,
    );
    const catalog = collectFieldCatalog([shadowalpha]);
    expect(catalog.universal.map((f) => f.name)).toContain("strength");
    expect(catalog.window.map((f) => f.name)).toContain("window.distinctSources");
    expect(catalog.bySource.shadowalpha!.map((f) => f.name)).toContain("analystRating");
  });
});
