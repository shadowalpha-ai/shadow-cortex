/**
 * Source registry — the self-registration point. Adding a source adapter:
 * write a module implementing SignalSource, add one factory entry here. The
 * core engine never changes.
 */

import type { FieldDef, SignalSource } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { FixtureMcpClient, LiveMcpClient, type McpToolClient } from "./mcp-client.js";
import { ShadowAlphaSource } from "./shadowalpha.js";
import { ShadowAlphaPortfolioSource } from "./shadowalpha-portfolio.js";
import { ShadowAlphaPredictionsSource } from "./shadowalpha-predictions.js";
import { resolveShadowAlphaToken } from "../settings/credentials.js";
import { UNIVERSAL_FIELDS, WINDOW_FIELDS } from "../entry/rules.js";

function buildMcpClient(
  transport: "fixture" | "live",
  url: string,
  fixturePath: string,
  token: string | undefined,
): McpToolClient {
  return transport === "live"
    ? new LiveMcpClient(url, token)
    : new FixtureMcpClient(fixturePath);
}

export function buildSources(settings: Settings): SignalSource[] {
  // Env var wins; else the token saved by the dashboard's Connections panel.
  const token = resolveShadowAlphaToken(settings.paths.shadowalphaToken);
  return settings.sources.map((config): SignalSource => {
    switch (config.type) {
      case "shadowalpha":
        return new ShadowAlphaSource(
          buildMcpClient(config.transport, config.url, settings.paths.signalsFixture, token),
          config.minStrength,
          settings.dedupeWindowMinutes,
        );
      case "shadowalpha-predictions":
        return new ShadowAlphaPredictionsSource(
          buildMcpClient(config.transport, config.url, settings.paths.predictionsFixture, token),
          {
            lookbackDays: config.lookbackDays,
            joinAnalystStats: config.joinAnalystStats,
            statsRefreshMinutes: config.statsRefreshMinutes,
          },
        );
      case "shadowalpha-portfolio":
        return new ShadowAlphaPortfolioSource(
          buildMcpClient(config.transport, config.url, settings.paths.portfolioFixture, token),
          {
            portfolios: config.portfolios,
            listRefreshMinutes: config.listRefreshMinutes,
          },
        );
    }
  });
}

/**
 * The complete field dictionary for the rule builder: universal signal
 * fields, window aggregates, per-symbol enrichment fields (ta.*), and each
 * configured source's declared catalog.
 */
export function collectFieldCatalog(
  sources: SignalSource[],
  enrichment: FieldDef[] = [],
): {
  universal: FieldDef[];
  window: FieldDef[];
  enrichment: FieldDef[];
  bySource: Record<string, FieldDef[]>;
} {
  const bySource: Record<string, FieldDef[]> = {};
  for (const source of sources) {
    bySource[source.name] = source.fieldCatalog;
  }
  return { universal: UNIVERSAL_FIELDS, window: WINDOW_FIELDS, enrichment, bySource };
}
