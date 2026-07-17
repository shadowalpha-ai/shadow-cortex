# Datapoint reference — everything entry criteria can gate on

> GENERATED from the engine's own field catalogs by `npm run docs:fields` —
> do not edit by hand. `test/field-docs.test.ts` fails when this file drifts
> from the code. The LIVE catalog (including your configured portfolio names)
> is always `GET /api/settings` → `availableFieldCatalog`, or the
> `get_strategy` MCP tool for AI clients.

Entry criteria are sentence cards: **when a signal arrives from [feed] → and
all conditions hold → propose a buy**. Every condition is
`datapoint op value`. Missing data always **fails closed** — a condition on
a datapoint the signal doesn't carry simply never matches (the Event feed's
`entry_skipped` events tell you why nothing proposed).

Operators: `==` `!=` `>=` `>` `<=` `<` `has`. Numbers use the comparisons, strings
and booleans use `==`/`!=`, and `window.types` uses `has`.

## This signal (universal — carried by every signal from any feed)

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `type` | string | — | Signal type, e.g. consensus, buzz, prediction, alert |
| `strength` | number | — | Normalized signal magnitude, 0..1 |
| `confidence` | number | — | Source certainty 0..1 (absent on some signals — a constraint on it then fails) |
| `ageMinutes` | number | — | Minutes since the signal's timestamp |

## Feed: Ideas & buzz — ShadowAlpha (`shadowalpha`)

The buzz/stock-ideas scanner. Note: the source's own `minStrength` floor
(Data sources) drops weaker signals before rules ever see them.

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `opp` | number | — | Opportunity score, −100..100, signed by direction |
| `spikeRatio` | number | — | 3-day distinct-analyst count vs 30-day baseline (≥6 = buzzing) |
| `buzz` | number | — | ShadowAlpha buzz score |
| `bullishCount` | number | — | Bullish analyst calls behind the idea |
| `bearishCount` | number | — | Bearish analyst calls behind the idea |
| `avgConfidence` | number | — | Average confidence across the calls, 0..1 |
| `analystRating` | number | — | Avg ShadowScore (0–100) of the analysts behind the idea |
| `recent3dSources` | number | — | Distinct analysts in the last 3 days |
| `dayPct` | number | — | Today's price change % (can be a 0.0 placeholder off-hours) |
| `buyZone` | boolean | — | ShadowAlpha buy-zone flag |
| `isNewEntrant` | boolean | — | First time on the buzz scanner recently |
| `sector` | string | — | Sector label, e.g. Energy, AI/Software |

## Feed: Analyst predictions — ShadowAlpha (`shadowalpha-predictions`)

Individual analyst calls, joined with the analyst's track record.

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `analystHandle` | string | — | The analyst who made the call |
| `specificityTier` | number | — | How specific the call is (upstream tiering) |
| `hasTargetPrice` | boolean | — | Whether the call names a price target |
| `targetPrice` | number | — | The named price target (absent when none) |
| `entryPrice` | number | — | Price when the call was made |
| `analystRatingScore` | number | `>= 60` | The analyst's rating score (0–100, joined from their profile). >= 60 keeps well-rated analysts. |
| `analystBlendedWinRate` | number | `>= 60` | The analyst's blended win rate % (joined from their profile). |

## Feed: Portfolios / curations — ShadowAlpha (`shadowalpha-portfolio`)

Trades made by the portfolios you follow (picked in Data sources). Long
entries arrive bullish; analyst shorts arrive bearish (never a buy); closes
arrive as bearish advisories. `portfolioName`'s dropdown enumerates the
portfolios you actually follow.

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `portfolioId` | number | — | Upstream id of the portfolio that traded |
| `portfolioName` | string | — | The portfolio/curation that traded. One of: `(your followed portfolios)`. |
| `entryPrice` | number | — | Price at which the portfolio entered |
| `quantity` | number | — | Upstream position size (their units, not yours) |
| `upstreamStatus` | string | — | Trade status upstream when observed. One of: `open`, `closed`. |
| `portfolioWinRatePct` | number | `>= 60` | The portfolio's closed-trade win rate % (absent while unknown). >= 60 keeps only strong track records. |
| `portfolioReturnPct` | number | `>= 0` | The portfolio's total return % since inception (absent while unknown). |

## Symbol enrichment: AI conviction — ShadowAlpha (`conviction.*`)

