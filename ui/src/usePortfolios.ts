/**
 * The user's ShadowAlpha portfolios, fetched once from the engine
 * (GET /api/portfolios — live list when connected, fixture list otherwise).
 * Returns raw rows; callers map/filter to their own shape.
 */

import { useEffect, useState } from "react";

export interface PortfolioRow {
  name: string | null;
  status: string | null;
  winRatePct?: number | null;
  [key: string]: unknown;
}

export function usePortfolios(): PortfolioRow[] {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/portfolios")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body?.portfolios) setRows(body.portfolios as PortfolioRow[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return rows;
}
