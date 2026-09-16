import os from 'node:os';
import path from 'node:path';

/** PORT override exists so a second instance can run beside the main one (tests, remotes). */
export const SERVER_PORT = Number(process.env.PORT) || 5175;
/** Resolved from PATH; set TMUX_BIN if your tmux lives somewhere PATH doesn't cover. */
export const TMUX_BIN = process.env.TMUX_BIN || 'tmux';

export const HOME = os.homedir();
/** Optional isolated dashboard state directory (useful for integration tests). */
const DATA_DIR = process.env.AGENT_VISUALIZER_DATA_DIR || path.join(HOME, '.agent-visualizer');
export const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
export const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');
/** Node Kimi Code only; the legacy Python CLI stores a different format in ~/.kimi. */
export const KIMI_CODE_HOME = path.resolve(process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code'));
export const KIMI_SESSIONS_DIR = path.join(KIMI_CODE_HOME, 'sessions');
export const CLOSED_AGENTS_FILE = path.join(DATA_DIR, 'closed-agents.json');
export const AGENT_NAMES_FILE = path.join(DATA_DIR, 'agent-names.json');
export const LIVE_AGENTS_FILE = path.join(DATA_DIR, 'live-agents.json');
export const CLAUDE_HOOKS_FILE = path.join(DATA_DIR, 'claude-hooks.json');
export const CODEX_NOTIFY_SCRIPT = path.join(DATA_DIR, 'codex-notify.sh');
/** Persisted CLI hook-signal state (monitored sessions + open dialogs). */
export const HOOK_SIGNALS_FILE = path.join(DATA_DIR, 'hook-signals.json');
/** cwd for headless `claude -p` summarizer calls — its transcripts are filtered out of session listings. */
export const SUMMARIZER_CWD = path.join(DATA_DIR, 'summarizer');
/** Images dropped into a composer, one subdirectory per agent. */
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const IDLE_SUMMARIES_FILE = path.join(DATA_DIR, 'idle-summaries.json');
/** Remote machines registry (env override keeps tests off the real file). */
export const HOSTS_FILE = process.env.HOSTS_FILE || path.join(DATA_DIR, 'hosts.json');

/**
 * Per-boot identity, reported by /api/health. Lets the tunnel manager notice
 * that a "remote machine" is actually this very server (a self-referential
 * host would otherwise deadlock the merged listing against itself).
 */
export const INSTANCE_ID = crypto.randomUUID();
