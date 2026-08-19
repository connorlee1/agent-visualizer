import os from 'node:os';
import path from 'node:path';

export const SERVER_PORT = 5175;
export const TMUX_BIN = '/opt/homebrew/bin/tmux';

export const HOME = os.homedir();
export const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
export const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');
export const CLOSED_AGENTS_FILE = path.join(HOME, '.agent-visualizer', 'closed-agents.json');
export const AGENT_NAMES_FILE = path.join(HOME, '.agent-visualizer', 'agent-names.json');
export const LIVE_AGENTS_FILE = path.join(HOME, '.agent-visualizer', 'live-agents.json');
/** cwd for headless `claude -p` summarizer calls — its transcripts are filtered out of session listings. */
export const SUMMARIZER_CWD = path.join(HOME, '.agent-visualizer', 'summarizer');

