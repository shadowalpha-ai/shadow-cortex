/**
 * Orchestrator: wires every component from the validated settings and runs
 * the two cheap deterministic loops. AI work is invoked only on state changes
 * inside those loops — never a hot continuous LLM poll.
 */

import type { Broker, QuoteProvider } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { StateStore, bookId } from "../core/state.js";
import { AuditLog } from "../core/audit.js";
import {
  BrokerQuoteProvider,
  FixtureQuoteProvider,
  ShadowAlphaQuoteProvider,
} from "../execution/quotes.js";
import { PaperBroker } from "../execution/paper-broker.js";
import { RobinhoodBroker } from "../execution/robinhood-broker.js";
import { FileOAuthProvider, hasRobinhoodTokens } from "../execution/robinhood-oauth.js";
import { FixtureTAProvider, TAEnricher } from "../enrichment/ta.js";
import { RobinhoodTAProvider } from "../enrichment/robinhood-ta.js";
import { CompositeEnricher, type SymbolEnricher } from "../enrichment/enricher.js";
import { ShadowAlphaEnricher } from "../enrichment/shadowalpha.js";
import { enrichmentNeeds } from "../enrichment/catalog.js";
import { FixtureAtrProvider, ShadowAlphaAtrProvider, type AtrProvider } from "../exits/atr.js";
import { FixtureMcpClient } from "../sources/mcp-client.js";
import { ExecutionGate } from "../execution/gate.js";
import { buildSources } from "../sources/registry.js";
import { buildDecider } from "../deciders/registry.js";
import { LiveMcpClient } from "../sources/mcp-client.js";
import { Narrator } from "../narrator/narrator.js";
import { CliConfirmChannel, type ConfirmChannel } from "./confirm.js";
import { WebConfirmChannel } from "../ui/confirm.js";
import { UiServer } from "../ui/server.js";
import { ProposalRouter } from "./router.js";
import { IntakeLoop } from "./intake-loop.js";
import { ManagementLoop } from "./management-loop.js";
import { SettingsError } from "../settings/load.js";
import {
  BROKER_QUOTES_REQUIRE_LIVE_BROKER,
  LIVE_MODE_NOT_CONNECTED,
  LIVE_MODE_REQUIRES_BROKER,
  TA_ROBINHOOD_NOT_CONNECTED,
} from "../settings/validate.js";
import { ProfileStore } from "../settings/profile-store.js";
import { resolveShadowAlphaToken } from "../settings/credentials.js";
import { RESTART_EXIT_CODE } from "../core/restart.js";
import { log } from "../core/log.js";

/**
 * The live Robinhood broker: an OAuth'd MCP client (tokens from
 * `npm run robinhood:connect`; the provider fails closed when interaction
 * would be required) wrapped in the verified-read adapter. Construction is
 * offline-safe — the client connects lazily on first call.
 */
function buildRobinhoodBroker(settings: Settings): RobinhoodBroker {
  if (!hasRobinhoodTokens(settings.paths.robinhoodOauth)) {
    throw new SettingsError(LIVE_MODE_NOT_CONNECTED);
  }
  const provider = new FileOAuthProvider(settings.paths.robinhoodOauth);
  const mcp = new LiveMcpClient(settings.robinhood.url, { authProvider: provider });
  return new RobinhoodBroker(mcp, {
    accountNumber: settings.robinhood.accountNumber ?? undefined,
    refuseOnReviewWarning: settings.robinhood.refuseOnReviewWarning,
  });
}

function buildBroker(settings: Settings, store: StateStore, quotes: QuoteProvider): Broker {
  if (settings.mode === "live") {
    if (settings.liveBroker !== "robinhood") throw new SettingsError(LIVE_MODE_REQUIRES_BROKER);
    return buildRobinhoodBroker(settings);
  }
  return new PaperBroker(store, quotes, settings.paper);
}

/**
 * Enrichment follows the strategy: whatever ta.* / conviction.* /
 * predictions.* fields the entry rules reference get computed automatically
 * (plus any manual indicator extras). null when the rules need nothing.
 */
