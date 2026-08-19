import fs from 'node:fs/promises';
import type { Provider } from '../../shared/types';
import { readTailLines } from './parse';

export interface IdleSummary {
  lastPrompt?: string;
  lastAgentMessage?: string;
  /** Recent user/agent exchange, forward order, for the LLM summarizer. Server-side only. */
  context?: string;
}

const MAX_LEN = 400;
const CTX_ITEM_LEN = 700;
const CTX_ITEMS = 10;
const CTX_TOTAL = 7000;

// A single turn can append hundreds of KB (codex especially), pushing the
// user_message/task_complete markers far from EOF — read a wide tail. Only
// runs when a turn ends or stalls, and is mtime-cached, so the cost is rare.
const TAIL_BYTES = 512 * 1024;

const clip = (s: string, max = MAX_LEN): string => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// Prompts injected by harnesses/automation rather than typed by the user
// (approval-assessment loops, wrapped command/context blocks).
const AUTOMATION_RE = /^</;
const CODEX_AUTOMATION_RE = /approval assessment|TRANSCRIPT DELTA|^</i;

type ConvoItem = { role: 'user' | 'agent'; text: string };

function finishContext(convo: ConvoItem[]): string | undefined {
  // collected in reverse; render forward, newest-biased by the collection cap
  const lines: string[] = [];
  let total = 0;
  for (const item of convo) {
    const line = `${item.role === 'user' ? 'User' : 'Agent'}: ${clip(item.text, CTX_ITEM_LEN)}`;
    if (total + line.length > CTX_TOTAL) break;
    lines.push(line);
    total += line.length;
  }
  return lines.length ? lines.reverse().join('\n') : undefined;
}

function claudeSummary(records: any[]): IdleSummary {
  const out: IdleSummary = {};
  const convo: ConvoItem[] = [];
  for (let i = records.length - 1; i >= 0 && convo.length < CTX_ITEMS; i--) {
    const rec = records[i];
    if (rec?.isSidechain) continue;
    // the CLI restamps a pre-truncated copy of the latest typed prompt
    if (!out.lastPrompt && rec?.type === 'last-prompt' && typeof rec.lastPrompt === 'string') {
      out.lastPrompt = clip(rec.lastPrompt);
    }
    if (rec?.type === 'assistant') {
      const content = rec.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
        : '';
      if (text.trim()) {
        if (!out.lastAgentMessage) out.lastAgentMessage = clip(text);
        convo.push({ role: 'agent', text });
      }
    }
    if (rec?.type === 'user' && !rec.isMeta) {
      const content = rec.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
      const t = text.trim();
      if (t && !AUTOMATION_RE.test(t) && !t.startsWith('[Request interrupted')) {
        if (!out.lastPrompt) out.lastPrompt = clip(t);
        convo.push({ role: 'user', text: t });
      }
    }
  }
  out.context = finishContext(convo);
  return out;
}

function codexSummary(records: any[]): IdleSummary {
  const out: IdleSummary = {};
  const convo: ConvoItem[] = [];
  for (let i = records.length - 1; i >= 0 && convo.length < CTX_ITEMS; i--) {
    const rec = records[i];
    if (rec?.type !== 'event_msg') continue;
    const p = rec.payload;
    if (p?.type === 'user_message' && typeof p.message === 'string') {
      const t = p.message.trim();
      if (t && !CODEX_AUTOMATION_RE.test(t)) {
        if (!out.lastPrompt) out.lastPrompt = clip(t);
        convo.push({ role: 'user', text: t });
      }
    }
    const reply = p?.type === 'task_complete' && typeof p.last_agent_message === 'string'
      ? p.last_agent_message
      : p?.type === 'agent_message' && typeof p.message === 'string'
        ? p.message
        : '';
    if (reply.trim()) {
      if (!out.lastAgentMessage) out.lastAgentMessage = clip(reply);
      // task_complete repeats the closing agent_message — skip the duplicate
      if (convo[convo.length - 1]?.text !== reply) convo.push({ role: 'agent', text: reply });
    }
  }
  out.context = finishContext(convo);
  return out;
}

const cache = new Map<string, { mtimeMs: number; size: number; summary: IdleSummary }>();

/**
 * Glance context for an idle agent, read from the transcript tail: the last
 * prompt the user typed and the agent's latest reply. Cached by mtime, so
 * repeated polls of an idle (unchanging) file cost one stat.
 */
export async function getIdleSummary(provider: Provider, filePath: string): Promise<IdleSummary | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
  const records = await readTailLines(filePath, stat.size, TAIL_BYTES);
  const summary = provider === 'claude' ? claudeSummary(records) : codexSummary(records);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return summary;
}
