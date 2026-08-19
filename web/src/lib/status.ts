import type { AgentStatus, TmuxAgent } from '@shared/types';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

// Dialog-shaped text only — option cursors and explicit approval prompts.
// Loose words like "permission"/"approve" appear in normal output too.
// ❯ N. (any number): a tall dialog can be scrolled so the cursor sits on a
// later option, and the "1." line may not be drawn at all in a small pane.
const APPROVAL_RE = /do you (want to|approve)|❯\s*\d+\.|\(y\/n\)|allow this|waiting for (your )?approval|trust th(e|is)/i;

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
export function deriveStatus(
  agent: TmuxAgent,
  opts: { changedRecently: boolean; lastWriteAt?: number },
): AgentStatus {
  if (!agent.agentRunning) return 'exited';
  // the whole 30-line preview: a tall dialog's cursor line can sit further
  // up than the old 15-line window reached
  const tail = stripAnsi(agent.preview).split('\n').slice(-30).join('\n');
  if (APPROVAL_RE.test(tail)) return 'needs-approval';

  const lastWrite = agent.lastWriteMs ?? opts.lastWriteAt;
  if (agent.turnState === 'idle') return 'waiting';
  if (agent.turnState === 'working') {
    const alive =
      opts.changedRecently || (lastWrite != null && Date.now() - lastWrite < LIVENESS_WRITE_MS);
    return alive ? 'working' : 'waiting';
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
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  'needs-approval': 'needs approval',
  waiting: 'waiting for input',
  exited: 'agent exited',
};
