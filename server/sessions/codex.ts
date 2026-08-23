import fs from 'node:fs/promises';
import path from 'node:path';
import { CODEX_SESSIONS_DIR } from '../config';
import type { ContentBlock, Message, SessionSummary } from '../../shared/types';
import { capText, readHeadLines, readTailLines, safeIso, streamLinesFrom } from './parse';
import type { WindowedMessages } from './codexdb';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
  /** Side-thread of another conversation (auto-review guardian, thread_spawn
      subagents) — shares the parent's session_id but is not a conversation. */
  subagent: boolean;
}
const indexCache = new Map<string, CacheEntry>();

export function invalidateCodex(filePath: string): void {
  indexCache.delete(filePath);
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cleanTitle = (s: string) => s.replace(/\s+/g, ' ').replace(/^[#>\-*\s]+/, '').trim();
export const UNTITLED = 'Untitled conversation';

function itemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => c?.text ?? c?.input_text ?? c?.output_text ?? '')
    .filter(Boolean)
    .join('\n');
}

/** Injected context (environment XML, AGENTS.md instructions), not a real prompt. */
const isInjected = (text: string) => {
  const t = text.trim();
  return !t || t.startsWith('<') || t.startsWith('# AGENTS.md') || /^<?(environment_context|user_instructions|INSTRUCTIONS)/.test(t);
};

async function indexCodexSession(filePath: string): Promise<CacheEntry> {
  const stat = await fs.stat(filePath);
  const cached = indexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

  const head = await readHeadLines(filePath, stat.size);
  const tail = stat.size > 0 ? await readTailLines(filePath, stat.size) : [];
  const stem = path.basename(filePath, '.jsonl');

  let sessionId = stem.replace(/^rollout-.*?((?:[0-9a-f]+-){4}[0-9a-f]+)$/i, '$1');
  let projectPath = '';
  let createdAt: string | undefined;
  let firstUserText: string | undefined;
  let headModel: string | undefined;
  let headEffort: string | undefined;
  let subagent = false;

  for (const rec of head) {
    const p = rec?.payload;
    if (rec?.type === 'session_meta' && p) {
      sessionId = p.session_id ?? p.id ?? sessionId;
      projectPath = p.cwd ?? projectPath;
      createdAt = safeIso(p.timestamp ?? rec.timestamp, stat.birthtime);
      subagent = p.thread_source === 'subagent';
    }
    if (rec?.type === 'turn_context' && p?.model && !headModel) {
      headModel = p.model;
      if (typeof p.effort === 'string') headEffort = p.effort;
    }
    if (!firstUserText && rec?.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
      const text = itemText(p.content);
      if (!isInjected(text)) firstUserText = text.trim();
    }
    if (!createdAt && rec?.timestamp) createdAt = safeIso(rec.timestamp, stat.birthtime);
  }

  let lastActivityAt: string | undefined;
  let tailModel: string | undefined;
  let tailEffort: string | undefined;
  for (let i = tail.length - 1; i >= 0; i--) {
    const rec = tail[i];
    if (!lastActivityAt && rec?.timestamp) lastActivityAt = safeIso(rec.timestamp, stat.mtime);
    if (!tailModel && rec?.type === 'turn_context' && rec.payload?.model) {
      tailModel = rec.payload.model;
      if (typeof rec.payload.effort === 'string') tailEffort = rec.payload.effort;
    }
    if (lastActivityAt && tailModel) break;
  }
  const model = tailModel ?? headModel;
  const effort = tailEffort ?? headEffort;

  const summary: SessionSummary = {
    provider: 'codex',
    id: sessionId,
    projectPath: projectPath || CODEX_SESSIONS_DIR,
    title: firstUserText ? truncate(cleanTitle(firstUserText), 80) : UNTITLED,
    titleIsFallback: true,
    createdAt: createdAt ?? stat.birthtime.toISOString(),
    lastActivityAt: lastActivityAt ?? stat.mtime.toISOString(),
    model,
    effort,
    filePath,
    fileSizeBytes: stat.size,
  };
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, summary, subagent };
  indexCache.set(filePath, entry);
  return entry;
}

/**
 * Canonical conversation id for a rollout file: subagent side-threads carry
 * their parent's session_id in session_meta, so a live agent whose newest open
 * file is a guardian/spawned thread still resolves to the parent conversation.
 */
export async function codexSessionIdForFile(filePath: string): Promise<string | null> {
  try {
    return (await indexCodexSession(filePath)).summary.id;
  } catch {
    return null;
  }
}

/**
 * A resumed codex conversation continues in a NEW rollout file with the SAME
 * session_id — one conversation can span several files. Track the group so
 * the transcript can be stitched back together in order.
 */
