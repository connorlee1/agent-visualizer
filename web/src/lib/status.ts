import type { AgentStatus, TmuxAgent } from '@shared/types';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

// FALLBACK ONLY — used for sessions without hook coverage (codex, and claude
// agents not launched by the dashboard). Hook-monitored claude agents get
// their input-needed state exclusively from agent.approvalPending; matching
// pane text for them fired on ordinary conversation ("do you want to…" is
// how agents end half their replies).
//
// These patterns are exact DIALOG CHROME captured from real dialogs — full
// bottom-anchored footer/headline lines the CLIs draw, never phrases that
// occur in prose. Wrapped prose can start a pane row at any word, so even
// line-anchoring doesn't make a conversational phrase safe.
// - claude permission dialog: "Do you want to proceed?" headline + the
//   "Esc to cancel · Tab to amend · ctrl+e to explain" footer
// - codex approval dialog: "Would you like to run the following command?"
//   headline + "Press enter to confirm or esc to cancel" footer; the trust
//   prompt ends "Press enter to continue"
const DIALOG_CHROME_RE =
  /^\s*do you want to proceed\?$|^\s*esc to cancel · tab to amend|^\s*would you like to (run|apply|make) the following|^\s*press enter to (confirm or esc to cancel|continue)$/im;

// Idle long enough that you've likely lost the thread — recap UIs (AgentCard,
// ChatPane banner) show the LLM idle summary past this point.
export const RECAP_IDLE_MS = 60_000;

// Fallback window for agents with no linked transcript at all.
const FALLBACK_WRITE_MS = 12_000;
// Liveness gate on an open turn: the CLI repaints its pane at least every
// few seconds while working (spinners/timers), and writes records as steps
// complete. If neither shows life, the open turn was interrupted/crashed.
const LIVENESS_WRITE_MS = 120_000;

/**
 * Classify what an agent needs from you.
 *
 * The primary signal is SEMANTIC: the server reads the transcript's own
 * turn-lifecycle markers (claude: turn_duration records; codex:
 * task_started/task_complete) into `agent.turnState` — no timing guesses.
 * `working` additionally requires signs of life (pane repaint or a recent
 * file write) so an interrupted turn can't stick. The pane snapshot text is
 * only pattern-matched for approval dialogs.
 */
// Foreground commands that plausibly ARE a coding agent — the gate for
// applying agent heuristics to unmanaged sessions. claude/codex run as
// themselves or under a JS runtime; anything else in an unmanaged pane
// (ssh, htop, vim, an installer) is just a program someone is using.
const AGENT_CMD_RE = /^(claude|codex|node|bun|deno)/;

export function deriveStatus(
  agent: TmuxAgent,
  opts: { changedRecently: boolean; lastWriteAt?: number },
): AgentStatus {
  // last-known snapshot from an unreachable machine — nothing here is live,
  // so no heuristic below may run (a frozen preview would pin the old state)
  if (agent.stale) return 'offline';
  if (!agent.agentRunning) return 'exited';
  // An unmanaged pane running a non-agent program gets NO agent heuristics:
  // an ssh window would otherwise flicker green "working" on every repaint,
  // and an installer's "Press enter to continue" would read as an approval
  // dialog and light the wall orange.
  if (!agent.managed && !agent.provider && !AGENT_CMD_RE.test(agent.currentCommand)) {
    return 'shell';
  }
  if (agent.approvalPending) return 'needs-approval';
  // hook-monitored sessions are decided ABOVE, exclusively — no pane text.
  // The chrome regex only covers sessions the hooks can't see (codex,
  // outside-launched claude), over the whole 30-line preview since a tall
  // dialog's headline can sit well above the bottom.
  if (!agent.hookMonitored) {
    const tail = stripAnsi(agent.preview).split('\n').slice(-30).join('\n');
    if (DIALOG_CHROME_RE.test(tail)) return 'needs-approval';
  }

  const lastWrite = agent.lastWriteMs ?? opts.lastWriteAt;
  if (agent.turnState === 'idle') return 'waiting';
  if (agent.turnState === 'working') {
    // the server already latches dead turns closed — trust it directly, so a
    // pane repaint (glancing/resizing) can never flash a dead turn green
    return 'working';
  }

  // no linked transcript — weak fallbacks only
  if (lastWrite != null) return Date.now() - lastWrite < FALLBACK_WRITE_MS ? 'working' : 'waiting';
  return opts.changedRecently ? 'working' : 'waiting';
}

export const STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'var(--color-ok)',
  'needs-approval': 'var(--color-alert)',
  waiting: 'var(--color-warn)',
  exited: 'var(--color-faint)',
  shell: 'var(--color-faint)',
  offline: 'var(--color-faint)',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  'needs-approval': 'needs approval',
  waiting: 'waiting for input',
  exited: 'agent exited',
  shell: 'shell session',
  offline: 'machine unreachable',
};

/** Readout glyphs for the console skin: `● WORKING`, `▲ APPROVAL`, … */
export const STATUS_GLYPH: Record<AgentStatus, string> = {
  working: '●',
  'needs-approval': '▲',
  waiting: '◌',
  exited: '■',
  shell: '·',
  offline: '⌁',
};

/** Short uppercase-ready label for readout chips (label text set via CSS). */
export const STATUS_SHORT: Record<AgentStatus, string> = {
  working: 'working',
  'needs-approval': 'approval',
  waiting: 'waiting',
  exited: 'exited',
  shell: 'shell',
  offline: 'offline',
};
