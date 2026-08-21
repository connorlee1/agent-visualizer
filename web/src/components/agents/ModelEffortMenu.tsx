import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { SessionSummary } from '@shared/types';
import type { AgentWithStatus } from '../../queries';
import { driveModelPicker, sendAgentInput } from '../../lib/api';
import { refOf } from '../../lib/agentRef';
import { stripAnsi } from '../../lib/status';

const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// what codex's /model picker offers (it has no /effort and /model takes no
// argument, so these clicks drive the picker server-side — see codexpicker.ts)
const CODEX_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const MENU_WIDTH = 236;

/**
 * Codex's footer status line — "gpt-5.6-sol ultra · ~/dir · Main [default]" —
 * is the live truth for model/effort. The transcript only records them when a
 * turn STARTS, so it shows stale values at session start and never reflects a
 * picker change until the next message; the pane preview updates every poll.
 */
function paneModelEffort(preview: string | undefined): { model: string; effort: string } | null {
  if (!preview) return null;
  const lines = stripAnsi(preview).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*([A-Za-z0-9][\w.:-]*)\s+(minimal|low|medium|high|xhigh|max|ultra)\s+·/.exec(lines[i]);
    if (m) return { model: m[1], effort: m[2] };
  }
  return null;
}

/**
 * The model/effort text in an agent's pane header, made clickable: a dropdown
 * swaps either one by running `/model <x>` / `/effort <x>` in the agent's
 * tmux pane (codex's /model takes no argument, so that column opens its
 * picker in the terminal instead). The menu renders through a portal — the
 * header title truncates, which would clip an in-place dropdown.
 */
export function ModelEffortMenu({ agent, summary, prefix, className }: {
  agent: AgentWithStatus;
  summary: SessionSummary | null;
  /** Plain text rendered before the clickable value (e.g. " · "). */
  prefix?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // optimistic: the command landed in the pane, but the transcript won't
  // record the new setting until the next message is written
  const [pending, setPending] = useState<{ model?: string; effort?: string }>({});
  // a picker drive takes a few seconds; errors must be visible, not console-only
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const paneLive = agent.provider === 'codex' ? paneModelEffort(agent.preview) : null;
  const confirmedModel = paneLive?.model ?? summary?.model ?? agent.model;
  const confirmedEffort = paneLive?.effort ?? summary?.effort;

  useEffect(() => {
    setPending((p) => {
      const model = p.model && confirmedModel?.includes(p.model) ? undefined : p.model;
      const effort = p.effort === confirmedEffort ? undefined : p.effort;
      return model === p.model && effort === p.effort ? p : { model, effort };
    });
  }, [confirmedModel, confirmedEffort]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  const model = pending.model ?? confirmedModel;
  const effort = pending.effort ?? confirmedEffort;
  if (!model && !effort) return null;

  // needs-approval: text would land in the dialog, not the composer.
  // codex + working: a typed /model would be queued as a chat message.
  const blocked =
    agent.status === 'needs-approval' ||
    agent.status === 'exited' ||
    (agent.provider === 'codex' && agent.status === 'working');

  const revert = (set: { model: string } | { effort: string }) =>
    setPending((p) => ({
      ...p,
      ...('model' in set ? { model: undefined } : { effort: undefined }),
    }));

  const run = (command: string, set?: { model: string } | { effort: string }) => {
    setOpen(false);
    setError(null);
    if (set) setPending((p) => ({ ...p, ...set }));
    void sendAgentInput(refOf(agent), { text: command }).catch((err) => {
      if (set) revert(set);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const runPicker = (req: { model?: string; effort?: string }, set: { model: string } | { effort: string }) => {
    setOpen(false);
    setError(null);
    setBusy(true);
    setPending((p) => ({ ...p, ...set }));
    void driveModelPicker(refOf(agent), req)
      .catch((err) => {
        revert(set);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  const toggle = () => {
    if (open) return setOpen(false);
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)),
    });
    setOpen(true);
  };

  const efforts = agent.provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;

  const row = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      disabled={blocked}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-1 px-2.5 py-1 text-left font-mono text-[11px] hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent ${
        active ? 'text-ink' : 'text-mut'
      }`}
    >
      {label}
      {active && <Check size={10} className="shrink-0 text-claude" />}
    </button>
  );

  return (
    <span className={className}>
      {prefix}
      <button
        ref={btnRef}
        onClick={toggle}
        title={error ? `change failed: ${error}` : busy ? 'switching…' : 'change model / effort'}
        className={`underline-offset-2 hover:underline hover:decoration-dotted ${
          error ? 'text-red-400' : busy ? 'animate-pulse text-mut' : 'hover:text-mut'
        }`}
      >
        {model ? model.replace(/^claude-/, '') : 'model?'}
        {effort ? ` ${effort}` : ''}
        {error ? ' ✕' : ''}
      </button>
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 rounded-md border border-edge bg-surface py-1 text-left shadow-2xl"
              style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
            >
              <div className="flex">
                <div className="min-w-0 flex-1 border-r border-edge">
                  <div className="px-2.5 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-widest text-faint">
                    model
                  </div>
                  {agent.provider === 'codex'
                    ? CODEX_MODELS.map((m) =>
                        row(m, model === m, () =>
                          runPicker(
                            // keep the session's effort across the model swap —
                            // the picker's effort step defaults to the NEW
                            // model's default, not what the session runs at
                            { model: m, effort: effort && CODEX_EFFORTS.includes(effort) ? effort : undefined },
                            { model: m },
                          ),
                        ),
                      )
                    : CLAUDE_MODELS.map((m) =>
                        row(m, !!model?.includes(m), () => run(`/model ${m}`, { model: m })),
                      )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="px-2.5 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-widest text-faint">
                    effort
                  </div>
                  {efforts.map((e) =>
                    row(e, effort === e, () =>
                      agent.provider === 'codex'
                        ? runPicker({ effort: e }, { effort: e })
                        : run(`/effort ${e}`, { effort: e }),
                    ),
                  )}
                </div>
              </div>
              <div className="mx-2.5 mt-1 border-t border-edge pt-1 text-[10px] leading-snug text-faint">
                {agent.status === 'needs-approval'
                  ? 'answer the approval dialog first'
                  : agent.status === 'exited'
                    ? 'the agent has exited'
                    : blocked
                      ? 'wait for the turn to finish'
                      : agent.provider === 'codex'
                        ? 'drives the /model picker in the agent’s terminal'
                        : 'runs /model · /effort in the agent'}
              </div>
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}