function buildEnricher(settings: Settings): SymbolEnricher | null {
  const needs = enrichmentNeeds(settings);
  const enrichers: SymbolEnricher[] = [];

  const ta = settings.enrichment.ta;
  if (needs.taSpecs.length > 0) {
    if (ta.provider === "robinhood") {
      if (!hasRobinhoodTokens(settings.paths.robinhoodOauth)) {
        throw new SettingsError(TA_ROBINHOOD_NOT_CONNECTED);
      }
      const provider = new FileOAuthProvider(settings.paths.robinhoodOauth);
      const mcp = new LiveMcpClient(settings.robinhood.url, { authProvider: provider });
      enrichers.push(new TAEnricher(new RobinhoodTAProvider(mcp), needs.taSpecs, ta.cacheMinutes));
    } else {
      enrichers.push(
        new TAEnricher(new FixtureTAProvider(settings.paths.taFixture), needs.taSpecs, ta.cacheMinutes),
      );
    }
  }

  const sa = settings.enrichment.shadowalpha;
  if (needs.conviction || needs.symbolPredictions) {
    const mcp =
      sa.transport === "live"
        ? new LiveMcpClient(sa.url, resolveShadowAlphaToken(settings.paths.shadowalphaToken))
        : new FixtureMcpClient(settings.paths.enrichmentFixture);
    enrichers.push(
      new ShadowAlphaEnricher(mcp, {
        conviction: needs.conviction,
        symbolPredictions: needs.symbolPredictions,
        daysBack: sa.daysBack,
        cacheMinutes: sa.cacheMinutes,
      }),
    );
  }

  if (enrichers.length === 0) return null;
  return enrichers.length === 1 ? enrichers[0]! : new CompositeEnricher(enrichers);
}

/** null unless the ATR stop is configured. Candle source mirrors quoteSource. */
function buildAtrProvider(settings: Settings): AtrProvider | null {
  if (settings.exit.atrStopMultiplier === null) return null;
  if (settings.quoteSource === "fixture") {
    return new FixtureAtrProvider(settings.paths.quotesFixture);
  }
  const source = settings.sources.find((s) => "url" in s);
  const url = source && "url" in source ? source.url : "https://shadowalpha.ai/mcp";
  return new ShadowAlphaAtrProvider(
    new LiveMcpClient(url, resolveShadowAlphaToken(settings.paths.shadowalphaToken)),
  );
}

function buildQuoteProvider(settings: Settings): QuoteProvider {
  switch (settings.quoteSource) {
    case "fixture":
      return new FixtureQuoteProvider(settings.paths.quotesFixture);
    case "shadowalpha": {
      const source = settings.sources.find((s) => s.type === "shadowalpha");
      const url = source?.type === "shadowalpha" ? source.url : "https://shadowalpha.ai/mcp";
      return new ShadowAlphaQuoteProvider(
        new LiveMcpClient(url, resolveShadowAlphaToken(settings.paths.shadowalphaToken)),
      );
    }
    case "broker":
      // Callers must build the live broker first (see the constructor) —
      // reaching here means the settings weren't runnable.
      throw new SettingsError(BROKER_QUOTES_REQUIRE_LIVE_BROKER);
  }
}

