import fs from 'node:fs/promises';
import path from 'node:path';
import type { ContentBlock, Message, SessionSummary } from '../../shared/types';
import { KIMI_SESSIONS_DIR } from '../config';
import { capText, readHeadLines, readTailLines, safeIso, streamLines } from './parse';

// Verified against @moonshot-ai/kimi-code 0.43.1 (wire protocol 1.5).
// Read only the main agent: subagents have their own wire files and must not
// replace the parent conversation when their logs are newer.
export function kimiSessionIdForFile(file: string, root = KIMI_SESSIONS_DIR): string | undefined {
  const parts = path.relative(root, file).split(path.sep);
  return parts.length === 5 && parts[0] !== '..' && parts[2] === 'agents' &&
    parts[3] === 'main' && parts[4] === 'wire.jsonl' ? parts[1] : undefined;
}

export function kimiText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => p?.type === 'text' ? p.text ?? '' : '').join('\n');
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ kind: 'text', text: capText(content) }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((p): ContentBlock[] => {
    if (p?.type === 'text') return [{ kind: 'text', text: capText(String(p.text ?? '')) }];
    if (p?.type === 'think' || p?.type === 'thinking') {
      return [{ kind: 'thinking', text: capText(String(p.think ?? p.thinking ?? p.text ?? '')) }];
    }
    if (p && ['image_url', 'image', 'video_url', 'video', 'file'].includes(p.type)) {
      return [{ kind: 'text', text: `[${p.type.replace('_url', '')} attachment]` }];
    }
    return [];
  });
}

const summaries = new Map<string, { fingerprint: string; summary: SessionSummary }>();
export function invalidateKimi(file: string): void {
  if (file.endsWith('state.json')) summaries.clear();
  else summaries.delete(file);
}

export async function listKimiSessions(root = KIMI_SESSIONS_DIR): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(root, dir.name);
    const sessions = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const base = path.join(projectDir, session.name);
      const file = path.join(base, 'agents', 'main', 'wire.jsonl');
      try {
        const stateFile = path.join(base, 'state.json');
        const [stat, metaStat] = await Promise.all([fs.stat(file), fs.stat(stateFile)]);
        const fingerprint = `${stat.mtimeMs}:${stat.size}:${metaStat.mtimeMs}:${metaStat.size}`;
        const cached = summaries.get(file);
        if (cached?.fingerprint === fingerprint) { out.push(cached.summary); continue; }
        const meta = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const cwd = meta.cwd ?? meta.workDir ?? meta.custom?.cwd;
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
        const [head, tail] = await Promise.all([readHeadLines(file, stat.size), readTailLines(file, stat.size)]);
        const firstPrompt = head.find((r) => r.type === 'context.append_message' && r.message?.role === 'user');
        const model = [...head, ...tail].reverse().find((r) => r.type === 'llm.request' || r.type === 'profile.bind');
        const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : undefined;
        const summary: SessionSummary = {
          provider: 'kimi', id: session.name, projectPath: cwd,
          title: (title ?? kimiText(firstPrompt?.message?.content) ?? '').trim().slice(0, 200) || 'New Kimi conversation',
          titleIsFallback: !title || meta.titleKind === 'replaceable',
          createdAt: safeIso(meta.createdAt, stat.birthtime),
          lastActivityAt: safeIso(Math.max(stat.mtimeMs, new Date(meta.updatedAt ?? 0).getTime() || 0), stat.mtime),
          model: model?.modelAlias ?? model?.model,
          effort: typeof model?.thinkingEffort === 'string' ? model.thinkingEffort : undefined,
          filePath: file, fileSizeBytes: stat.size,
        };
        summaries.set(file, { fingerprint, summary });
        out.push(summary);
      } catch { /* file being created, removed, or a corrupt session: isolate it */ }
    }
  }
  const present = new Set(out.map((s) => s.filePath));
  for (const file of summaries.keys()) if (file.startsWith(root + path.sep) && !present.has(file)) summaries.delete(file);
  return out;
}