const fileGroups = new Map<string, string[]>();

export function getCodexSessionFiles(id: string): string[] {
  return fileGroups.get(id) ?? [];
}

export async function listCodexSessions(): Promise<SessionSummary[]> {
  const files: string[] = [];
  let years: string[] = [];
  try {
    years = await fs.readdir(CODEX_SESSIONS_DIR);
  } catch {
    return [];
  }
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = path.join(CODEX_SESSIONS_DIR, year);
    for (const month of await fs.readdir(yearDir).catch(() => [] as string[])) {
      const monthDir = path.join(yearDir, month);
      for (const day of await fs.readdir(monthDir).catch(() => [] as string[])) {
        const dayDir = path.join(monthDir, day);
        for (const file of await fs.readdir(dayDir).catch(() => [] as string[])) {
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) files.push(path.join(dayDir, file));
        }
      }
    }
  }
  const perFile: SessionSummary[] = [];
  await Promise.all(files.map(async (f) => {
    const indexed = await indexCodexSession(f).catch(() => null);
    // subagent side-threads share the parent's session_id — merging them in
    // would hijack the conversation's model/effort/lastActivity (they are
    // usually the newest file) and interleave their chatter into the
    // stitched transcript (cc-bio-agent: 100+ thread_spawn/guardian files)
    if (indexed && !indexed.subagent) perFile.push(indexed.summary);
  }));

  // merge rollout files that belong to the same conversation
  const groups = new Map<string, SessionSummary[]>();
  for (const s of perFile) {
    let group = groups.get(s.id);
    if (!group) groups.set(s.id, (group = []));
    group.push(s);
  }
  const merged: SessionSummary[] = [];
  for (const [id, group] of groups) {
    group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    fileGroups.set(id, group.map((g) => g.filePath));
    const latest = group[group.length - 1];
    const realTitle = group.find((g) => g.title !== UNTITLED)?.title;
    merged.push({
      ...latest,
      createdAt: group[0].createdAt,
      title: realTitle ?? latest.title,
      model: latest.model ?? [...group].reverse().find((g) => g.model)?.model,
      effort: latest.effort ?? [...group].reverse().find((g) => g.effort)?.effort,
      fileSizeBytes: group.reduce((sum, g) => sum + g.fileSizeBytes, 0),
    });
  }
  return merged;
}

/**
 * Parse one conversation, stitching together all rollout files that share its
 * session_id. Codex sometimes appends new turns to the ORIGINAL file on
 * resume, so merge by record timestamp rather than trusting file order.
 */
// Rollout parses cached by the files' OWN identity. The conversation
// fingerprint tracks the sqlite db and changes every few seconds on an active
// paginated thread, but the rollout files sit still between page flushes —
// re-streaming them per chat poll (a campaign session's group is 281MB,
// measured ~15s) stacked requests faster than the 3s poll drained them.
const rolloutParseCache = new Map<string, { fp: string; result: WindowedMessages }>();
const ROLLOUT_PARSE_MAX = 24;
// Group-level retained tail — same reasoning as the db window: chats render
// the tail, the reader pages a few screens; nobody needs 56k parsed messages
// resident. The true total still comes back for honest counts and paging.
const GROUP_WINDOW = 2000;