export class Orchestrator {
  private readonly intake: IntakeLoop;
  private readonly management: ManagementLoop;
  private readonly store: StateStore;
  private readonly audit: AuditLog;
  private readonly ui: UiServer | null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly settings: Settings,
    profilePath: string | null = null,
  ) {
    this.audit = new AuditLog(settings.paths.auditLog);
    this.store = new StateStore(settings.paths.stateFile);

    // Day-scoped bookkeeping (daily-loss anchor, open proposals) must not
    // cross a paper ⇄ live switch — a stale paper anchor against a real
    // account misreports P&L and falsely trips the daily-loss halt.
    const book = bookId(settings);
    const expiredOnSwitch = this.store.switchBook(book);
    if (expiredOnSwitch >= 0) {
      this.audit.write("book_changed", { book, expiredOpenProposals: expiredOnSwitch });
      log.info(
        `Account book is now "${book}" — daily P&L re-anchors on the next tick` +
          (expiredOnSwitch > 0 ? `; ${expiredOnSwitch} open proposal(s) from the previous book expired.` : "."),
      );
    }

    // Construction order branches on the quote source: broker quotes need the
    // live broker first; every other quote source feeds the (paper) broker.
    let quotes: QuoteProvider;
    let broker: Broker;
    if (settings.quoteSource === "broker") {
      if (settings.mode !== "live" || settings.liveBroker !== "robinhood") {
        throw new SettingsError(BROKER_QUOTES_REQUIRE_LIVE_BROKER);
      }
      broker = buildRobinhoodBroker(settings);
      quotes = new BrokerQuoteProvider(broker as RobinhoodBroker);
    } else {
      quotes = buildQuoteProvider(settings);
      broker = buildBroker(settings, this.store, quotes);
    }
    const gate = new ExecutionGate(settings, broker, quotes, this.audit);
    const narrator = new Narrator(settings.claude.model);
    const sources = buildSources(settings);

    // With the dashboard on, confirmations happen in the browser; otherwise
    // they stay on the CLI. Same ConfirmChannel contract either way.
    let confirm: ConfirmChannel = new CliConfirmChannel();
    this.ui = null;
    if (settings.ui.enabled) {
      const webConfirm = new WebConfirmChannel();
      confirm = webConfirm;
      this.ui = new UiServer({
        settings,
        store: this.store,
        broker,
        gate,
        sources,
        profile: new ProfileStore(profilePath),
        audit: this.audit,
        auditPath: settings.paths.auditLog,
        confirm: webConfirm,
        requestRestart: () => this.restart(),
      });
    }

    const router = new ProposalRouter(
      settings,
      this.store,
      gate,
      narrator,
      this.audit,
      confirm,
    );

    this.intake = new IntakeLoop(
      settings,
      sources,
      buildDecider(settings),
      broker,
      quotes,
      this.store,
      router,
      this.audit,
      buildEnricher(settings),
    );
    this.management = new ManagementLoop(
      settings,
      broker,
      quotes,
      this.store,
      gate,
      router,
      this.audit,
      buildAtrProvider(settings),
    );
  }

  /** Dashboard-initiated restart: save, audit, exit for the supervisor. */
  private restart(): void {
    log.info("Restart requested from the dashboard — the supervisor will respawn the engine.");
    for (const t of this.timers) clearInterval(t);
    this.ui?.stop();
    this.store.save();
    this.audit.write("engine_stopped", { reason: "dashboard_restart" });
    process.exit(RESTART_EXIT_CODE);
  }

  start(): void {
    const s = this.settings;
    log.info("Shadow Cortex starting");
    log.info(
      `scenario ${s.scenario} | mode ${s.mode} | execution ${s.execution} | decider ${s.decider} | quotes ${s.quoteSource}`,
    );
    log.info(
      "Reference implementation — not investment advice. You own every cap and every risk.",
    );
    this.audit.write("engine_started", {
      scenario: s.scenario,
      mode: s.mode,
      execution: s.execution,
      decider: s.decider,
    });
    void this.ui?.start();

    // Reentrancy guard per loop: a slow tick skips the next firing, it never overlaps.
    const guarded = (name: string, fn: () => Promise<void>): (() => void) => {
      let busy = false;
      return () => {
        if (busy) return;
        busy = true;
        fn()
          .catch((err) => {
            log.error(`${name} tick failed — loop continues`, err);
            this.audit.write("error", { where: name, message: String(err) });
          })
          .finally(() => {
            busy = false;
          });
      };
    };

    const intakeTick = guarded("intake", () => this.intake.tick());
    const managementTick = guarded("management", () => this.management.tick());
    this.timers = [
      setInterval(intakeTick, s.cadence.intakePollMs),
      setInterval(managementTick, s.cadence.managementPollMs),
    ];
    // Fire both immediately so `npm run dev` shows life without waiting a full period.
    managementTick();
    setTimeout(intakeTick, 250);

    const shutdown = (): void => {
      log.info("Shutting down — saving state.");
      for (const t of this.timers) clearInterval(t);
      this.ui?.stop();
      this.store.save();
      this.audit.write("engine_stopped", {});
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
