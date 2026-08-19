import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import type { TmuxAgent } from '../shared/types';
import { CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR } from './config';
import { codexSessionIdForFile } from './sessions/codex';

const exec = promisify(execFile);

// <uuid>.jsonl (claude) or rollout-<ts>-<uuid>.jsonl (codex)
const SESSION_FILE_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Files under dir currently held open by any process: [pid, path] pairs. */
async function openFilesUnder(dir: string): Promise<Array<[number, string]>> {
  try {
    // -F pn: machine-readable "p<pid>" / "n<path>" lines
    const { stdout } = await exec('lsof', ['-Fpn', '+D', dir]);
    const out: Array<[number, string]> = [];
    let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
      else if (line.startsWith('n') && pid && line.endsWith('.jsonl')) out.push([pid, line.slice(1)]);
    }
    return out;
  } catch {
    // lsof exits 1 when nothing holds files there — and any failure just
    // means we fall back to the stamped session ids
    return [];
  }
}

async function parentTable(): Promise<Map<number, number>> {
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=']);
    const table = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid != null) table.set(pid, ppid);
    }
    return table;
  } catch {
    return new Map();
  }
}

let cache: { at: number; value: Map<number, string> } | null = null;

/** panePid -> transcript file path that pane's process tree holds open. */
async function liveSessionsByPane(panePids: number[]): Promise<Map<number, string>> {
  if (cache && Date.now() - cache.at < 3000) return cache.value;
  const [claudeFiles, codexFiles, parents] = await Promise.all([
    openFilesUnder(CLAUDE_PROJECTS_DIR),
    openFilesUnder(CODEX_SESSIONS_DIR),
    parentTable(),
  ]);
  const paneSet = new Set(panePids);
  // a process can hold several session files open (e.g. read the resumed
  // source + write the live one) — rank candidates by last write
  const candidates = new Map<number, string[]>();
  for (const [holderPid, filePath] of [...claudeFiles, ...codexFiles]) {
    if (!SESSION_FILE_RE.test(filePath)) continue;
    let pid: number | undefined = holderPid;
    for (let hops = 0; pid && hops < 25; hops++) {
      if (paneSet.has(pid)) {
        const list = candidates.get(pid) ?? [];
        list.push(filePath);
        candidates.set(pid, list);
        break;
      }
      pid = parents.get(pid);
    }
  }
  const result = new Map<number, string>();
  for (const [panePid, files] of candidates) {
    let best: { path: string; mtime: number } | null = null;
    for (const path of files) {
      const stat = await fs.stat(path).catch(() => null);
      const mtime = stat?.mtimeMs ?? 0;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    if (best && SESSION_FILE_RE.test(best.path)) result.set(panePid, best.path);
  }
  cache = { at: Date.now(), value: result };
  return result;
}

/**
 * Ground-truth terminal↔conversation linkage: overwrite each agent's stamped
 * session id with the transcript file its process actually has open. Catches
 * quit-and-rerun, /clear, and fresh codex sessions that the stamp can't see.
 * Returns agent name -> live transcript file path for the agents it resolved.
 */
export async function resolveLiveSessions(agents: TmuxAgent[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const targets = agents.filter((a) => a.panePid && a.agentRunning);
  if (!targets.length) return paths;
  const live = await liveSessionsByPane(targets.map((a) => a.panePid!));
  for (const agent of targets) {
    const filePath = live.get(agent.panePid!);
    if (!filePath) continue;
    // the filename id of a codex subagent side-thread is the thread's own id,
    // which matches no conversation — session_meta carries the parent's
    const id = agent.provider === 'codex'
      ? (await codexSessionIdForFile(filePath)) ?? SESSION_FILE_RE.exec(filePath)?.[1]
      : SESSION_FILE_RE.exec(filePath)?.[1];
    if (id) agent.sessionId = id.toLowerCase();
    paths.set(agent.name, filePath);
  }
  return paths;
}
