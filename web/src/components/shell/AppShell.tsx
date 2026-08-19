import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import type { LaunchAgentRequest } from '@shared/types';
import { useAgents, useClosedAgents, useKillAgent, useServerEvents } from '../../queries';
import { useResume } from '../../lib/useResume';
import { nudgeTheme } from '../../lib/themes';
import { Sidebar } from './Sidebar';
import { LaunchAgentModal } from '../agents/LaunchAgentModal';
import { ConfirmDialog } from '../ui/ConfirmButton';

const KILL_COMBO = /Mac|iP/.test(navigator.platform) ? '⌘⌥⌫' : 'Ctrl+Alt+Backspace';

/** Agent shown by the pane that currently holds keyboard focus, if any. */
function focusedPaneAgent(): string | undefined {
  const panes = [...document.querySelectorAll<HTMLElement>('[data-pane][data-agent]')];
  return panes.find((p) => p.contains(document.activeElement))?.dataset.agent;
}

/** Agent whose full page is open, if the route is /agents/:name. */
const routeAgent = (): string | undefined =>
  window.location.pathname.match(/^\/agents\/([^/]+)$/)?.[1];

type LaunchPrefill = Partial<Pick<LaunchAgentRequest, 'provider' | 'cwd'>>;

const LaunchContext = createContext<(prefill?: LaunchPrefill) => void>(() => {});
export const useOpenLaunch = () => useContext(LaunchContext);

