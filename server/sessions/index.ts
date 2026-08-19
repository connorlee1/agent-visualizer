import fs from 'node:fs/promises';
import chokidar from 'chokidar';
import { CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR } from '../config';
import type { Message, Project, Provider, SessionSummary, TranscriptResponse } from '../../shared/types';
import { invalidateClaude, listClaudeSessions, parseClaudeTranscript } from './claude';
import { getCodexSessionFiles, invalidateCodex, listCodexSessions, parseCodexSessionTranscript } from './codex';
import { getAgentName } from '../agentnames';

const byRecency = (a: SessionSummary, b: SessionSummary) =>
  new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();

export async function getAllSessions(): Promise<SessionSummary[]> {
  const [claude, codex] = await Promise.all([listClaudeSessions(), listCodexSessions()]);
  return [...claude, ...codex]
    .map((s) => ({ ...s, agentName: getAgentName(s.id) }))
    .sort(byRecency);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getProjects(): Promise<Project[]> {
  const sessions = await getAllSessions();
  const now = Date.now();
  const groups = new Map<string, Project>();
  for (const s of sessions) {
    let project = groups.get(s.projectPath);
    if (!project) {
      project = {
        id: Buffer.from(s.projectPath).toString('base64url'),
        path: s.projectPath,
        name: s.projectPath.split('/').filter(Boolean).pop() ?? s.projectPath,
        providers: [],
        sessionCount: 0,
        lastActivityAt: s.lastActivityAt,
        weeklyActivity: new Array(12).fill(0),
      };
      groups.set(s.projectPath, project);
    }
    project.sessionCount++;
    if (!project.providers.includes(s.provider)) project.providers.push(s.provider);
    if (new Date(s.lastActivityAt) > new Date(project.lastActivityAt)) project.lastActivityAt = s.lastActivityAt;
    const weeksAgo = Math.floor((now - new Date(s.lastActivityAt).getTime()) / WEEK_MS);
    if (weeksAgo >= 0 && weeksAgo < 12) project.weeklyActivity[11 - weeksAgo]++;
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

export async function getSessionsForProject(projectPath: string): Promise<SessionSummary[]> {
  return (await getAllSessions()).filter((s) => s.projectPath === projectPath);
}

export async function findSession(provider: Provider, id: string): Promise<SessionSummary | undefined> {
  return (await getAllSessions()).find((s) => s.provider === provider && s.id === id);
}

// Parsed transcripts are big (a 6.8MB JSONL becomes tens of MB of objects) — keep few.
const TRANSCRIPT_LRU_MAX = 10;
const transcriptCache = new Map<string, { mtimeMs: number; size: number; messages: Message[] }>();

/**
 * Cache-validity fingerprint. A codex conversation can span several rollout
 * files — and resume may append to ANY of them — so the fingerprint covers
 * the whole group, not just the canonical file.
 */
async function transcriptStat(summary: SessionSummary): Promise<{ mtimeMs: number; size: number }> {
  const files = summary.provider === 'codex' ? getCodexSessionFiles(summary.id) : [];
  const list = files.length ? files : [summary.filePath];
  const stats = await Promise.all(list.map((f) => fs.stat(f).catch(() => null)));
  let mtimeMs = 0;
  let size = 0;
  for (const s of stats) {
    if (!s) continue;
    mtimeMs = Math.max(mtimeMs, s.mtimeMs);
    size += s.size;
  }
  if (summary.provider === 'codex') {
    // paginated codex streams to sqlite while the rollout sits still — fold
    // the db's newest item into the fingerprint so live chats don't freeze
    const { codexDbState } = await import('./codexdb');
    const db = await codexDbState(summary.id).catch(() => null);
    if (db?.lastItemMs) mtimeMs = Math.max(mtimeMs, db.lastItemMs);
  }
  return { mtimeMs, size };
}

async function parseTranscript(summary: SessionSummary): Promise<Message[]> {
  const stat = await transcriptStat(summary);
  const cached = transcriptCache.get(summary.filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    transcriptCache.delete(summary.filePath); // refresh LRU position
    transcriptCache.set(summary.filePath, cached);
    return cached.messages;
  }
  const messages = summary.provider === 'claude'
    ? await parseClaudeTranscript(summary.filePath)
    : await parseCodexSessionTranscript(summary);
  transcriptCache.set(summary.filePath, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
  while (transcriptCache.size > TRANSCRIPT_LRU_MAX) {
    const oldest = transcriptCache.keys().next().value as string;
    transcriptCache.delete(oldest);
  }
  return messages;
}

export async function getTranscript(
  provider: Provider,
  id: string,
  opts: { tail?: number; offset?: number; limit?: number },
): Promise<TranscriptResponse | undefined> {
  const summary = await findSession(provider, id);
  if (!summary) return undefined;
  const all = await parseTranscript(summary);
  const total = all.length;
  let start: number;
  let end: number;
  if (opts.offset != null) {
    start = Math.max(0, Math.min(opts.offset, total));
    end = Math.min(total, start + (opts.limit ?? 200));
  } else {
    start = Math.max(0, total - (opts.tail ?? 200));
    end = total;
  }
  return {
    session: { ...summary, messageCount: total },
    messages: all.slice(start, end),
    total,
    offset: start,
  };
}

/** The file a session is actively being written to (codex groups: newest by mtime). */
export async function livePathForSession(provider: Provider, id: string): Promise<string | null> {
  const summary = await findSession(provider, id);
  if (!summary) return null;
  if (provider === 'claude') return summary.filePath;
  const files = getCodexSessionFiles(id);
  if (files.length <= 1) return summary.filePath;
  let best = summary.filePath;
  let bestMtime = -1;
  for (const f of files) {
    const stat = await fs.stat(f).catch(() => null);
    if (stat && stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      best = f;
    }
  }
  return best;
}

export function invalidateSession(filePath: string): void {
  invalidateClaude(filePath);
  invalidateCodex(filePath);
  transcriptCache.delete(filePath);
}

export function startWatcher(onChange: (filePath: string) => void): void {
  const watcher = chokidar.watch([CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR], {
    ignoreInitial: true,
    depth: 4,
  });
  const pending = new Map<string, NodeJS.Timeout>();
  const handle = (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    clearTimeout(pending.get(filePath));
    pending.set(filePath, setTimeout(() => {
      pending.delete(filePath);
      invalidateSession(filePath);
      onChange(filePath);
    }, 250));
  };
  watcher.on('add', handle);
  watcher.on('change', handle);
  watcher.on('unlink', (fp) => {
    invalidateSession(fp);
    onChange(fp);
  });
  watcher.on('error', (err) => console.error('[watcher]', err));
}
