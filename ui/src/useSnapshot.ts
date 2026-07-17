import { useEffect, useState } from "react";
import type { Snapshot } from "./types";

/**
 * Live engine state via SSE (/api/events). EventSource reconnects on its own
 * after engine restarts; `connected` drives the header's live indicator.
 */
export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // First paint from a plain fetch so the page isn't blank while SSE opens.
    fetch("/api/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setSnapshot(s))
      .catch(() => undefined);

    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (e) => setSnapshot(JSON.parse(e.data));
    return () => events.close();
  }, []);

  return { snapshot, connected };
}

export async function answerProposal(id: string, verb: "confirm" | "reject"): Promise<void> {
  await fetch(`/api/proposals/${id}/${verb}`, { method: "POST" });
}
