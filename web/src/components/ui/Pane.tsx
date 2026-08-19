import { useEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { dimmed } from '../../lib/dirColor';

/**
 * Focus the pane's input (chat composer or xterm's hidden textarea) on a
 * click anywhere in the pane, so focus doesn't require hitting the text box
 * itself. Skips clicks on interactive elements and drag-selections.
 */
function focusPaneInput(e: MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  if (target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  (e.currentTarget.querySelector('textarea') ?? e.currentTarget).focus({ preventScroll: true });
}

/**
 * Tiling-WM style pane: flat rectangle, 1px border, slim title bar, tight
 * uniform gaps. The focused pane (terminal or composer holding keyboard
 * focus) gets the accent border, Hyprland-style. Corners are rounded
 * per-section so header dropdowns can escape the body's overflow clip.
 */
export function Pane({ icon, title, titleAttr, agentName, alert = false, flash = false, remind = false, dim = false, tint, actions, children }: {
  icon?: ReactNode;
  title: ReactNode;
  titleAttr?: string;
  /** tmux name of the agent this pane shows — lets the global kill chord target the focused pane. */
  agentName?: string;
  /** Pulse the border (agent needs approval). */
  alert?: boolean;
  /** One-shot full-pane wash (agent finished working). */
  flash?: boolean;
  /** Aggressive strobe (sleeping pane's periodic reminder); outranks flash and lifts dim. */
  remind?: boolean;
  /** Asleep (done-flash muted): the whole pane dims; hovering or focusing it
      restores full brightness, as if awake. Safe only because nothing takes
      focus in a slept pane uninvited (XtermPane skips mount-focus when muted,
      SnoozeButton refuses focus on mousedown). */
  dim?: boolean;
  /** Group accent (e.g. per-directory): dimmed border, full strength on focus. */
  tint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const wantDim = dim && !alert && !remind;

  // Self-healing fade: on this many-terminal page the main thread can stall
  // long enough that the 300ms opacity transition is interrupted and never
  // re-runs, leaving a slept pane stuck fully bright (seen live, computed
  // opacity pinned at 1 with the dim class applied). Keep the fade, but
  // verify the settled state once a second and snap without animation after
  // two consecutive wrong readings (one wrong reading may just be mid-fade).
  const wrapRef = useRef<HTMLDivElement>(null);
  const everDimmed = useRef(false);
  if (wantDim) everDimmed.current = true;
  useEffect(() => {
    if (!everDimmed.current) return;
    const el = wrapRef.current;
    if (!el) return;
    let wrongOnce = false;
    const iv = window.setInterval(() => {
      const o = parseFloat(getComputedStyle(el).opacity);
      const expectDim = wantDim && !el.matches(':hover') && !el.matches(':focus-within');
      const wrong = expectDim ? o > 0.9 : o < 0.9;
      if (wrong && wrongOnce) {
        el.style.transition = 'none';
        void el.offsetWidth; // flush so the snap lands before re-enabling
        el.style.transition = '';
      }
      wrongOnce = wrong;
    }, 1000);
    return () => window.clearInterval(iv);
  }, [wantDim]);

  return (
    <div
      ref={wrapRef}
      className={`h-full min-h-0 p-[3px] transition-opacity duration-300 ${
        wantDim ? 'opacity-45 focus-within:opacity-100 hover:opacity-100' : ''
      }`}
    >
      <div
        data-pane
        data-agent={agentName}
        // focusable fallback so input-less panes (transcripts) can still take
        // focus — and the accent border — via click or ⌥Tab
        tabIndex={-1}
        onClick={focusPaneInput}
        style={
          tint && !alert
            ? ({
                '--tint': tint,
                '--tint-dim': dimmed(tint),
              } as CSSProperties)
            : undefined
        }
        className={`relative flex h-full min-h-0 flex-col rounded-[4px] border outline-none transition-colors duration-150 ${
          alert
            ? 'pulse-alert-border border-alert'
            : tint
              ? 'border-(--tint-dim) focus-within:border-(--tint)'
              : 'border-edge focus-within:border-claude/70'
        }`}
      >
        <div data-pane-header className="flex h-7 shrink-0 items-center gap-2 rounded-t-[3px] border-b border-edge bg-surface px-2.5">
          {icon}
          <span className="truncate font-mono text-[11px] text-mut" title={titleAttr}>
            {title}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-b-[3px] bg-bg">{children}</div>
        {remind ? (
          <div className="flash-remind-overlay z-30" />
        ) : (
          flash && <div className="flash-done-overlay z-30" />
        )}
      </div>
    </div>
  );
}
