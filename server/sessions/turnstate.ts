import fs from 'node:fs/promises';
import type { Provider } from '../../shared/types';
import { readTailLines } from './parse';

export interface TurnState {
  state: 'working' | 'idle';
  /** Last write to the live transcript file (mtime, ms). */
  lastWriteMs: number;
}

/**
 * Semantic turn state, read from the transcript's own lifecycle markers —
 * no timing heuristics.
 *
 * Claude ends every turn with a `system/turn_duration` record; anything
 * user/assistant after the latest one means a turn is in flight. Codex
 * brackets turns with `task_started` / `task_complete` (plus `turn_aborted`
 * on interrupt) event_msg records.
 */
function claudeTurnState(records: any[]): 'working' | 'idle' {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec?.isSidechain) continue; // subagent chatter — the main chain decides
    if (rec?.type === 'system' && rec.subtype === 'turn_duration') return 'idle';
    if (rec?.type === 'user' && !rec.isMeta) {
      const content = rec.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
      if (text.includes('[Request interrupted')) return 'idle';
      return 'working'; // a prompt or tool_result — the turn is open
    }
    if (rec?.type === 'assistant') return 'working';
  }
  return 'idle'; // only bookkeeping so far (fresh session)
}

const CODEX_IDLE_EVENTS = new Set(['task_complete', 'turn_aborted', 'turn_failed', 'error', 'shutdown_complete']);
const CODEX_WORKING_EVENTS = new Set(['task_started', 'user_message']);

function codexTurnState(records: any[]): 'working' | 'idle' {
  let sawResponseItem = false;
  let sawSessionMeta = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec?.type === 'event_msg') {
      const t = rec.payload?.type;
      if (CODEX_IDLE_EVENTS.has(t)) return 'idle';
      if (CODEX_WORKING_EVENTS.has(t)) return 'working';
    }
    if (rec?.type === 'response_item') sawResponseItem = true;
    if (rec?.type === 'session_meta') sawSessionMeta = true;
  }
  // No lifecycle marker in the tail window. A fresh session (session_meta
  // still visible) is idle; a tail flooded by mid-turn response_items means
  // the task_started marker scrolled out — that's an open turn.
  if (sawSessionMeta) return 'idle';
  return sawResponseItem ? 'working' : 'idle';
}

const cache = new Map<string, { mtimeMs: number; size: number; state: 'working' | 'idle' }>();

export async function getTurnState(provider: Provider, filePath: string): Promise<TurnState | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { state: cached.state, lastWriteMs: stat.mtimeMs };
  }
  const records = await readTailLines(filePath, stat.size);
  const state = provider === 'claude' ? claudeTurnState(records) : codexTurnState(records);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return { state, lastWriteMs: stat.mtimeMs };
}
