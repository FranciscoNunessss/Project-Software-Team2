import { useEffect, useState } from 'react';
import type { HistoryPoint, Snapshot } from '../../shared/types';

export type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: Snapshot; history: HistoryPoint[] };

/** Loads ./data/latest.json and ./data/history/index.json (relative to the page). */
export function useOkrData(): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('./data/latest.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`latest.json: HTTP ${res.status}`);
        const snapshot = (await res.json()) as Snapshot;
        let history: HistoryPoint[] = [];
        try {
          const h = await fetch('./data/history/index.json', { cache: 'no-cache' });
          if (h.ok) history = (await h.json()) as HistoryPoint[];
        } catch {
          /* history is optional */
        }
        if (!cancelled) setState({ kind: 'ready', snapshot, history });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
