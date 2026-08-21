import { useMemo, useSyncExternalStore } from 'react';
import type { AgentStatus } from '@shared/types';

// "Truly" done: the agent must hold 'waiting' this long without resuming.
// Brief between-step lulls and status flaps never reach the flash.
const CONFIRM_DONE_MS = 10_000;
const FLASH_MS = 1_200;
// While a done agent sits unattended, the flash repeats on this period.
const REPEAT_MS = 10_000;
// A sleeping (muted) pane idle this long strobes aggressively — a "this
// still exists" reminder, since mute silences the gentle ring — then again
// every interval. Counted from when we first see it waiting, so agents
// already idle at page load qualify too. Awake panes never strobe: their
// done-ring already fires every 10s.
const REMIND_IDLE_MS = 10 * 60_000;
// Matches .flash-remind-overlay (0.4s × 6 pulses).
const REMIND_FLASH_MS = 2_400;
// Trailing quiet after each strobe, so back-to-back reminders from panes
// that came due together read as separate events, not one long blur.
const REMIND_GAP_MS = 800;

// Muting is a standing per-agent choice (set any time, even preemptively),
// so it survives reloads. Dead tmux names linger in the list; harmless.
const MUTE_KEY = 'doneFlashMuted';
const mutedNames = ((): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
})();
const saveMuted = () => localStorage.setItem(MUTE_KEY, JSON.stringify([...mutedNames]));

interface Entry {
  wasWorking: boolean;
  /** 10s-confirmed done episode — rings until the agent works again. */
  done: boolean;
  muted: boolean;
  flash: boolean;
  /** Aggressive long-idle strobe currently showing. */
  remind: boolean;
  /** Previous status fed to update() — turn-boundary detection. */
  lastStatus?: AgentStatus;
  /** When the dashboard observed the current turn start (header timer).
      Client-observed: a page reload restarts the count. */
  workingSince?: number;
  confirmTimer?: number;
  flashTimer?: number;
  repeatTimer?: number;
  remindTimer?: number;
  remindFlashTimer?: number;
}

// Module-level and keyed by tmux name so the episode survives navigation and
// is shared by every panel showing the same agent (muting one mutes all).
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function entryFor(name: string): Entry {
  let e = entries.get(name);
  if (!e) {
    e = { wasWorking: false, done: false, muted: mutedNames.has(name), flash: false, remind: false };
    entries.set(name, e);
  }
  return e;
}

function stopFlashing(e: Entry) {
  window.clearTimeout(e.flashTimer);
  window.clearTimeout(e.repeatTimer);
  e.flashTimer = e.repeatTimer = undefined;
  e.flash = false;
}

// ---- serialized strobes -------------------------------------------------
// Only one aggressive strobe may show at a time across the whole wall —
// several sleeping panes coming due together would otherwise strobe in an
// overlapping mess. Due panes take the lock in turn; the rest queue.
let strobeLock = false; // held while a strobe shows and through its gap
let strobeShowing: string | null = null;
const strobeQueue: string[] = [];

function requestStrobe(name: string) {
  if (strobeLock) {
    if (strobeShowing !== name && !strobeQueue.includes(name)) strobeQueue.push(name);
    return;
  }
  showStrobe(name);
}

function showStrobe(name: string) {
  const e = entryFor(name);
  strobeLock = true;
  strobeShowing = name;
  e.remind = true;
  emit();
  e.remindFlashTimer = window.setTimeout(() => {
    e.remindFlashTimer = undefined;
    e.remind = false;
    strobeShowing = null;
    emit();
    armRemind(name); // next 10-min cadence, counted from strobe end
    window.setTimeout(releaseStrobeSlot, REMIND_GAP_MS);
  }, REMIND_FLASH_MS);
}

function releaseStrobeSlot() {
  strobeLock = false;
  while (strobeQueue.length) {
    const name = strobeQueue.shift()!;
    const e = entries.get(name);
    if (!e) continue;
    if (!e.muted) {
      // woke up while queued — back to the silent cadence instead
      if (e.remindTimer == null && e.remindFlashTimer == null) armRemind(name);
      continue;
    }
    showStrobe(name);
    return;
  }
}

function stopReminding(name: string) {
  const e = entryFor(name);
  window.clearTimeout(e.remindTimer);
  window.clearTimeout(e.remindFlashTimer);
  e.remindTimer = e.remindFlashTimer = undefined;
  e.remind = false;
  const qi = strobeQueue.indexOf(name);
  if (qi >= 0) strobeQueue.splice(qi, 1);
  if (strobeShowing === name) {
    // cut mid-show: free the slot after the usual gap
    strobeShowing = null;
    window.setTimeout(releaseStrobeSlot, REMIND_GAP_MS);
  }
}
// -------------------------------------------------------------------------

function reset(name: string) {
  const e = entryFor(name);
  window.clearTimeout(e.confirmTimer);
  e.confirmTimer = undefined;
  stopFlashing(e);
  const hadRemind = e.remind;
  stopReminding(name);
  e.wasWorking = false;
  if (e.done || hadRemind) {
    e.done = false;
    emit();
  }
}

function ring(name: string) {
  const e = entryFor(name);
  if (!e.done || e.muted) return;
  e.flash = true;
  window.clearTimeout(e.flashTimer);
  e.flashTimer = window.setTimeout(() => {
    e.flash = false;
    emit();
  }, FLASH_MS);
  e.repeatTimer = window.setTimeout(() => ring(name), REPEAT_MS);
  emit();
}

