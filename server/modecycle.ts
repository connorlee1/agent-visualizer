import type { Provider } from '../shared/types';
import { capturePanePlain, paneSize, resetWindowSize, resizeWindow, sendKeyToSession } from './tmux';

/**
 * Switch an agent's permission/plan mode by pressing shift+tab (tmux BTab) —
 * the only in-session control either TUI offers — and verifying each press
 * against the pane, since neither CLI has a command for it.
 *
 * claude cycles manual → accept edits → plan → auto and prints the state in
 * its footer ("⏵⏵ auto mode on"); codex toggles plan on/off, shown as a
 * "Plan mode" suffix on its status line. The claude footer only renders when
 * the pane is tall enough (a 6-row grid pane hides it entirely), so the
 * window is temporarily grown, exactly like the codex model picker drive.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const CLAUDE_MODES = ['manual', 'acceptEdits', 'plan', 'auto'] as const;
export const CODEX_MODES = ['default', 'plan'] as const;

/** Footer "⏵⏵ accept edits on" / "⏸ plan mode on" → cycle value. */
function parseClaudeMode(pane: string): string | null {
  const lines = pane.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /[⏵⏸]+\s+(.+?)\s+on\b/.exec(lines[i]);
    if (!m) continue;
    const label = m[1].replace(/\s*mode$/, '').trim();
    if (label === 'accept edits') return 'acceptEdits';
    if (label === 'bypassing permissions' || label === 'bypass permissions') return 'bypassPermissions';
    return label; // auto, manual, plan — and anything new shows as-is
  }
  return null;
}

/** Status line "gpt-… · ~/dir … Plan mode" → plan; anything else → default. */
function parseCodexMode(pane: string): string {
  const tail = pane.split('\n').filter((l) => l.trim()).slice(-2).join(' ');
  return /Plan mode\s*$/.test(tail) ? 'plan' : 'default';
}

const inFlight = new Set<string>();

export async function cycleAgentMode(
  name: string,
  provider: Provider,
  target: string,
): Promise<{ mode: string }> {
  const valid: readonly string[] = provider === 'codex' ? CODEX_MODES : CLAUDE_MODES;
  if (!valid.includes(target)) {
    throw new Error(`unknown ${provider} mode "${target}" (valid: ${valid.join(', ')})`);
  }
  if (inFlight.has(name)) throw new Error('a mode change is already running for this agent');
  inFlight.add(name);
  const size = await paneSize(name);
  const grew = provider === 'claude' && size.height < 20;
  if (grew) await resizeWindow(name, Math.max(size.width, 100), 30);
  try {
    // press-until-match rather than assuming cycle order — launch modes like
    // bypassPermissions sit in the cycle at positions we haven't mapped
    let unreadable = 0;
    for (let i = 0; i < 8; i++) {
      const pane = await capturePanePlain(name);
      if (/shift\+tab to approve/.test(pane)) {
        throw new Error('the agent is waiting on an approval dialog');
      }
      const cur = provider === 'codex' ? parseCodexMode(pane) : parseClaudeMode(pane);
      if (cur === target) return { mode: cur };
      if (cur === null) {
        // footer may take a beat to render after the resize
        if (++unreadable >= 4) throw new Error("could not read the agent's current mode");
        await sleep(500);
        continue;
      }
      await sendKeyToSession(name, 'BTab');
      await sleep(450);
    }
    throw new Error('could not reach the requested mode');
  } finally {
    if (grew) await resetWindowSize(name).catch(() => {});
    inFlight.delete(name);
  }
}
