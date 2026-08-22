import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ContentBlock, Message } from '../../shared/types';

/**
 * Codex 0.147+ runs conversations in `history_mode: paginated`: the rollout
 * jsonl only receives page flushes (sometimes never), while the live stream
 * of items lands in ~/.codex/thread_history_1.sqlite. That database is the
 * complete, current source for both transcripts and turn state; rollouts
 * remain the fallback for old sessions and metadata (cwd lives only there).
 * All reads go through the sqlite3 CLI read-only — no native deps.
 */

const exec = promisify(execFile);
const DB = path.join(os.homedir(), '.codex', 'thread_history_1.sqlite');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 20_000;

async function query<T>(sql: string): Promise<T[] | null> {
  if (!fs.existsSync(DB)) return null;
  try {
    const { stdout } = await exec('sqlite3', ['-json', '-readonly', DB, sql], {
      maxBuffer: 256 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed ? (JSON.parse(trimmed) as T[]) : [];
  } catch {
    return null; // db busy/missing/old sqlite3 — callers fall back to rollouts
  }
}

const isInjected = (text: string) => {
  const t = text.trim();
  return !t || t.startsWith('<') || t.startsWith('# AGENTS.md');
};

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((c: any) => c?.text ?? '').filter(Boolean).join('\n')
    : typeof content === 'string' ? content : '';

function itemToMessage(raw: string, createdAtMs: number): Message | null {
  let item: any;
  try {
    item = JSON.parse(raw);
  } catch {
    return null;
  }
  const timestamp = new Date(createdAtMs).toISOString();
  const id = String(item?.id ?? `${createdAtMs}`);
  const msg = (role: Message['role'], content: ContentBlock[]): Message | null =>
    content.length ? { id, role, timestamp, content } : null;

  switch (item?.type) {
    case 'userMessage': {
      const text = textOf(item.content);
      if (isInjected(text)) return null;
      return msg('user', [{ kind: 'text', text }]);
    }
    case 'agentMessage': {
      const text = String(item.text ?? textOf(item.content));
      return text.trim() ? msg('assistant', [{ kind: 'text', text }]) : null;
    }
    case 'reasoning': {
      const text = textOf(item.summary) || textOf(item.content);
      return text.trim() ? msg('assistant', [{ kind: 'thinking', text }]) : null;
    }
    case 'commandExecution': {
      const blocks: ContentBlock[] = [{
        kind: 'tool_use',
        toolId: id,
        name: 'exec',
        input: { command: item.command, cwd: item.cwd },
      }];
      const output = item.aggregatedOutput ?? item.output;
      if (typeof output === 'string' && output.trim()) {
        blocks.push({ kind: 'tool_result', toolId: id, text: output, isError: item.exitCode ? item.exitCode !== 0 : false });
      }
      return msg('assistant', blocks);
    }
    case 'fileChange': {
      const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => c?.path).filter(Boolean) : [];
      return msg('assistant', [{ kind: 'tool_use', toolId: id, name: 'edit', input: { paths } }]);
    }
    case 'webSearch':
      return msg('assistant', [{ kind: 'tool_use', toolId: id, name: 'web_search', input: { query: item.query ?? item.q } }]);
    case 'contextCompaction':
      return null; // internal housekeeping
    default: {
      // unknown item families (collabAgentToolCall, subAgentActivity, …)
      // still show up as steps rather than vanishing
      const { type, ...rest } = item ?? {};
      return msg('assistant', [{ kind: 'tool_use', toolId: id, name: String(type ?? 'item'), input: rest }]);
    }
  }
}

/**
 * Incremental per-thread transcript state. A long thread is ~20k rows and
 * costs seconds to pull through the sqlite3 CLI — and an ACTIVE thread's
 * fingerprint changes every few seconds, which used to mean a full requery
 * per chat poll (measured 9s for one busy thread). Rows are append-only, so
 * after the first full load we only fetch rows newer than the last seen.
 */
interface ThreadTranscript {
  lastMs: number;
  lastRowid: number;
  messages: Message[];
}
const threadTranscripts = new Map<string, ThreadTranscript>();
const THREAD_TRANSCRIPTS_MAX = 12;

function ingestRows(
  state: ThreadTranscript,
  rows: Array<{ rowid: number; item_json: string; created_at_ms: number }>,
): void {
  for (const row of rows) {
    const m = itemToMessage(row.item_json, row.created_at_ms);
    if (m) state.messages.push(m);
    state.lastMs = row.created_at_ms;
    state.lastRowid = row.rowid;
  }
}

/** Full transcript for a thread from the codex db, newest MAX_ITEMS. */
export async function codexDbTranscript(threadId: string): Promise<Message[] | null> {
  if (!UUID_RE.test(threadId)) return null;
  const id = threadId.toLowerCase();
  let state = threadTranscripts.get(id);
  if (!state) {
    const rows = await query<{ rowid: number; item_json: string; created_at_ms: number }>(
      `SELECT rowid, item_json, created_at_ms FROM thread_items WHERE thread_id='${id}' ORDER BY created_at_ms DESC, rowid DESC LIMIT ${MAX_ITEMS}`,
    );
    if (!rows || rows.length === 0) return null;
    rows.reverse();
    state = { lastMs: 0, lastRowid: 0, messages: [] };
    ingestRows(state, rows);
  } else {
    const rows = await query<{ rowid: number; item_json: string; created_at_ms: number }>(
      `SELECT rowid, item_json, created_at_ms FROM thread_items WHERE thread_id='${id}' AND (created_at_ms > ${state.lastMs} OR (created_at_ms = ${state.lastMs} AND rowid > ${state.lastRowid})) ORDER BY created_at_ms ASC, rowid ASC LIMIT ${MAX_ITEMS}`,
    );
    // sqlite hiccup mid-append: last known state beats a null that would
    // bounce every caller to the (stale) rollout fallback
    if (rows) ingestRows(state, rows);
  }
  threadTranscripts.delete(id);
  threadTranscripts.set(id, state);
  while (threadTranscripts.size > THREAD_TRANSCRIPTS_MAX) {
    threadTranscripts.delete(threadTranscripts.keys().next().value as string);
  }
  // callers cache the returned array by fingerprint — hand out a copy so the
  // next incremental append can't mutate what they already stored
  return state.messages.slice();
}

export interface CodexDbState {
  state: 'working' | 'idle';
  lastItemMs: number;
}

// This probe runs per codex agent per poll AND per transcript fingerprint —
// a short TTL collapses the sqlite spawns without hiding real transitions.
const stateCache = new Map<string, { at: number; value: CodexDbState | null }>();

/** Turn state straight from thread_turns: an open turn has no completed_at. */
export async function codexDbState(threadId: string): Promise<CodexDbState | null> {
  if (!UUID_RE.test(threadId)) return null;
  const cached = stateCache.get(threadId);
  if (cached && Date.now() - cached.at < 1500) return cached.value;
  const rows = await query<{ completed_at: number | null; status: string; last_item: number | null }>(
    `SELECT t.completed_at, t.status,
            (SELECT MAX(created_at_ms) FROM thread_items WHERE thread_id=t.thread_id) AS last_item
       FROM thread_turns t WHERE t.thread_id='${threadId.toLowerCase()}'
       ORDER BY t.started_at DESC LIMIT 1`,
  );
  const row = rows?.[0];
  const value: CodexDbState | null = row
    ? {
        state: row.completed_at != null || ['completed', 'failed', 'interrupted'].includes(row.status)
          ? 'idle'
          : 'working',
        lastItemMs: row.last_item ?? 0,
      }
    : null;
  stateCache.set(threadId, { at: Date.now(), value });
  if (stateCache.size > 200) stateCache.delete(stateCache.keys().next().value as string);
  return value;
}
