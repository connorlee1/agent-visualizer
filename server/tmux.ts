import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_HOOKS_FILE, SERVER_PORT, TMUX_BIN } from './config';
import type { Provider, TmuxAgent } from '../shared/types';

const exec = promisify(execFile);

const SESSION_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'tmux', '-zsh', '-bash']);
// tmux octal-escapes control chars in format output, but tabs pass through
// untouched — and can't appear in session names, paths, or the other fields
const SEP = '\t';

export class TmuxError extends Error {}

async function tmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(TMUX_BIN, args);
    return stdout;
  } catch (err: any) {
    const stderr = String(err?.stderr ?? '');
    if (/no server running|error connecting/i.test(stderr)) throw new TmuxError('no-server');
    throw new TmuxError(stderr.trim() || String(err?.message ?? err));
  }
}

export async function isServerRunning(): Promise<boolean> {
  try {
    await tmux(['list-sessions']);
    return true;
  } catch (err) {
    return false;
  }
}

export function assertSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) throw new TmuxError(`invalid session name: ${name}`);
}

export async function capturePane(name: string, opts: { history?: boolean } = {}): Promise<string> {
  assertSessionName(name);
  const args = ['capture-pane', '-e', '-p', '-t', name];
  if (opts.history) args.push('-S', '-2000', '-E', '-1');
  return tmux(args);
}

/** Plain-text pane snapshot (no ANSI escapes) — for parsing TUI screens. */
export async function capturePanePlain(name: string): Promise<string> {
  assertSessionName(name);
  return tmux(['capture-pane', '-p', '-t', name]);
}

/** Type text literally into the pane — no paste bracketing, no Enter. Codex
    only recognizes a slash command typed this way, not pasted. */
export async function typeIntoSession(name: string, text: string): Promise<void> {
  assertSessionName(name);
  await tmux(['send-keys', '-t', name, '-l', text]);
}

export async function paneSize(name: string): Promise<{ width: number; height: number }> {
  assertSessionName(name);
  const out = await tmux(['display-message', '-p', '-t', name, '#{pane_width} #{pane_height}']);
  const [w, h] = out.trim().split(' ').map(Number);
  return { width: w || 0, height: h || 0 };
}