export function AppShell() {
  useServerEvents();
  const { agents } = useAgents();
  const { data: closed } = useClosedAgents();
  const { resume } = useResume();
  const navigate = useNavigate();
  const [launch, setLaunch] = useState<{ open: boolean; prefill?: LaunchPrefill }>({ open: false });
  const openLaunch = useCallback((prefill?: LaunchPrefill) => setLaunch({ open: true, prefill }), []);

  const approvalsNeeded = agents.filter((a) => a.status === 'needs-approval').length;
  useEffect(() => {
    document.title = approvalsNeeded > 0 ? `(${approvalsNeeded}) agents` : 'agents';
  }, [approvalsNeeded]);

  useEffect(() => {
    const isMac = /Mac|iP/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      // ⌘K (Ctrl+K elsewhere) opens the launcher from anywhere — including a
      // wall terminal, where plain keys are relayed to the agent
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openLaunch();
        return;
      }
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
      if (e.key === 'g') {
        navigate('/grid');
      } else if (e.key === 'c') {
        // next color theme; if auto-cycle is on, this also resets its clock
        nudgeTheme();
      } else if (e.key === 'u') {
        // reopen the most recently closed agent, like a browser's ⌘⇧T
        const last = closed?.find((c) => c.provider && c.sessionId);
        if (last) {
          e.preventDefault();
          void resume(last.provider!, last.sessionId!);
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const agent = agents[Number(e.key) - 1];
        if (agent) navigate(`/agents/${agent.name}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agents, closed, navigate, openLaunch, resume]);

  // Pane chords, capture phase so they beat a focused xterm (which would
  // otherwise relay the keys to the agent's pty) and browser defaults.
  // ⌥Tab / ⌥⇧Tab cycles focus across visible panes in visual order — the
  // next rung under ⌘Tab (apps) and ⌃Tab (browser tabs); on Windows/Linux
  // the OS app switcher owns Alt+Tab, so that chord never reaches us there.
  // ⌥S sleeps (snoozes) the focused pane, ⌥F toggles it fullscreen (⌥Tab
  // also drops the zoom, tmux-style; a zoomed pane unmounting takes the
  // zoom with it) — primary pane when none is focused. ⌥C cycles the theme
  // from anywhere. e.code, since macOS turns ⌥S/⌥F/⌥C into "ß"/"ƒ"/"ç"
  useEffect(() => {
    // FLIP zoom animation: the pane grows from its slot into the viewport,
    // and shrinks back onto it on exit. Pure sugar — to revert to instant
    // snaps, delete clearFx/runFx/zoomIn, call setAttribute('data-zoom', '')
    // where zoomIn() is called, and keep only removeAttribute in unzoom.
    let fxTimer: number | undefined;
    const clearFx = (el: HTMLElement) => {
      el.style.transform = el.style.transition = el.style.transformOrigin = '';
      el.style.position = el.style.zIndex = '';
    };
    const runFx = (el: HTMLElement, from: string) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        clearFx(el);
        return;
      }
      el.style.transformOrigin = '0 0';
      el.style.transform = from;
      void el.offsetWidth; // flush, so the start state paints untransitioned
      el.style.transition = 'transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = '';
      window.clearTimeout(fxTimer);
      fxTimer = window.setTimeout(() => clearFx(el), 220);
    };
    const zoomIn = (pane: HTMLElement) => {
      const rect = pane.getBoundingClientRect();
      pane.setAttribute('data-zoom', '');
      runFx(
        pane,
        `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / window.innerWidth}, ${
          rect.height / window.innerHeight
        })`,
      );
    };
    const unzoom = () => {
      document.querySelectorAll<HTMLElement>('[data-zoom]').forEach((el) => {
        el.removeAttribute('data-zoom');
        clearFx(el);
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        // back in normal flow, the pane must paint above its siblings while
        // it shrinks from the viewport down onto its slot
        el.style.position = 'relative';
        el.style.zIndex = '80';
        runFx(
          el,
          `translate(${-rect.left}px, ${-rect.top}px) scale(${window.innerWidth / rect.width}, ${
            window.innerHeight / rect.height
          })`,
        );
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const panes = [...document.querySelectorAll<HTMLElement>('[data-pane]')];
      const focused = panes.find((p) => p.contains(document.activeElement));
      if (e.key === 'Tab') {
        if (!panes.length) return;
        e.preventDefault();
        e.stopPropagation();
        unzoom();
        const dir = e.shiftKey ? -1 : 1;
        const cur = focused ? panes.indexOf(focused) : -1;
        const next =
          cur < 0 ? (dir === 1 ? 0 : panes.length - 1) : (cur + dir + panes.length) % panes.length;
        (panes[next].querySelector('textarea') ?? panes[next]).focus({ preventScroll: true });
      } else if (e.code === 'KeyS' && !e.shiftKey) {
        // a focused pane without a snooze control (transcript) stays a no-op
        // rather than silently sleeping some other pane
        const pane = focused ?? panes.find((p) => p.querySelector('[data-snooze]'));
        const snooze = pane?.querySelector<HTMLElement>('[data-snooze]');
        if (!snooze) return;
        e.preventDefault();
        e.stopPropagation();
        snooze.click();
      } else if (e.code === 'KeyF' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const zoomed = document.querySelector('[data-zoom]');
        const pane = focused ?? panes[0];
        if (zoomed) unzoom();
        else if (pane) zoomIn(pane);
      } else if (e.code === 'KeyR' && !e.shiftKey) {
        // ⌥R expands/collapses the focused pane's recap strip (ChatPane
        // renders it only when an idle summary exists — no strip, no-op)
        const pane = focused ?? panes[0];
        const recap = pane?.querySelector<HTMLElement>('[data-recap-toggle]');
        if (!recap) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) recap.click();
      } else if (e.code === 'KeyC' && !e.shiftKey) {
        // ⌥C: bare `c` cycles the theme too, but only outside text inputs —
        // and since click-to-focus, a composer or terminal usually has focus
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) nudgeTheme();
      } else if (e.key === 'ArrowDown' && !e.shiftKey) {
        // ⌥↓ jumps the focused pane to the latest output: transcript scroll
        // (which also re-engages live following) or xterm scrollback
        const pane = focused ?? panes[0];
        const scroller = pane?.querySelector<HTMLElement>('[data-transcript-scroll], .xterm-viewport');
        if (!scroller) return;
        e.preventDefault();
        e.stopPropagation();
        scroller.scrollTop = scroller.scrollHeight;
      } else if (e.code === 'KeyT' && !e.shiftKey) {
        // ⌥T flips the focused pane chat ↔ terminal by clicking its own
        // control: a side panel's in-place flip, or the primary/terminal
        // pane's split toggle. Panes with neither (transcripts) no-op.
        const pane = focused ?? panes[0];
        const flip = pane?.querySelector<HTMLElement>('[data-flip-view], [data-term-toggle]');
        if (!flip) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        flip.click();
        // ChatPane doesn't autofocus on mount the way XtermPane does — put
        // focus back in the flipped pane (or, if the flip closed this pane,
        // whichever pane remains)
        setTimeout(() => {
          const target = pane && document.contains(pane) ? pane : document.querySelector('[data-pane]');
          target?.querySelector('textarea')?.focus({ preventScroll: true });
        }, 60);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unzoom();
    };
  }, []);

  // ⌘⌥⌫ (Ctrl+Alt+Backspace elsewhere) kills an agent from ANY page: the
  // focused pane's agent (wall tile, side panel) or the open agent page's.
  // First press opens the confirm dialog, a second press confirms — the
  // dialog popping up is the safety step. Capture phase beats a focused xterm.
  const [killDialog, setKillDialog] = useState<string | null>(null);
  const [killHint, setKillHint] = useState<string | null>(null);
  const killNow = useKillAgent();
  const doKill = useCallback((name: string) => {
    void killNow(name);
    // leave the dead agent's page right away — the optimistic removal has
    // already blanked it
    if (routeAgent() === name) navigate('/');
  }, [killNow, navigate]);
  useEffect(() => {
    const isMac = /Mac|iP/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || !e.altKey || e.shiftKey || e.repeat || e.code !== 'Backspace') return;
      e.preventDefault();
      e.stopPropagation();
      if (killDialog) {
        setKillDialog(null);
        doKill(killDialog);
        return;
      }
      const target = focusedPaneAgent() ?? routeAgent();
      if (target && agents.some((a) => a.name === target)) {
        setKillDialog(target);
      } else {
        setKillHint(`click an agent pane first — then ${KILL_COMBO} kills it`);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [killDialog, agents, doKill]);
  useEffect(() => {
    if (!killHint) return;
    const t = setTimeout(() => setKillHint(null), 2500);
    return () => clearTimeout(t);
  }, [killHint]);

  return (
    <LaunchContext.Provider value={openLaunch}>
      <div className="flex h-full">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {killDialog && (
        <ConfirmDialog
          open
          onClose={() => setKillDialog(null)}
          onConfirm={() => {
            setKillDialog(null);
            doKill(killDialog);
          }}
          question="Really kill this agent?"
          description={killDialog}
          hint={`${KILL_COMBO} again kills · esc cancels`}
          actionLabel="Kill"
        />
      )}
      {killHint && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-edge bg-surface px-4 py-2 text-[13px] text-mut shadow-2xl">
          {killHint}
        </div>
      )}
      <LaunchAgentModal
        open={launch.open}
        prefill={launch.prefill}
        onClose={() => setLaunch({ open: false })}
      />
    </LaunchContext.Provider>
  );
}
