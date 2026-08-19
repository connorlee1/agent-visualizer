import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLOSED_AGENTS_FILE, LIVE_AGENTS_FILE } from './config';
import type { ClosedAgent, TmuxAgent } from '../shared/types';

const MAX_ENTRIES = 30;

function load(): ClosedAgent[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(CLOSED_AGENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // first run or corrupt file — start fresh
    return [];
  }
}

let entries: ClosedAgent[] = load();
// serialize writes so a fast kill+dismiss can't interleave file contents
let writing: Promise<unknown> = Promise.resolve();

function save(): void {
  const data = JSON.stringify(entries, null, 2);
  writing = writing.then(async () => {
    await fsp.mkdir(path.dirname(CLOSED_AGENTS_FILE), { recursive: true });
    await fsp.writeFile(CLOSED_AGENTS_FILE, data);
  }).catch((err) => console.error('closed-agents save failed:', err));
}

export const getClosedAgents = (): ClosedAgent[] => entries;

function record(agent: TmuxAgent, closedAt = new Date().toISOString()): void {
  // a re-killed resume of the same conversation replaces its older entry
  entries = entries.filter((e) =>
    e.name !== agent.name && !(agent.sessionId && e.sessionId === agent.sessionId));
  entries.unshift({
    id: randomUUID(),
    name: agent.name,
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
    model: agent.model,
    sessionId: agent.sessionId,
    resumedFrom: agent.resumedFrom,
    createdAt: agent.createdAt,
    closedAt,
  });
  entries = entries.slice(0, MAX_ENTRIES);
  save();
}

// Last-seen managed agents; tmux user options die with the session, so this
// snapshot is the only place a killed agent's metadata survives. Mirrored to
// LIVE_AGENTS_FILE so agents that die while the server itself is down (crash,
// reboot, tmux server death) are still recovered into the closed list.
let snapshot = new Map<string, TmuxAgent>();
// Names seeded from disk at startup → the snapshot file's mtime, the closest
// known-alive time for agents that turn out to have died while we were down.
const recovered = new Map<string, string>();
try {
  const parsed = JSON.parse(fs.readFileSync(LIVE_AGENTS_FILE, 'utf8'));
  if (Array.isArray(parsed)) {
    const mtime = fs.statSync(LIVE_AGENTS_FILE).mtime.toISOString();
    for (const a of parsed as TmuxAgent[]) {
      if (!a?.name) continue;
      snapshot.set(a.name, a);
      recovered.set(a.name, mtime);
    }
  }
} catch {
  // first run or corrupt file — nothing to recover
}

let lastSnapshotData: string | undefined;

function persistSnapshot(): void {
  const data = JSON.stringify([...snapshot.values()], null, 2);
  if (data === lastSnapshotData) return;
  lastSnapshotData = data;
  writing = writing.then(async () => {
    await fsp.mkdir(path.dirname(LIVE_AGENTS_FILE), { recursive: true });
    await fsp.writeFile(LIVE_AGENTS_FILE, data);
  }).catch((err) => console.error('live-agents save failed:', err));
}

/**
 * Diff the current tmux listing against the last one and record managed
 * sessions that disappeared — catches kills from outside the dashboard and
 * agents whose tmux session simply ended.
 */
export function trackAgents(current: TmuxAgent[]): void {
  const next = new Map<string, TmuxAgent>();
  for (const a of current) {
    if (!a.managed) continue;
    const prev = snapshot.get(a.name);
    // keep the live-resolved session id when this listing lacks one
    next.set(a.name, { ...a, sessionId: a.sessionId ?? prev?.sessionId, preview: '' });
  }
  for (const [name, prev] of snapshot) {
    if (!next.has(name)) record(prev, recovered.get(name));
  }
  recovered.clear();
  snapshot = next;
  persistSnapshot();
}

/** Last-seen metadata for a live managed agent (session id is live-resolved). */
export const getTrackedAgent = (name: string): TmuxAgent | undefined => snapshot.get(name);

/** Record an agent the dashboard is about to kill, using its last-seen metadata. */
export function noteKilled(name: string): void {
  const agent = snapshot.get(name);
  if (agent) {
    record(agent);
    snapshot.delete(name);
    persistSnapshot();
  }
}

/** A closed conversation was resumed — drop it from the list. */
export function noteResumed(sessionId: string): void {
  const id = sessionId.toLowerCase();
  const kept = entries.filter((e) => e.sessionId?.toLowerCase() !== id);
  if (kept.length !== entries.length) {
    entries = kept;
    save();
  }
}

export function dismissClosed(id: string): boolean {
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  entries = kept;
  save();
  return true;
}
