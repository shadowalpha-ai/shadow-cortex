/**
 * Basic market-hours gate: weekdays, 9:30–16:00 US/Eastern. Deliberately has
 * NO holiday calendar (documented limitation) — on market holidays the engine
 * will believe the market is open; orders simply won't fill until it is.
 */

export function isMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;

  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
