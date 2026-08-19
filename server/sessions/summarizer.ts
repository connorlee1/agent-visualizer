import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { SUMMARIZER_CWD } from '../config';

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
  /** Key (transcript mtime) the stored text was generated for — also set on failure, so a broken CLI can't retry every poll. */
  doneKey?: string;
  text?: string;
  inFlightKey?: string;
}

const entries = new Map<string, Entry>();
let running = 0;
const queue: Array<() => void> = [];

async function generate(entry: Entry, key: string, context: string): Promise<void> {
  running++;
  try {
    await fs.mkdir(SUMMARIZER_CWD, { recursive: true });
    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'claude',
        ['-p', '--model', MODEL, '--max-turns', '1'],
        { cwd: SUMMARIZER_CWD, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin?.end(PROMPT + context);
    });
    const t = text.trim().replace(/\s+/g, ' ');
    if (t && t !== 'NONE') entry.text = t.slice(0, MAX_OUT);
  } catch (err) {
    console.error('idle summary generation failed:', err instanceof Error ? err.message : err);
  } finally {
    entry.doneKey = key;
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
  if (!entry) {
    entry = {};
    entries.set(filePath, entry);
    if (entries.size > 200) entries.delete(entries.keys().next().value as string);
  }
  entry.inFlightKey = key;
  const e = entry;
  const job = () => void generate(e, key, context);
  if (running < MAX_CONCURRENT) job();
  else queue.push(job);
  return entry.text;
}
