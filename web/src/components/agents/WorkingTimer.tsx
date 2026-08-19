import { useEffect, useReducer } from 'react';
import { workingSinceOf } from '../../lib/useDoneFlash';

const fmt = (s: number): string => {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * Elapsed time on the agent's current turn, ticking every second — rendered
 * next to the "working" status label. Counts from when the dashboard first
 * observed the turn (a reload restarts the count), so it reads as "how long
 * has this been grinding", not a billing-grade duration.
 */
export function WorkingTimer({ name }: { name: string }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const iv = window.setInterval(tick, 1000);
    return () => window.clearInterval(iv);
  }, []);
  const since = workingSinceOf(name);
  if (!since) return null;
  return <> · {fmt(Math.max(0, Math.floor((Date.now() - since) / 1000)))}</>;
}
