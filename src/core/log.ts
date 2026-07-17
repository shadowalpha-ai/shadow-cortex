/** Tiny leveled logger. Never log secrets — truncate or hash them first. */

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(message: string): void {
    console.log(`[${ts()}] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[${ts()}] WARN ${message}`);
  },
  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? ` — ${err.message}` : "";
    console.error(`[${ts()}] ERROR ${message}${detail}`);
  },
  proposal(text: string): void {
    console.log(`\n${text}\n`);
  },
};
