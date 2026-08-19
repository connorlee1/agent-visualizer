import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IDLE_SUMMARIES_FILE, SUMMARIZER_CWD } from '../config';

const PROMPT = `You write one-glance recap cards for a dashboard of AI coding agents. Below is the tail of a session between a developer and one coding agent. In 1-2 short sentences, remind the developer what they had this agent working on and where it stands now (what was last done, or what the agent is waiting on). Be concrete about the feature or behavior involved. Plain text only — no markdown, no preamble, no quotes. If the transcript is too thin to say anything useful, reply with only: NONE

Transcript tail:

`;

// Below this, there's nothing worth summarizing (and haiku tends to meta-comment).
const MIN_CONTEXT = 120;

const MODEL = 'haiku';
const TIMEOUT_MS = 60_000;
const MAX_CONCURRENT = 2;
const MAX_OUT = 500;

interface Entry {
  /** Key (transcript mtime) the stored text was generated for. */
  doneKey?: string;
  text?: string;
  inFlightKey?: string;
  /** Failed generations retry after a cooldown — transient claude-cli errors must not pin a card to the raw fallback. */
  failedKey?: string;
  failedAt?: number;
}

const RETRY_MS = 60_000;

// Summaries survive server restarts on disk — this repo's workflow restarts
// :5175 constantly, and without this every restart flashes all cards back to
// the raw fallback and re-spends a haiku call per idle agent.
function loadPersisted(): Map<string, Entry> {
  const map = new Map<string, Entry>();
  try {
    const parsed = JSON.parse(fsSync.readFileSync(IDLE_SUMMARIES_FILE, 'utf8'));
    for (const [file, e] of Object.entries<any>(parsed)) {
      if (typeof e?.doneKey === 'string' && typeof e?.text === 'string' && !/^NONE\b/.test(e.text)) {
        map.set(file, { doneKey: e.doneKey, text: e.text });
      }
    }
  } catch { /* first run or corrupt file — start fresh */ }
  return map;
}

const entries = loadPersisted();
// serialize writes so overlapping updates can't interleave file contents
let writing: Promise<unknown> = Promise.resolve();

function persist(): void {
  const data: Record<string, { doneKey: string; text: string }> = {};
  for (const [file, e] of entries) {
    if (e.doneKey && e.text) data[file] = { doneKey: e.doneKey, text: e.text };
  }
  const json = JSON.stringify(data, null, 2);
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(IDLE_SUMMARIES_FILE), { recursive: true });
    await fs.writeFile(IDLE_SUMMARIES_FILE, json);
  }).catch((err) => console.error('idle-summaries save failed:', err));
}

let running = 0;
const queue: Array<() => void> = [];

async function generate(entry: Entry, key: string, context: string, filePath: string): Promise<void> {
  running++;
  try {
    await fs.mkdir(SUMMARIZER_CWD, { recursive: true });
    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'claude',
        ['-p', '--model', MODEL, '--max-turns', '1'],
        { cwd: SUMMARIZER_CWD, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message} ${String(stderr).slice(0, 400)}`)) : resolve(stdout)),
      );
      child.stdin?.end(PROMPT + context);
    });
    const t = text.trim().replace(/\s+/g, ' ');
    // haiku sometimes appends commentary after NONE — match the prefix, not the exact string
    if (t && !/^NONE\b/.test(t)) entry.text = t.slice(0, MAX_OUT);
    entry.doneKey = key;
    entry.failedKey = undefined;
    persist();
  } catch (err) {
    entry.failedKey = key;
    entry.failedAt = Date.now();
    console.error(`idle summary failed for ${filePath}:`, err instanceof Error ? err.message : err);
  } finally {
    if (entry.inFlightKey === key) entry.inFlightKey = undefined;
    running--;
    queue.shift()?.();
  }
}

/**
 * Cached LLM recap for an idle agent's transcript. Returns the summary if one
 * has been generated for this key (transcript mtime), else kicks off background
 * generation and returns the previous summary (or undefined) in the meantime.
 * Never blocks the poll loop.
 */
export function requestIdleNote(filePath: string, key: string, context: string): string | undefined {
  if (context.length < MIN_CONTEXT) return undefined;
  let entry = entries.get(filePath);
  if (entry && (entry.doneKey === key || entry.inFlightKey === key)) return entry.text;
  if (entry?.failedKey === key && Date.now() - (entry.failedAt ?? 0) < RETRY_MS) return entry.text;
  if (!entry) {
    entry = {};
    entries.set(filePath, entry);
    if (entries.size > 200) entries.delete(entries.keys().next().value as string);
  }
  entry.inFlightKey = key;
  const e = entry;
  const job = () => void generate(e, key, context, filePath);
  if (running < MAX_CONCURRENT) job();
  else queue.push(job);
  return entry.text;
}
