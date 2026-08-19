import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR, SUMMARIZER_CWD } from '../config';
import type { ContentBlock, Message, SessionSummary } from '../../shared/types';
import { readHeadLines, readTailLines, safeIso, streamLines } from './parse';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}
const indexCache = new Map<string, CacheEntry>();

export function invalidateClaude(filePath: string): void {
  indexCache.delete(filePath);
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Human-typed prompt text from a user record, or undefined for tool results / injected content. */
function extractUserText(rec: any): string | undefined {
  if (rec?.type !== 'user' || rec.isSidechain || rec.isMeta) return undefined;
  const content = rec.message?.content;
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text);
    if (parts.length) text = parts.join('\n');
  }
  text = text?.trim();
  if (!text || text.startsWith('<')) return undefined;
  return text;
}

async function indexClaudeSession(filePath: string): Promise<SessionSummary> {
  const stat = await fs.stat(filePath);
  const cached = indexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;

  const head = await readHeadLines(filePath, stat.size);
  const tail = stat.size > 0 ? await readTailLines(filePath, stat.size) : [];

  const stem = path.basename(filePath, '.jsonl');
  let sessionId = stem;
  let projectPath = '';
  let gitBranch: string | undefined;
  let headModel: string | undefined;
  let headEffort: string | undefined;
  let firstUserText: string | undefined;
  let createdAt: string | undefined;

  for (const rec of head) {
    if (!sessionId || sessionId === stem) sessionId = rec.sessionId ?? sessionId;
    if (!projectPath && typeof rec.cwd === 'string') projectPath = rec.cwd;
    if (!gitBranch && typeof rec.gitBranch === 'string' && rec.gitBranch) gitBranch = rec.gitBranch;
    if (!createdAt && rec.timestamp) createdAt = safeIso(rec.timestamp, stat.birthtime);
    if (!firstUserText) firstUserText = extractUserText(rec);
    if (!headModel && rec.type === 'assistant' && rec.message?.model) headModel = rec.message.model;
    if (!headEffort && typeof rec.effort === 'string') headEffort = rec.effort;
  }

  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let lastActivityAt: string | undefined;
  let tailModel: string | undefined;
  let tailEffort: string | undefined;
  for (let i = tail.length - 1; i >= 0; i--) {
    const rec = tail[i];
    if (!lastActivityAt && rec.timestamp) lastActivityAt = safeIso(rec.timestamp, stat.mtime);
    if (!aiTitle && rec.type === 'ai-title' && typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
    if (!lastPrompt && rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string') lastPrompt = rec.lastPrompt;
    if (!tailModel && rec.type === 'assistant' && rec.message?.model) tailModel = rec.message.model;
    if (!tailEffort && typeof rec.effort === 'string') tailEffort = rec.effort;
    if (aiTitle && lastPrompt && lastActivityAt && tailModel && tailEffort) break;
  }
  // tail values are freshest — they reflect mid-session /model changes
  const model = tailModel ?? headModel;
  const effort = tailEffort ?? headEffort;
  if (!aiTitle) {
    // titles can also appear early in short sessions
    for (const rec of head) {
      if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
    }
  }

  const fallback = (firstUserText ?? lastPrompt)?.replace(/\s+/g, ' ').trim();
  const summary: SessionSummary = {
    provider: 'claude',
    id: sessionId,
    projectPath: projectPath || path.dirname(filePath),
    title: aiTitle ?? (fallback ? truncate(fallback, 80) : 'Untitled conversation'),
    titleIsFallback: !aiTitle,
    createdAt: createdAt ?? stat.birthtime.toISOString(),
    lastActivityAt: lastActivityAt ?? stat.mtime.toISOString(),
    model,
    effort,
    gitBranch,
    filePath,
    fileSizeBytes: stat.size,
  };
  indexCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  await Promise.all(dirs.map(async (dir) => {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
    let files: string[] = [];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const summary = await indexClaudeSession(path.join(dirPath, file)).catch(() => null);
      // hide the dashboard's own headless summarizer calls (projectPath is authoritative)
      if (summary && summary.projectPath !== SUMMARIZER_CWD) out.push(summary);
    }
  }));
  return out;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function claudeContent(rec: any): ContentBlock[] {
  const content = rec.message?.content;
  if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    switch (item?.type) {
      case 'text':
        if (item.text?.trim()) blocks.push({ kind: 'text', text: item.text });
        break;
      case 'thinking':
        if (item.thinking?.trim()) blocks.push({ kind: 'thinking', text: item.thinking });
        break;
      case 'redacted_thinking':
        blocks.push({ kind: 'thinking', text: '[redacted]' });
        break;
      case 'tool_use':
        blocks.push({ kind: 'tool_use', toolId: item.id ?? '', name: item.name ?? 'tool', input: item.input });
        break;
      case 'tool_result':
        blocks.push({
          kind: 'tool_result',
          toolId: item.tool_use_id,
          text: toolResultText(item.content),
          isError: item.is_error === true,
        });
        break;
      case 'image':
        blocks.push({ kind: 'text', text: '[image]' });
        break;
    }
  }
  return blocks;
}

/**
 * Parse the full transcript and walk the main branch: from the last transcript
 * record back to the root via parentUuid (over ALL records, since bookkeeping
 * lines participate in the chain), keeping only user/assistant messages.
 */
export async function parseClaudeTranscript(filePath: string): Promise<Message[]> {
  const parentOf = new Map<string, string | null>();
  const messages = new Map<string, Message>();
  const childMessagesOf = new Map<string, number>(); // parent uuid -> # of user/assistant children
  let lastMessageUuid: string | undefined;

  await streamLines(filePath, (rec) => {
    if (typeof rec?.uuid === 'string') parentOf.set(rec.uuid, rec.parentUuid ?? null);
    if ((rec?.type !== 'user' && rec?.type !== 'assistant') || rec.isSidechain || rec.isMeta) return;
    if (typeof rec.uuid !== 'string') return;
    const content = claudeContent(rec);
    if (!content.length) return;
    const usage = rec.message?.usage;
    messages.set(rec.uuid, {
      id: rec.uuid,
      parentId: rec.parentUuid ?? undefined,
      role: rec.message?.role === 'assistant' ? 'assistant' : 'user',
      timestamp: rec.timestamp,
      content,
      model: rec.message?.model,
      usage: usage
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
          }
        : undefined,
    });
    const parentKey = rec.parentUuid ?? 'root';
    childMessagesOf.set(parentKey, (childMessagesOf.get(parentKey) ?? 0) + 1);
    lastMessageUuid = rec.uuid;
  });

  if (!lastMessageUuid) return [];

  const mainPath: Message[] = [];
  let cursor: string | null | undefined = lastMessageUuid;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const msg = messages.get(cursor);
    if (msg) {
      const siblings = (childMessagesOf.get(msg.parentId ?? 'root') ?? 1) - 1;
      mainPath.push(siblings > 0 ? { ...msg, hiddenSiblings: siblings } : msg);
    }
    cursor = parentOf.get(cursor);
  }
  mainPath.reverse();
  return mainPath;
}
