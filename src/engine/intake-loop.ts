/**
 * Intake loop: poll sources → normalize → dedupe → run the
 * decider over the fresh window → route entry proposals.
 *
 * Errors are handled PER ITEM — one bad source or one failed quote must not
 * kill the tick, and one bad tick must not kill the loop.
 */

import type {
  Decider,
  Broker,
  Quote,
  QuoteProvider,
  Signal,
  SignalSource,
} from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { StateStore } from "../core/state.js";
import type { AuditLog } from "../core/audit.js";
import type { ProposalRouter } from "./router.js";
import type { SymbolEnricher } from "../enrichment/enricher.js";
import { isMarketOpen } from "./market-hours.js";
import { log } from "../core/log.js";

export class IntakeLoop {
  /** The fresh-signal window (in-memory; dedupe keys persist across restarts). */
  private window: Signal[] = [];
  private closedLogged = false;
  /** `symbol|reason` pairs already audited as entry_skipped for the current window. */
  private readonly reportedSkips = new Set<string>();

  constructor(
    private readonly settings: Settings,
    private readonly sources: SignalSource[],
    private readonly decider: Decider,
    private readonly broker: Broker,
    private readonly quotes: QuoteProvider,
    private readonly store: StateStore,
    private readonly router: ProposalRouter,
    private readonly audit: AuditLog,
    private readonly enricher: SymbolEnricher | null = null,
  ) {}

  async tick(now: Date = new Date()): Promise<void> {
    if (this.settings.marketHoursOnly && !isMarketOpen(now)) {
      if (!this.closedLogged) {
        log.info("Market closed — intake paused (marketHoursOnly). Management loop keeps running.");
        this.closedLogged = true;
      }
      return;
    }
    this.closedLogged = false;

    // 1. Poll every source; a failing source is logged and skipped.
    let freshCount = 0;
    for (const source of this.sources) {
      try {
        const signals = await source.poll();
        const fresh = signals.filter((s) => !this.store.isSeen(s.dedupeKey));
        for (const signal of fresh) {
          this.store.markSeen(signal.dedupeKey, now);
          this.audit.write("signal_ingested", {
            source: signal.source,
            symbol: signal.symbol,
            type: signal.type,
            direction: signal.direction,
            strength: signal.strength,
            dedupeKey: signal.dedupeKey,
          });
        }
        if (fresh.length > 0) {
          log.info(`${source.name}: ${fresh.length} fresh signal(s) (${signals.length} polled)`);
        }
        freshCount += fresh.length;
        this.window.push(...fresh);
      } catch (err) {
        log.error(`Source ${source.name} failed this tick — continuing`, err);
        this.audit.write("error", { where: `source:${source.name}`, message: String(err) });
      }
    }

    // 2. Prune the window to fresh signals only.
    const ttlCutoff = now.getTime() - this.settings.signalTtlMinutes * 60_000;
    this.window = this.window.filter((s) => Date.parse(s.timestamp) >= ttlCutoff);
    this.store.pruneSeen(this.settings.dedupeWindowMinutes, now);

    for (const expired of this.store.expireStaleProposals(now)) {
      this.audit.write("proposal_expired", { proposalId: expired.proposal.id });
    }

    // Decide only when the window CHANGED. Re-running the decider over the
    // same stale window would re-propose (and re-drop) the same trades every
    // tick — and with an AI decider, every tick would be a paid model call.
    // AI work runs on state changes, never as a hot continuous poll.
    const retryWanted = this.decider.wantsRetry?.(now) ?? false;
    if (this.window.length === 0 || (freshCount === 0 && !retryWanted)) {
      this.store.save();
      return;
    }

    // 3. Price the candidates; a symbol without a quote is skipped, not fatal.
    const windowSymbols = [...new Set(this.window.map((s) => s.symbol))];
    const quotes: Record<string, Quote> = {};
    for (const symbol of windowSymbols) {
      try {
        quotes[symbol] = await this.quotes.getQuote(symbol);
      } catch (err) {
        log.error(`No quote for ${symbol} — skipping this tick`, err);
      }
    }

    // 4. Enrich the symbols under decision (ta.* fields; cached; a failed
    //    symbol just fails its ta.* constraints closed). Runs only when the
    //    window changed — same economy rule as the decider itself.
    const enrichment = this.enricher
      ? await this.enricher.enrich(
          windowSymbols,
          now,
          Object.fromEntries(Object.entries(quotes).map(([sym, q]) => [sym, q.price])),
        )
      : undefined;

    // 5. Decide. Positions come from the broker (broker is the source of truth).
    const positions = this.store.reconcile(await this.broker.getPositions());
    const { equity } = await this.broker.getAccount();
    const held = new Set(positions.map((p) => p.symbol));

    // Audit why considered symbols DIDN'T propose (once per symbol+reason
    // while it stays in the window) — silent no-matches hide misconfigured
    // strategies. The dedupe resets when the symbol ages out of the window.
    const symbolSet = new Set(windowSymbols);
    for (const key of this.reportedSkips) {
      if (!symbolSet.has(key.slice(0, key.indexOf("|")))) this.reportedSkips.delete(key);
    }
    const proposals = await this.decider.decide({
      signals: this.window,
      positions,
      quotes,
      equity,
      enrichment,
      settings: this.settings,
      now,
      onSkip: ({ symbol, reason }) => {
        const key = `${symbol}|${reason}`;
        if (this.reportedSkips.has(key)) return;
        this.reportedSkips.add(key);
        this.audit.write("entry_skipped", { symbol, reason });
        log.info(`entry skipped: ${symbol} — ${reason}`);
      },
    });

    // 6. Route. Defense in depth: no entry proposals for symbols already held.
    for (const proposal of proposals) {
      if (proposal.action === "buy" && held.has(proposal.symbol)) {
        this.audit.write("proposal_dropped", {
          proposalId: proposal.id,
          reason: `already holding ${proposal.symbol} (no scale-in in v1)`,
        });
        continue;
      }
      await this.router.route(proposal, now);
    }

    this.store.save();
  }
}