Computed per symbol at decision time (enable in Data sources → ShadowAlpha →
AI conviction analysis). Live mode refuses fixture-fed enrichment.

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `conviction.bullPoints` | number | `>= 3` | Distinct bull-case points in the AI conviction analysis (more = broader bull thesis). |
| `conviction.bearPoints` | number | `<= 2` | Distinct bear-case points in the analysis (fewer = weaker bear thesis). |
| `conviction.consensusCount` | number | — | Analysts in the conviction consensus |
| `conviction.avgShadowScore` | number | — | Average ShadowScore of those analysts |
| `conviction.avgConfidence` | number | `>= 0.6` | Their average stated confidence, 0..1. |
| `conviction.buyZoneActive` | boolean | — | Whether the symbol's buy zone is active |

## Symbol enrichment: Prediction stats — ShadowAlpha (`predictions.*`)

Aggregated tracked predictions per symbol (enable in Data sources).

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `predictions.count` | number | — | Tracked predictions for the symbol in the window |
| `predictions.bullishPct` | number | `>= 60` | Share of those predictions that are bullish (0–100%). |
| `predictions.avgConfidence` | number | — | Average stated confidence (0..1) |
| `predictions.avgLivePnlPct` | number | — | Average live P&L of those predictions (%) |

## Symbol enrichment: Technical indicators — Robinhood (`ta.*`)

Server-computed by Robinhood over daily bars (shape captured live
2026-07-17); the fixture provider serves demo values without credentials.
Enrichment is config-free: reference a `ta.*` field in any rule and the
engine derives and fetches exactly what's needed.

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `ta.rsi14` | number | `<= 70` | RSI (14-day): 0–100 momentum oscillator. Above ~70 is commonly read as overbought, below ~30 as oversold. |
| `ta.macdHist` | number | `>= 0` | MACD histogram (12/26/9): momentum around zero. Positive = MACD above its signal line (bullish momentum); the zero-cross is the classic trigger. |
| `ta.priceVsSma20Pct` | number | `>= 0` | Percent the current price sits above (+) or below (−) its 20-day simple moving average. >= 0 means price is above the average (uptrend posture). |
| `ta.priceVsSma50Pct` | number | `>= 0` | Percent the current price sits above (+) or below (−) its 50-day simple moving average. >= 0 means price is above the average (uptrend posture). |
| `ta.priceVsSma200Pct` | number | `>= 0` | Percent the current price sits above (+) or below (−) its 200-day simple moving average. >= 0 means price is above the average (uptrend posture). |
| `ta.priceVsEma12Pct` | number | `>= 0` | Percent the current price sits above (+) or below (−) its 12-day exponential moving average. >= 0 means price is above the average (uptrend posture). |
| `ta.priceVsEma26Pct` | number | `>= 0` | Percent the current price sits above (+) or below (−) its 26-day exponential moving average. >= 0 means price is above the average (uptrend posture). |
| `ta.bbPercentB20` | number | `<= 25` | Bollinger %B: where price sits inside the bands — 0 = at the lower band, 100 = at the upper. <= 25 = near the lower band (potential dip); >= 100 = riding above the upper band. |

**The period grammar goes beyond the menu**: any `ta.rsiN`, `ta.smaN`,
`ta.emaN`, `ta.priceVsSmaNPct`, `ta.priceVsEmaNPct`, `ta.bbUpperN`,
`ta.bbLowerN`, or `ta.bbPercentBN` works for any period `N` (hand-edit
the profile or type the name) — e.g. `ta.rsi21` or `ta.priceVsSma100Pct`.
MACD is the standard 12/26/9. Raw levels (`ta.sma50`, `ta.bbUpper20`) are
dollar values — prefer the relative `priceVs…Pct`/`%B` forms, which are
comparable across symbols.

Robinhood's indicator engine also supports (not yet wired into the menu):
momentum, roc, cci, williams_r, atr, mfi, adx, donchian_channels, keltner_channels, supertrend, vwap, obv, pivot_points.

## Window aggregates (`window.*`)

Computed over the card's matching signal set — for confluence rules like
"at least 2 distinct sources agree".

| Datapoint | Type | Suggested default | Meaning |
| --- | --- | --- | --- |
| `window.distinctSources` | number | — | Distinct sources in the card's matching set |
| `window.signalCount` | number | — | Signals in the card's matching set |
| `window.maxStrength` | number | — | Strongest signal in the card's matching set |
| `window.types` | string | — | Signal types present in the matching set (use the `has` op) |
