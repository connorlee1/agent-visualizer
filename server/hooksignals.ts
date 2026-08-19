/**
 * Semantic approval signals pushed by the claude CLI itself.
 *
 * Dashboard-launched claude agents run with per-session hook settings (see
 * buildAgentCommand) that POST every hook event here: PermissionRequest marks
 * the session as awaiting approval the instant the dialog opens, and
 * PreToolUse / PostToolUse / Stop / UserPromptSubmit clear it. This needs no
 * pane text at all, so it works even when the pane is too small to draw the
 * dialog (the pane-text regex stays as fallback for codex and for agents
 * launched outside the dashboard).
 *
 * In-memory only: after a server restart the regex fallback covers until the
 * next event arrives. The TTL keeps a lost clear event from wedging a session.
 */
const pendingSince = new Map<string, number>(); // sessionId (lowercase) → ms

const PENDING_TTL_MS = 30 * 60_000;

export function noteClaudeHookEvent(sessionId: string, event: string): void {
  const id = sessionId.toLowerCase();
  if (event === 'PermissionRequest') pendingSince.set(id, Date.now());
  else pendingSince.delete(id);
}

export function approvalPending(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const id = sessionId.toLowerCase();
  const since = pendingSince.get(id);
  if (since == null) return false;
  if (Date.now() - since > PENDING_TTL_MS) {
    pendingSince.delete(id);
    return false;
  }
  return true;
}