function armRemind(name: string) {
  const e = entryFor(name);
  e.remindTimer = window.setTimeout(() => {
    e.remindTimer = undefined;
    if (!e.muted) {
      // awake panes ring on their own — keep counting silently so muting
      // later doesn't restart the cadence
      armRemind(name);
      return;
    }
    requestStrobe(name);
  }, REMIND_IDLE_MS);
}

function update(name: string, status: AgentStatus | undefined) {
  const e = entryFor(name);
  const prev = e.lastStatus;
  e.lastStatus = status;
  // A turn opens on entering working OR needs-approval from an idle state
  // (an approval dialog can be the first visible sign of an open turn).
  // working ⇄ needs-approval mid-turn keeps the original start.
  const turnOpen = status === 'working' || status === 'needs-approval';
  const wasOpen = prev === 'working' || prev === 'needs-approval';
  if (turnOpen && !wasOpen) e.workingSince = Date.now();
  if (status === 'working') {
    reset(name);
    e.wasWorking = true;
    return;
  }
  if (status === 'waiting') {
    if (e.wasWorking && !e.done && e.confirmTimer == null) {
      e.confirmTimer = window.setTimeout(() => {
        e.confirmTimer = undefined;
        e.done = true;
        ring(name);
      }, CONFIRM_DONE_MS);
    }
    // resume a ring paused by an approval blip
    if (e.done && !e.muted && e.flashTimer == null && e.repeatTimer == null) ring(name);
    // not already counting, showing, or queued for a strobe slot
    if (e.remindTimer == null && e.remindFlashTimer == null && !strobeQueue.includes(name)) {
      armRemind(name);
    }
    return;
  }
  if (status === 'needs-approval') {
    // often a one-poll false positive (agent output that merely LOOKS like a
    // dialog) — pause the ring but keep the episode, so a blip can't kill it
    stopFlashing(e);
    return;
  }
  // exited / gone
  reset(name);
}

/**
 * Feed the freshest statuses for ALL agents — called from useAgents (mounted
 * in AppShell on every page), so work→idle transitions are tracked even
 * while no panel for the agent is on screen.
 */
export function syncDoneFlash(list: ReadonlyArray<{ name: string; status: AgentStatus }>): void {
  for (const a of list) update(a.name, a.status);
}

/** Whether an agent is currently slept — lets panes avoid stealing focus. */
export function isDoneFlashMuted(name: string): boolean {
  return entryFor(name).muted;
}

/** Observed start of the agent's current turn (undefined if never seen working). */
export function workingSinceOf(name: string): number | undefined {
  return entries.get(name)?.workingSince;
}

// Cross-tab sync: the mute list is per-origin localStorage, but each tab's
// module reads it only at load. Without this, an agent muted in one dashboard
// tab/window stays bright (moon unfilled, no dim) in every other open tab —
// seen live. The storage event fires in all tabs except the writer.
window.addEventListener('storage', (ev) => {
  if (ev.key !== MUTE_KEY) return;
  let next: Set<string>;
  try {
    next = new Set(JSON.parse(ev.newValue ?? '[]') as string[]);
  } catch {
    return;
  }
  mutedNames.clear();
  next.forEach((n) => mutedNames.add(n));
  for (const [name, e] of entries) {
    const m = next.has(name);
    if (m === e.muted) continue;
    e.muted = m;
    if (m) {
      stopFlashing(e);
    } else {
      stopReminding(name);
      armRemind(name);
      ring(name);
    }
  }
  emit();
});

/** Standing mute: while set, this agent never flashes. Unmuting mid-episode rings. */
export function toggleDoneFlashMute(name: string): void {
  const e = entryFor(name);
  e.muted = !e.muted;
  if (e.muted) {
    mutedNames.add(name);
    stopFlashing(e);
  } else {
    mutedNames.delete(name);
    // leave the strobe pipeline (mid-show or queued); restart a silent cadence
    stopReminding(name);
    armRemind(name);
  }
  saveMuted();
  emit();
  if (!e.muted) ring(name);
}

// Snapshot is bit-packed: useSyncExternalStore needs a primitive so emits
// that don't change this agent's state don't force a re-render.
const snapshotFor = (name: string | undefined): number => {
  const e = name ? entries.get(name) : undefined;
  return e ? (e.flash ? 1 : 0) | (e.muted ? 2 : 0) | (e.remind ? 4 : 0) : 0;
};

/**
 * Reactive slept-agent set, for wall-level concerns (e.g. the grid's
 * awake-only filter). Includes stale names for exited agents — intersect
 * with the live agent list. The snapshot is a joined string so unrelated
 * emits (flash/remind ticks) compare equal and skip the re-render.
 */
export function useMutedNames(): Set<string> {
  const joined = useSyncExternalStore(subscribe, () => [...mutedNames].sort().join('\n'));
  return useMemo(() => new Set(joined ? joined.split('\n') : []), [joined]);
}

/**
 * Repeating end-of-work notifier (read-only view; syncDoneFlash drives the
 * state). After an agent that was observed working has stayed idle for a
 * continuous 10s, `flash` pulses true for ~1s every 10s until the agent
 * works again — unless the agent is muted. `remind` strobes for ~2.5s once
 * a MUTED pane has sat idle for 10 continuous minutes, and again every 10
 * minutes after — sleep's periodic heartbeat. Strobes are serialized
 * wall-wide: one at a time, the rest queue.
 */
export function useDoneFlash(
  name: string | undefined,
): { flash: boolean; muted: boolean; remind: boolean } {
  const snap = useSyncExternalStore(subscribe, () => snapshotFor(name));
  return { flash: !!(snap & 1), muted: !!(snap & 2), remind: !!(snap & 4) };
}