/** Force a window size (flips the window to manual sizing). */
export async function resizeWindow(name: string, cols: number, rows: number): Promise<void> {
  assertSessionName(name);
  await tmux(['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)]);
}

/** Drop the manual size override so attached clients (or defaults) rule again. */
export async function resetWindowSize(name: string): Promise<void> {
  assertSessionName(name);
  await tmux(['set-option', '-w', '-t', name, '-u', 'window-size']);
}

// 30 lines so a full approval dialog (question + wrapped options + hints)
// survives the trim; consumers each take their own shorter tail.
function trimPreview(raw: string, maxLines = 30): string {
  const lines = raw.replace(/\s+$/, '').split('\n');
  return lines.slice(-maxLines).join('\n');
}

export async function listAgents(opts: { previews?: boolean } = {}): Promise<TmuxAgent[]> {
  const fmt = [
    '#{session_name}', '#{session_created}', '#{session_attached}',
    '#{@agent_provider}', '#{@agent_cwd}', '#{@agent_resumed_from}',
    '#{@agent_model}', '#{@agent_session_id}', '#{@agent_title}',
  ].join(SEP);
  let sessionsOut = '';
  let panesOut = '';
  try {
    sessionsOut = await tmux(['list-sessions', '-F', fmt]);
    panesOut = await tmux(['list-panes', '-a', '-F', ['#{session_name}', '#{pane_current_command}', '#{pane_width}', '#{pane_height}', '#{pane_pid}'].join(SEP)]);
  } catch (err) {
    if (err instanceof TmuxError && err.message === 'no-server') return [];
    throw err;
  }

  const panes = new Map<string, { cmd: string; width: number; height: number; pid: number }>();
  for (const line of panesOut.split('\n')) {
    if (!line) continue;
    const [name, cmd, w, h, pid] = line.split(SEP);
    if (!panes.has(name)) {
      panes.set(name, { cmd, width: Number(w) || 0, height: Number(h) || 0, pid: Number(pid) || 0 });
    }
  }

  const agents: TmuxAgent[] = [];
  for (const line of sessionsOut.split('\n')) {
    if (!line) continue;
    const [name, created, attached, provider, cwd, resumedFrom, model, sessionId, title] = line.split(SEP);
    const pane = panes.get(name) ?? { cmd: '', width: 0, height: 0, pid: 0 };
    const managed = name.startsWith('agent-');
    agents.push({
      name,
      managed,
      provider: provider === 'claude' || provider === 'codex' ? provider : undefined,
      cwd: cwd || undefined,
      resumedFrom: resumedFrom || undefined,
      model: model || undefined,
      sessionId: sessionId || undefined,
      title: title || undefined,
      createdAt: new Date(Number(created) * 1000).toISOString(),
      attachedClients: Number(attached) || 0,
      currentCommand: pane.cmd,
      agentRunning: !!pane.cmd && !SHELLS.has(pane.cmd),
      panePid: pane.pid || undefined,
      preview: '',
      paneWidth: pane.width,
      paneHeight: pane.height,
    });
  }

  if (opts.previews) {
    await Promise.all(agents.map(async (a) => {
      try {
        a.preview = trimPreview(await capturePane(a.name));
      } catch { /* session may have died between list and capture */ }
    }));
  }
  agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return agents;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface CreateAgentOptions {
  provider: Provider;
  cwd: string;
  title?: string;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
  fork?: boolean;
}

// Per-session hook settings injected at launch (claude only): the CLI itself
// POSTs its lifecycle events to the server, giving a semantic needs-approval
// signal that works regardless of pane size (see server/hooksignals.ts).
// The settings live in a FILE because the launch command is typed into the
// pane's interactive shell, and macOS's TTY canonical input buffer silently
// truncates lines over 1024 bytes — inline JSON blew straight past that.
// `exit 0` is load-bearing — PermissionRequest is a BLOCKING hook and a
// nonzero exit while the server is down could deny the tool call.
async function ensureClaudeHooksFile(): Promise<void> {
  const post =
    `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- ` +
    `http://127.0.0.1:${SERVER_PORT}/api/hooks/claude >/dev/null 2>&1; exit 0`;
  const cmd = [{ type: 'command', command: post }];
  const json = JSON.stringify({
    hooks: {
      PermissionRequest: [{ matcher: '*', hooks: cmd }],
      PreToolUse: [{ matcher: '*', hooks: cmd }],
      PostToolUse: [{ matcher: '*', hooks: cmd }],
      Stop: [{ hooks: cmd }],
      UserPromptSubmit: [{ hooks: cmd }],
    },
  }, null, 2);
  const existing = await fs.readFile(CLAUDE_HOOKS_FILE, 'utf8').catch(() => null);
  if (existing !== json) {
    await fs.mkdir(path.dirname(CLAUDE_HOOKS_FILE), { recursive: true });
    await fs.writeFile(CLAUDE_HOOKS_FILE, json);
  }
}

function buildAgentCommand(opts: CreateAgentOptions): { command: string; sessionId?: string } {
  const { provider, model, permissionMode, initialPrompt, resumeSessionId, fork } = opts;
  if (model && !MODEL_RE.test(model)) throw new TmuxError('invalid model');
  if (permissionMode && !PERMISSION_MODES.has(permissionMode)) throw new TmuxError('invalid permission mode');
  if (resumeSessionId && !UUID_RE.test(resumeSessionId)) throw new TmuxError('invalid session id');

  const parts: string[] = [];
  let sessionId: string | undefined;
  if (provider === 'claude') {
    parts.push('claude');
    if (resumeSessionId) {
      parts.push('--resume', resumeSessionId);
      if (fork) parts.push('--fork-session');
      sessionId = fork ? undefined : resumeSessionId;
    } else {
      sessionId = randomUUID();
      parts.push('--session-id', sessionId);
    }
    if (model) parts.push('--model', model);
    if (permissionMode) parts.push('--permission-mode', permissionMode);
    parts.push('--settings', shq(CLAUDE_HOOKS_FILE));
    if (initialPrompt && !resumeSessionId) parts.push(shq(initialPrompt));
  } else {
    if (resumeSessionId) {
      parts.push('codex', fork ? 'fork' : 'resume', resumeSessionId);
      sessionId = fork ? undefined : resumeSessionId;
    } else {
      parts.push('codex');
      if (initialPrompt) parts.push(shq(initialPrompt));
    }
    if (model) parts.push('--model', model);
  }
  return { command: parts.join(' '), sessionId };
}

export async function createAgent(opts: CreateAgentOptions): Promise<{ name: string; sessionId?: string }> {
  const stat = await fs.stat(opts.cwd).catch(() => null);
  if (!stat?.isDirectory()) throw new TmuxError(`directory does not exist: ${opts.cwd}`);

  const { command, sessionId } = buildAgentCommand(opts);
  if (opts.provider === 'claude') await ensureClaudeHooksFile();
  const name = `agent-${opts.provider}-${randomBytes(3).toString('hex')}`;

  await tmux(['new-session', '-d', '-s', name, '-c', opts.cwd, '-x', '220', '-y', '50']);
  // last-active client dictates window size, regardless of .tmux.conf
  await tmux(['set-option', '-w', '-t', name, 'window-size', 'latest']);
  // the dashboard chrome shows session name/status — the tmux status bar is noise
  await tmux(['set-option', '-t', name, 'status', 'off']);
  const userOpts: Record<string, string | undefined> = {
    '@agent_provider': opts.provider,
    '@agent_cwd': opts.cwd,
    '@agent_resumed_from': opts.resumeSessionId,
    '@agent_model': opts.model,
    '@agent_session_id': sessionId,
    '@agent_title': opts.title ? cleanTitle(opts.title) : undefined,
  };
  for (const [key, value] of Object.entries(userOpts)) {
    if (value) await tmux(['set-option', '-t', name, key, value]);
  }
  await tmux(['send-keys', '-t', name, '-l', command]);
  await tmux(['send-keys', '-t', name, 'Enter']);
  return { name, sessionId };
}

export async function killSession(name: string): Promise<void> {
  assertSessionName(name);
  await tmux(['kill-session', '-t', name]);
}

// control chars would corrupt the TAB-separated list-sessions output
// eslint-disable-next-line no-control-regex
const cleanTitle = (title: string) => title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60);

/**
 * Set (or clear, with an empty string) the agent's user-chosen display name.
 * Returns the cleaned title actually stored ('' when cleared).
 */
export async function renameAgent(name: string, title: string): Promise<string> {
  assertSessionName(name);
  const clean = cleanTitle(title);
  if (clean) await tmux(['set-option', '-t', name, '@agent_title', clean]);
  else await tmux(['set-option', '-t', name, '-u', '@agent_title']);
  return clean;
}

/** Read a single session option (user options included); undefined when unset. */
export async function getSessionOption(name: string, option: string): Promise<string | undefined> {
  assertSessionName(name);
  const out = (await tmux(['show-options', '-t', name, '-qv', option])).trim();
  return out || undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Type a prompt into the agent and submit it. Multi-line goes via bracketed paste. */
export async function sendTextToSession(name: string, text: string): Promise<void> {
  assertSessionName(name);
  const clean = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!clean) return;
  if (clean.includes('\n')) {
    // bracketed paste so the TUI treats newlines as content, not submissions
    await tmux(['set-buffer', '-b', 'agentdash', '--', clean]);
    await tmux(['paste-buffer', '-p', '-d', '-b', 'agentdash', '-t', name]);
  } else {
    await tmux(['send-keys', '-t', name, '-l', clean]);
  }
  // TUIs (codex especially) treat a rapid char burst as a paste; an Enter
  // inside that burst gets swallowed as a newline instead of submitting.
  await sleep(300);
  await tmux(['send-keys', '-t', name, 'Enter']);
}

const KEY_ALLOWLIST = new Set([
  'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'Space',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n',
]);

/** Press a single key in the agent's pane (approval dialogs, menus). */
export async function sendKeyToSession(name: string, key: string): Promise<void> {
  assertSessionName(name);
  if (!KEY_ALLOWLIST.has(key)) throw new TmuxError(`key not allowed: ${key}`);
  await tmux(['send-keys', '-t', name, key]);
}
