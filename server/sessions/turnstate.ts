import fs from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../../shared/types';
import { readTailLines } from './parse';
import { codexDbState } from './codexdb';

export interface TurnState {
  state: 'working' | 'idle';
  /** Last write to the live transcript file (mtime, ms). */
  lastWriteMs: number;
}

/**
 * Semantic turn state, read from the transcript's own lifecycle markers.
 *
 * Claude ends every turn with a `system/turn_duration` record; anything
 * user/assistant after the latest one means a turn is in flight. Codex
 * brackets turns with `task_started` / `task_complete` (plus `turn_aborted`
 * on interrupt). Edge cases handled here, all observed in the wild:
 *  - slash-command work (/compact, skills, hooks) runs without writing a
 *    user record — fresh unknown record types after the last turn end count
 *    as activity;
 *  - a tail flooded by subagent (sidechain) records must not read as idle;
 *  - an Esc-interrupt can leave NO end marker — the silence latch in
 *    getTurnState closes any open turn whose file has gone quiet.
 */

// Post-turn bookkeeping claude writes while idle — none of it implies work.
const CLAUDE_BOOKKEEPING = new Set([
  'ai-title', 'last-prompt', 'file-history-snapshot', 'attachment', 'mode',
  'permission-mode', 'queue-operation', 'model_changed', 'tools_changed',
  'skill_listing', 'task_reminder', 'selected_lines_in_ide', 'tool_reference',
  'compact_file_reference', 'diagnostics', 'edited_text_file', 'plan_mode_exit',
  'previous_message_not_found', 'summary',
]);

const recTs = (rec: any): number => {
  const t = Date.parse(rec?.timestamp ?? '');
  return Number.isNaN(t) ? 0 : t;
};

interface Verdict {
  state: 'working' | 'idle';
  /** Verdict depends on wall-clock freshness — don't cache it. */
  volatile: boolean;
}

function claudeTurnState(records: any[], mtimeMs: number): Verdict {
  const now = Date.now();
  let sawFreshSidechain = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec?.isSidechain) {
      // subagents only stream while the parent turn is open
      if (now - (recTs(rec) || mtimeMs) < 120_000) sawFreshSidechain = true;
      continue;
    }
    const t = rec?.type;
    if (t === 'system' && rec.subtype === 'turn_duration') break; // last turn ended here
    if (t === 'user' && !rec.isMeta) {
      const content = rec.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
      if (text.includes('[Request interrupted')) return { state: 'idle', volatile: false };
      return { state: 'working', volatile: false };
    }
    if (t === 'assistant') return { state: 'working', volatile: false };
    if (t === 'system' || t === 'user') continue;
    // Unknown record type after the last turn end: slash-command work writes
    // these with no user record. Only fresh ones count as activity.
    if (typeof t === 'string' && !CLAUDE_BOOKKEEPING.has(t) && now - (recTs(rec) || mtimeMs) < 20_000) {
      return { state: 'working', volatile: true };
    }
  }
  if (sawFreshSidechain) return { state: 'working', volatile: true };
  return { state: 'idle', volatile: false };
}

const CODEX_IDLE_EVENTS = new Set(['task_complete', 'turn_aborted', 'turn_failed', 'error', 'shutdown_complete']);
// Everything codex only emits mid-turn — newer CLIs added the item_* family.
const CODEX_WORKING_EVENTS = new Set([
  'task_started', 'user_message', 'item_started', 'item_updated', 'item_completed',
  'agent_message', 'agent_message_delta', 'agent_reasoning', 'agent_reasoning_delta',
  'agent_reasoning_section_break', 'exec_command_begin', 'exec_command_end',
  'exec_command_output_delta', 'mcp_tool_call_begin', 'mcp_tool_call_end',
  'patch_apply_begin', 'patch_apply_end', 'turn_diff', 'token_count',
]);

function codexTurnState(records: any[]): Verdict {
  let sawResponseItem = false;
  let sawSessionMeta = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec?.type === 'event_msg') {
      const t = rec.payload?.type;
      if (CODEX_IDLE_EVENTS.has(t)) return { state: 'idle', volatile: false };
      if (CODEX_WORKING_EVENTS.has(t)) return { state: 'working', volatile: false };
    }
    if (rec?.type === 'response_item') sawResponseItem = true;
    if (rec?.type === 'session_meta') sawSessionMeta = true;
  }
  // No lifecycle marker in the tail window. A fresh session (session_meta
  // still visible) is idle; a tail flooded by mid-turn response_items means
  // the markers scrolled out — that's an open turn.
  if (sawSessionMeta) return { state: 'idle', volatile: false };
  return { state: sawResponseItem ? 'working' : 'idle', volatile: false };
}

// An open turn whose file has been silent this long is dead (Esc leaves no
// marker; crashes leave no marker). Only a NEW write revives it — this also
// prevents "glancing at a pane repaints it" from flashing a dead turn green.
const STALE_TURN_MS = 180_000;

const cache = new Map<string, { mtimeMs: number; size: number; state: 'working' | 'idle' }>();

const FILE_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function getTurnState(provider: Provider, filePath: string): Promise<TurnState | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  if (provider === 'codex') {
    // paginated codex streams to sqlite, not the rollout — thread_turns is
    // the authoritative lifecycle when the db knows this thread
    const threadId = FILE_UUID_RE.exec(path.basename(filePath))?.[1];
    const db = threadId ? await codexDbState(threadId) : null;
    if (db) {
      const lastWriteMs = Math.max(stat.mtimeMs, db.lastItemMs);
      // No silence latch on this branch: thread_turns is authoritative
      // (interrupts and completions update it), and one long-running exec
      // writes NOTHING for its whole duration — a wall-clock cutoff misreads
      // a live multi-minute command as idle. The remaining safety net is
      // process-level: a crashed or exited codex drops agentRunning (pane
      // back to shell → 'exited'). A hung-but-alive codex reads as working
      // indefinitely — accepted over the common false-idle.
      return { state: db.state, lastWriteMs };
    }
  }
  let state: 'working' | 'idle' | undefined;
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    state = cached.state;
  } else {
    const records = await readTailLines(filePath, stat.size);
    const verdict = provider === 'claude' ? claudeTurnState(records, stat.mtimeMs) : codexTurnState(records);
    state = verdict.state;
    if (!verdict.volatile) {
      cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
      if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    }
  }
  if (state === 'working' && Date.now() - stat.mtimeMs > STALE_TURN_MS) state = 'idle';
  return { state, lastWriteMs: stat.mtimeMs };
}
