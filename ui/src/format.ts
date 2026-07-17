const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(value: number): string {
  return usd.format(value);
}

/** Signed money — the sign is explicit so color never carries meaning alone. */
export function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : "−"}${usd.format(Math.abs(value))}`;
}

export function signedPct(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

export function shares(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "");
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
}
