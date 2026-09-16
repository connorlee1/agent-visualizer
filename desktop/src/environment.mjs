import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export async function desktopEnvironment(source = process.env) {
  const env = { ...source };
  const shell = source.SHELL || '/bin/zsh';
  let shellPath = '';
  try {
    // Finder does not inherit the user's terminal PATH. Ask only for PATH;
    // never execute an agent CLI or initiate any authentication flow.
    const { stdout } = await execFileAsync(shell, ['-ilc', 'printf "\\n__AGENT_VISUALIZER_PATH__%s\\n" "$PATH"'], {
      env, cwd: os.homedir(), timeout: 4000, maxBuffer: 65536,
    });
    shellPath = stdout.split('\n').find((line) => line.startsWith('__AGENT_VISUALIZER_PATH__'))?.slice('__AGENT_VISUALIZER_PATH__'.length) || '';
  } catch { /* shell configuration may be slow or unavailable; use fallbacks */ }
  env.PATH = [...new Set([
    ...(shellPath || source.PATH || '').split(path.delimiter),
    path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ].filter((entry) => path.isAbsolute(entry)))].join(path.delimiter);
  return env;
}

export async function requireTmux(env) {
  const binary = env.TMUX_BIN || 'tmux';
  const candidates = path.isAbsolute(binary) ? [binary] : env.PATH.split(path.delimiter).map((dir) => path.join(dir, binary));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next directory */ }
  }
  throw new Error('tmux is required to start the desktop backend. Install tmux (for example, brew install tmux), or set TMUX_BIN to its absolute path.');
}
