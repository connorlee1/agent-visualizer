export type Provider = 'claude' | 'codex';

export type AgentStatus = 'working' | 'needs-approval' | 'waiting' | 'exited';

/** The built-in machine id for the dashboard's own host. */
export const LOCAL_HOST = 'local';

export type HostStatus = 'connecting' | 'connected' | 'down';

/** A remote machine running its own visualizer server, reached via ssh tunnel. */
export interface HostInfo {
  id: string;
  name: string;
  /** ssh command as pasted ("ssh root@1.2.3.4 -p 22023 -i ~/.ssh/id_ed25519"). */
  ssh?: string;
  /** Direct base URL instead of a tunnel (tailscale / testing). */
  url?: string;
  /** Port the remote visualizer server listens on (default 5175). */
  remotePort?: number;
  status: HostStatus;
  /** Last tunnel/connection error, for the machines UI. */
  lastError?: string;
}

export interface AddHostRequest {
  name: string;
  ssh?: string;
  url?: string;
  remotePort?: number;
}

/** One running tmux session, managed (agent-*) or not. */
export interface TmuxAgent {
  name: string;
  /** Machine this agent runs on ('local' or a host id); stamped by the aggregator. */
  host?: string;
  managed: boolean;
  provider?: Provider;
  cwd?: string;
  /** Conversation this agent resumed, if any. */
  resumedFrom?: string;
  model?: string;
  /** Provider session id when known (claude: always for managed launches via --session-id). */
  sessionId?: string;
  /** User-chosen display name (stored as @agent_title on the tmux session). */
  title?: string;
  createdAt: string;
  attachedClients: number;
  currentCommand: string;
  /** false once the pane's foreground process is back to a shell. */
  agentRunning: boolean;
  /** Root PID of the pane's process tree (server-side session resolution). */
  panePid?: number;
  /**
   * Semantic turn state read from the transcript's own lifecycle markers
   * (claude: turn_duration records; codex: task_started/task_complete).
   */
  turnState?: 'working' | 'idle';
  /** Last write to the live transcript file (ms since epoch). */
  lastWriteMs?: number;
  /** Last prompt the user typed, from the transcript tail (idle-card recap). */
  lastPrompt?: string;
  /** The agent's latest reply text, from the transcript tail (idle-card recap). */
  lastAgentMessage?: string;
  /** LLM-generated 1-2 sentence recap of what this agent was doing (idle cards). */
  idleSummary?: string;
  /**
   * Semantic needs-approval signal pushed by the CLI's own hooks (claude
   * agents launched by the dashboard). Pane-text regex is the fallback.
   */
  approvalPending?: boolean;
  /** ANSI snapshot of the visible pane (for previews + status heuristics). */
  preview: string;
  paneWidth: number;
  paneHeight: number;
}

/** A managed agent whose tmux session was killed or ended — kept so it can be resumed. */
export interface ClosedAgent {
  id: string;
  /** Machine it ran on ('local' or a host id); stamped by the aggregator. */
  host?: string;
  /** tmux session name it had while alive. */
  name: string;
  provider?: Provider;
  cwd?: string;
  title?: string;
  model?: string;
  sessionId?: string;
  resumedFrom?: string;
  createdAt: string;
  closedAt: string;
  /** Title of the linked conversation, joined at request time — not persisted. */
  conversationTitle?: string;
}

export interface SessionSummary {
  provider: Provider;
  id: string;
  /** Absolute project cwd, read from inside the file (authoritative). */
  projectPath: string;
  title: string;
  /** True when title fell back to the first user prompt (no real title). */
  titleIsFallback: boolean;
  createdAt: string;
  lastActivityAt: string;
  /** Only known after a full transcript parse. */
  messageCount?: number;
  model?: string;
  /** Reasoning effort the session is set to (e.g. "xhigh"). */
  effort?: string;
  gitBranch?: string;
  /** Custom agent name remembered for this conversation (agent-names store). */
  agentName?: string;
  filePath: string;
  fileSizeBytes: number;
}

export interface Project {
  /** base64url of projectPath — safe for URLs. */
  id: string;
  path: string;
  name: string;
  providers: Provider[];
  sessionCount: number;
  lastActivityAt: string;
  /** Sessions per week, oldest → newest, last 12 weeks. */
  weeklyActivity: number[];
}

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; toolId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolId?: string; text: string; isError?: boolean };

export interface Message {
  id: string;
  parentId?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: string;
  content: ContentBlock[];
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  /** Number of sibling branches hidden at this point (claude retries/edits). */
  hiddenSiblings?: number;
}

export interface TranscriptResponse {
  session: SessionSummary;
  messages: Message[];
  /** Total messages on the main path (for "show earlier" paging). */
  total: number;
  /** Index into the full path of messages[0]. */
  offset: number;
}

export interface LaunchAgentRequest {
  provider: Provider;
  cwd?: string;
  /** Custom display name to stamp on the agent at launch. */
  title?: string;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
  fork?: boolean;
}

export interface LaunchAgentResponse {
  tmuxName: string;
}

/** Text control frames on the terminal WebSocket (binary frames are raw bytes). */
export type TermClientControl = { type: 'resize'; cols: number; rows: number };
export type TermServerControl = { type: 'exit' };