async function parseRolloutGroup(sessionId: string, list: string[]): Promise<WindowedMessages> {
  const stats = await Promise.all(list.map((f) => fs.stat(f).catch(() => null)));
  const fp = list.map((f, i) => `${f}:${stats[i]?.size ?? 0}:${stats[i]?.mtimeMs ?? 0}`).join('|');
  const cached = rolloutParseCache.get(sessionId);
  if (cached && cached.fp === fp) {
    rolloutParseCache.delete(sessionId); // refresh LRU position
    rolloutParseCache.set(sessionId, cached);
    return cached.result;
  }
  const out: Message[] = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const file = await parseCodexFile(list[i], `F${i}`);
    total += file.total;
    out.push(...file.messages);
  }
  if (list.length > 1) {
    out.sort((a, b) => {
      if (!a.timestamp || !b.timestamp) return 0;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  }
  const result: WindowedMessages = {
    messages: out.length > GROUP_WINDOW ? out.slice(out.length - GROUP_WINDOW) : out,
    total,
  };
  // Release everything older than the window from per-file residency. Safe
  // because trimming happens AFTER the merged sort (never before — a
  // pre-sort per-file trim thins the middle of the timeline and corrupts
  // the window start, caught by differential test), and because the window
  // boundary only ever moves forward: a dropped-older message can never
  // re-enter the tail. Counts (state.total) keep the true totals.
  const startTs = result.messages[0]?.timestamp;
  if (total > result.messages.length && startTs) {
    for (const f of list) {
      const st = rolloutFileCache.get(f);
      if (st && st.messages.length) {
        st.messages = st.messages.filter((m) => !m.timestamp || m.timestamp >= startTs);
      }
    }
  }
  rolloutParseCache.set(sessionId, { fp, result });
  while (rolloutParseCache.size > ROLLOUT_PARSE_MAX) {
    rolloutParseCache.delete(rolloutParseCache.keys().next().value as string);
  }
  return result;
}

export async function parseCodexSessionTranscript(session: SessionSummary): Promise<WindowedMessages> {
  // paginated codex (0.147+) streams items to sqlite and only page-flushes
  // the rollout — prefer the db whenever it has at least as much history
  const { codexDbTranscript } = await import('./codexdb');
  const fromDb = await codexDbTranscript(session.id).catch(() => null);
  const files = getCodexSessionFiles(session.id);
  const list = files.length ? files : [session.filePath];
  const out = await parseRolloutGroup(session.id, list);
  if (fromDb && fromDb.total >= out.total) return fromDb;
  return out;
}

/**
 * Per-FILE incremental parse state. Active paginated threads page-flush
 * their rollouts every few seconds, so the group fingerprint above misses
 * constantly — and a full re-stream of a campaign group (281MB) burned ~70%
 * of a core continuously (CPU-profiled). Rollouts are append-only: keep the
 * parsed messages plus a byte offset per file and only stream appended
 * complete lines; a shrink (rewrite — rare) resets that file cleanly.
 */
interface RolloutFileState {
  bytes: number;
  lineNo: number;
  messages: Message[];
  /** ALL messages this file ever produced — messages holds only the tail. */
  total: number;
}
const rolloutFileCache = new Map<string, RolloutFileState>();
// Sized for the WORST real group sum, not a guess: two live campaign groups
// measured 148 files / 1.1GB — a cap below the working set means permanent
// eviction thrash, i.e. re-streaming the gigabyte on every page flush.
const ROLLOUT_FILE_MAX = 512;

async function parseCodexFile(filePath: string, idPrefix: string): Promise<{ messages: Message[]; total: number }> {
  const stat = await fs.stat(filePath).catch(() => null);
  const existing = rolloutFileCache.get(filePath);
  if (!stat) return { messages: existing?.messages ?? [], total: existing?.total ?? 0 };
  let st = existing;
  if (!st || stat.size < st.bytes) st = { bytes: 0, lineNo: 0, messages: [], total: 0 };
  const state = st;
  rolloutFileCache.delete(filePath);
  rolloutFileCache.set(filePath, state);
  while (rolloutFileCache.size > ROLLOUT_FILE_MAX) {
    rolloutFileCache.delete(rolloutFileCache.keys().next().value as string);
  }
  if (stat.size <= state.bytes) return { messages: state.messages, total: state.total };

  const messages = state.messages;
  const push = (role: Message['role'], content: ContentBlock[], timestamp?: string) => {
    if (content.length) {
      messages.push({ id: `${idPrefix}L${lineNo}`, role, timestamp, content });
      state.total++;
    }
  };
  let lineNo = state.lineNo;

  state.bytes += await streamLinesFrom(filePath, state.bytes, (rec) => {
    lineNo = ++state.lineNo;
    if (rec?.type !== 'response_item' || !rec.payload) return;
    const p = rec.payload;
    switch (p.type) {
      case 'message': {
        if (p.role !== 'user' && p.role !== 'assistant') return;
        const text = itemText(p.content);
        if (p.role === 'user' && isInjected(text)) return;
        if (text.trim()) push(p.role, [{ kind: 'text', text }], rec.timestamp);
        break;
      }
      case 'reasoning': {
        const text = itemText(p.summary) || itemText(p.content);
        if (text.trim()) push('assistant', [{ kind: 'thinking', text }], rec.timestamp);
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        let input: unknown = p.arguments ?? p.input ?? p.action;
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { /* keep raw string */ }
        }
        push('assistant', [{
          kind: 'tool_use',
          toolId: p.call_id ?? `${idPrefix}L${lineNo}`,
          name: p.name ?? p.type,
          input,
        }], rec.timestamp);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        let raw = p.output;
        if (typeof raw === 'string' && /^\s*[[{]/.test(raw)) {
          try { raw = JSON.parse(raw); } catch { /* plain text that happens to start with a bracket */ }
        }
        const text = typeof raw === 'string' ? raw : itemText(raw?.content ?? raw) || JSON.stringify(raw ?? '');
        push('user', [{ kind: 'tool_result', toolId: p.call_id, text: capText(text) }], rec.timestamp);
        break;
      }
    }
  });
  return { messages, total: state.total };
}
