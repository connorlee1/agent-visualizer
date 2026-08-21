import { useSyncExternalStore } from 'react';

/**
 * Standing per-agent "hide from dashboard" flags, keyed by agent ref
 * (host:name for remote agents). Client-side only, like the done-flash mute
 * list: the agent keeps running in tmux — listing surfaces (sidebar, home,
 * wall, tab strip, 1–9 jump, approval count) just skip it. Direct views
 * (its own page, side panels) still resolve, and the home page can reveal
 * hidden agents to unhide them. Dead refs linger in the list; harmless.
 */
const KEY = 'hiddenAgents';
const hidden = ((): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
})();
let snap: ReadonlySet<string> = new Set(hidden);
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function toggleAgentHidden(ref: string): void {
  if (!hidden.delete(ref)) hidden.add(ref);
  localStorage.setItem(KEY, JSON.stringify([...hidden]));
  snap = new Set(hidden);
  listeners.forEach((l) => l());
}

/** Live set of hidden agent refs. */
export function useHiddenAgents(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snap);
}