/** Fold durable events; never show request traces/system prompts as chat. */
export function createKimiTranscriptParser() {
  const messages: Message[] = [];
  let current: Message | undefined;
  let step: string | undefined;
  let ordinal = 0;
  let model: string | undefined;
  let undoAnchors: number[] = [];
  const add = (role: Message['role'], content: ContentBlock[], time: unknown, id?: string): Message => {
    const message: Message = { id: id ?? `kimi-${ordinal}`, role, content,
      timestamp: typeof time === 'number' || typeof time === 'string' ? safeIso(time, new Date(0)) : undefined,
      ...(role === 'assistant' ? { model } : {}) };
    messages.push(message);
    return message;
  };
  const accept = (r: any) => {
    ordinal++;
    if (!r || (r.agentId && r.agentId !== 'main')) return;
    if (r.type === 'llm.request' || r.type === 'profile.bind') {
      model = r.modelAlias ?? r.model ?? model;
      if (current) current.model = model;
      return;
    }
    if (r.type === 'context.clear') { messages.length = 0; undoAnchors = []; current = undefined; step = undefined; return; }
    if (r.type === 'context.undo') {
      if (Number.isInteger(r.count) && r.count > 0 && r.count <= undoAnchors.length) {
        messages.splice(undoAnchors[undoAnchors.length - r.count]);
        undoAnchors.splice(-r.count);
        current = undefined; step = undefined;
      }
      return;
    }
    if (r.type === 'context.apply_compaction') {
      // Preserve history for the reader, with an explicit boundary. Undo cannot
      // retract prompts from before the current model context's compaction.
      add('system', [{ kind: 'text', text: `Context compacted\n${capText(typeof r.summary === 'string' ? r.summary : r.contextSummary ?? kimiText(r.summary?.content))}` }], r.time);
      undoAnchors = []; current = undefined; step = undefined;
      return;
    }
    if (r.type === 'context.append_message') {
      const m = r.message;
      if (!m || !['user', 'assistant', 'tool', 'system'].includes(m.role)) return;
      const origin = m.origin;
      if (origin?.kind === 'injection') return;
      if (m.role === 'user' && (!origin || origin.kind === 'user' ||
        (['skill_activation', 'plugin_command'].includes(origin.kind) && origin.trigger === 'user-slash'))) undoAnchors.push(messages.length);
      const blocks: ContentBlock[] = m.role === 'tool'
        ? [{ kind: 'tool_result' as const, toolId: m.toolCallId, text: capText(kimiText(m.content)), isError: m.isError }]
        : contentBlocks(m.content);
      for (const call of m.toolCalls ?? []) {
        let input = call.arguments;
        try { input = JSON.parse(input); } catch { /* retain malformed/partial arguments */ }
        blocks.push({ kind: 'tool_use', toolId: call.id, name: call.name, input });
      }
      add(m.role === 'tool' ? 'user' : m.role, blocks, r.time, m.id);
      return;
    }
    if (r.type !== 'context.append_loop_event' || !r.event) return;
    const e = r.event;
    if (e.type === 'step.begin') {
      current = add('assistant', [], r.time, e.uuid);
      step = e.uuid;
    } else if (e.type === 'content.part' && current && e.stepUuid === step) {
      current.content.push(...contentBlocks([e.part]));
    } else if (e.type === 'tool.call' && current && e.stepUuid === step) {
      current.content.push({ kind: 'tool_use', toolId: e.toolCallId, name: e.name, input: e.args });
    } else if (e.type === 'tool.result') {
      add('user', [{ kind: 'tool_result', toolId: e.toolCallId,
        text: capText(kimiText(e.result?.output)), isError: e.result?.isError }], r.time);
    } else if (e.type === 'step.end' && current) {
      if (e.usage) current.usage = {
        inputTokens: (e.usage.inputOther ?? 0) + (e.usage.inputCacheRead ?? 0) + (e.usage.inputCacheCreation ?? 0),
        outputTokens: e.usage.output, cacheReadTokens: e.usage.inputCacheRead,
      };
      if (e.finishReason !== 'interrupted' && e.finishReason !== 'error') { current = undefined; step = undefined; }
    }
  };
  return { accept, messages };
}

export async function parseKimiTranscript(file: string): Promise<Message[]> {
  const parser = createKimiTranscriptParser();
  await streamLines(file, parser.accept);
  return parser.messages.filter((m) => m.content.length > 0);
}

export function kimiTurnState(records: any[]): 'working' | 'idle' {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r?.agentId && r.agentId !== 'main') continue;
    if (r?.type === 'turn.ended' || r?.type === 'context.clear' || r?.type === 'context.undo') return 'idle';
    if (r?.type === 'turn.cancel' && r.target !== 'queued') return 'idle';
    if (r?.type === 'turn.prompt' || r?.type === 'context.append_loop_event' ||
      (r?.type === 'llm.request' && r.kind === 'loop')) return 'working';
  }
  return 'idle';
}

export function kimiIdleSummary(records: any[]) {
  const parser = createKimiTranscriptParser();
  // Tail windows can start mid-step. Synthesize its opening only for this
  // bounded recap, never for the full transcript reader.
  const firstPart = records.find((r) => r?.type === 'context.append_loop_event' && r.event?.stepUuid);
  if (firstPart) parser.accept({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: firstPart.event.stepUuid } });
  records.forEach(parser.accept);
  const convo = parser.messages.flatMap((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return [];
    const text = m.content.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim();
    return text ? [{ role: m.role, text }] : [];
  }).slice(-10);
  return {
    lastPrompt: [...convo].reverse().find((m) => m.role === 'user')?.text.slice(0, 400),
    lastAgentMessage: [...convo].reverse().find((m) => m.role === 'assistant')?.text.slice(0, 400),
    context: convo.map((m) => `${m.role}: ${m.text.slice(0, 700)}`).join('\n').slice(-7000) || undefined,
  };
}
