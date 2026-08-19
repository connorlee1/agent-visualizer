import fs from 'node:fs/promises';
import path from 'node:path';
import { CODEX_SESSIONS_DIR } from '../config';
import type { ContentBlock, Message, SessionSummary } from '../../shared/types';
import { readHeadLines, readTailLines, safeIso, streamLines } from './parse';

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
export async function parseCodexSessionTranscript(session: SessionSummary): Promise<Message[]> {
  // paginated codex (0.147+) streams items to sqlite and only page-flushes
  // the rollout — prefer the db whenever it has at least as much history
  const { codexDbTranscript } = await import('./codexdb');
  const fromDb = await codexDbTranscript(session.id).catch(() => null);
  const files = getCodexSessionFiles(session.id);
  const list = files.length ? files : [session.filePath];
  const out: Message[] = [];
  for (let i = 0; i < list.length; i++) {
    out.push(...await parseCodexFile(list[i], `F${i}`));
  }
  if (fromDb && fromDb.length >= out.filter((m) => m.role !== 'system').length) return fromDb;
  if (list.length > 1) {
    out.sort((a, b) => {
      if (!a.timestamp || !b.timestamp) return 0;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  }
  return out;
}

async function parseCodexFile(filePath: string, idPrefix: string): Promise<Message[]> {
  const messages: Message[] = [];
  let lineNo = 0;

  const push = (role: Message['role'], content: ContentBlock[], timestamp?: string) => {
    if (content.length) messages.push({ id: `${idPrefix}L${lineNo}`, role, timestamp, content });
  };

  await streamLines(filePath, (rec) => {
    lineNo++;
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
        push('user', [{ kind: 'tool_result', toolId: p.call_id, text }], rec.timestamp);
        break;
      }
    }
  });
  return messages;
}
