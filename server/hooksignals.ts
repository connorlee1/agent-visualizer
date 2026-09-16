import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOOK_SIGNALS_FILE } from './config';

/**
 * Semantic input-needed signals pushed by the CLIs themselves, persisted so
 * the constant server restarts don't degrade detection back to pane-regex.
 *
 * claude — dashboard-launched agents run with per-session hook settings (see
 * buildAgentCommand) that POST every hook event here. Two things set the
 * pending flag:
 *  - PermissionRequest: a permission dialog is opening.
 *  - PreToolUse of AskUserQuestion: showing the question dialog IS that
 *    tool's execution, so this fires exactly when it opens.
 * Any other PreToolUse, plus PostToolUse / Stop / UserPromptSubmit, clears.
 *
 * codex — has NO approval hook (notify fires only agent-turn-complete;
 * verified live on 0.147), so codex events only mark the session as seen and
 * give an instant turn-complete push. Codex approvals stay on the chrome
 * regex — which is why routes.ts must stamp hookMonitored for CLAUDE ONLY.
 *
 * Sessions with hook traffic are "monitored": the client trusts the pending
 * flag EXCLUSIVELY for them and skips pane-text matching — conversational
 * text like "do you want to…" produced constant regex false positives.
 */
const pendingSince = new Map<string, number>(); // sessionId (lowercase) → ms
const seenEvent = new Map<string, number>(); // sessionId (lowercase) → last event ms

const PENDING_TTL_MS = 30 * 60_000;
// forget sessions with no hook traffic for a week — keeps the store bounded
const SEEN_TTL_MS = 7 * 24 * 60 * 60_000;

// The ask itself flushes the assistant tool_use record to the JSONL within
// the same second the PermissionRequest hook fires (verified live), so only
// writes clearly LATER than the ask mean "answered". Human answers arrive
// seconds later; a faster deny is caught by the turnState gate (denials
// write turn_duration) or, worst case, the TTL.
const ASK_FLUSH_GRACE_MS = 3_000;

// ---- persistence ----------------------------------------------------------

try {
  const raw = JSON.parse(readFileSync(HOOK_SIGNALS_FILE, 'utf8')) as {
    pending?: Record<string, number>;
    seen?: Record<string, number>;
  };
  const now = Date.now();
  for (const [id, ms] of Object.entries(raw.pending ?? {})) {
    if (now - ms < PENDING_TTL_MS) pendingSince.set(id, ms);
  }
  for (const [id, ms] of Object.entries(raw.seen ?? {})) {
    if (now - ms < SEEN_TTL_MS) seenEvent.set(id, ms);
  }
} catch { /* first run or unreadable — start empty */ }

let writeQueued = false;
function persist(): void {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    const data = {
      pending: Object.fromEntries(pendingSince),
      seen: Object.fromEntries(seenEvent),
    };
    void fs
      .mkdir(path.dirname(HOOK_SIGNALS_FILE), { recursive: true })
      .then(() => fs.writeFile(HOOK_SIGNALS_FILE, JSON.stringify(data)))
      .catch(() => { /* best effort — in-memory state still works */ });
  }, 500).unref();
}

// ---- events ---------------------------------------------------------------

export function noteClaudeHookEvent(sessionId: string, event: string, toolName?: string): void {
  const id = sessionId.toLowerCase();
  seenEvent.set(id, Date.now());
  const opensDialog =
    event === 'PermissionRequest' ||
    (event === 'PreToolUse' && toolName === 'AskUserQuestion');
  if (opensDialog) pendingSince.set(id, Date.now());
  else pendingSince.delete(id);
  persist();
}

/** codex notify: turn-complete only — records liveness, never a dialog. */
export function noteCodexEvent(threadId: string): void {
  seenEvent.set(threadId.toLowerCase(), Date.now());
  persist();
}

/** This session's CLI is pushing hook events — its signal is authoritative. */
export function hookMonitored(sessionId: string | undefined): boolean {
  return !!sessionId && seenEvent.has(sessionId.toLowerCase());
}

/**
 * Is a dialog still pending? `lastWriteMs` is the transcript's last write:
 * claude writes nothing while a dialog is up (past the ask-time flush), so a
 * later write means it was answered — including a DENIAL, which runs no tool
 * and fires no clearing hook (it just records "[Request interrupted]").
 */
export function approvalPending(sessionId: string | undefined, lastWriteMs?: number): boolean {
  if (!sessionId) return false;
  const id = sessionId.toLowerCase();
  const since = pendingSince.get(id);
  if (since == null) return false;
  const answered = lastWriteMs != null && lastWriteMs > since + ASK_FLUSH_GRACE_MS;
  if (answered || Date.now() - since > PENDING_TTL_MS) {
    pendingSince.delete(id);
    persist();
    return false;
  }
  return true;
}

// Kimi identifies approvals by tool call. Several subagents can ask at once;
// one answer must not clear another pending dialog. Turn status stays on wire.
const kimiSignals = new Map<string, { pending: Set<string>; at: number }>();
export function noteKimiHookEvent(id: string, event: string, toolId?: string): void {
  const signal = kimiSignals.get(id) ?? { pending: new Set<string>(), at: Date.now() };
  signal.at = Date.now();
  if (event === 'PermissionRequest') signal.pending.add(toolId ?? 'unknown');
  else if (event === 'PermissionResult') signal.pending.delete(toolId ?? 'unknown');
  else if (event === 'SessionEnd' || event === 'SessionStart') signal.pending.clear();
  kimiSignals.set(id, signal);
  if (kimiSignals.size > 1000) kimiSignals.delete(kimiSignals.keys().next().value!);
}
export function kimiHookSignal(id: string | undefined) {
  if (!id) return undefined;
  const signal = kimiSignals.get(id);
  return signal && Date.now() - signal.at < 24 * 60 * 60_000 ? signal : undefined;
}
