import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { Columns2, SquareTerminal, X } from 'lucide-react';
import { useAgents, useKillAgent } from '../queries';
import { STATUS_COLOR, STATUS_GLYPH, STATUS_SHORT } from '../lib/status';
import { agentLabel, basename } from '../lib/format';
import { altLabel } from '../lib/keys';
import { useLinkedSession, useLinkedSummary } from '../lib/useLinkedSession';
import { isRemoteHost, refOf } from '../lib/agentRef';
import { useDoneFlash } from '../lib/useDoneFlash';
import { decodePanelRef, encodePanelRef, type PanelRef } from '../lib/panelRef';
import { AgentStatusDot } from '../components/agents/AgentStatusDot';
import { AgentMenu } from '../components/agents/AgentMenu';
import { ModelEffortMenu } from '../components/agents/ModelEffortMenu';
import { SnoozeButton } from '../components/agents/SnoozeButton';
import { WorkingTimer } from '../components/agents/WorkingTimer';
import { XtermPane } from '../components/terminal/XtermPane';
import { ChatPane } from '../components/chat/ChatPane';
import { ConfirmButton } from '../components/ui/ConfirmButton';
import { SplitPane } from '../components/ui/SplitPane';
import { Pane } from '../components/ui/Pane';
import { SidePanel } from '../components/panel/SidePanel';
import { PanelPicker } from '../components/panel/PanelPicker';

const MAX_PANELS = 3;

function loadPanels(): PanelRef[] {
  try {
    const raw = JSON.parse(localStorage.getItem('workspacePanels') ?? '[]') as string[];
    return raw.map(decodePanelRef).filter((p): p is PanelRef => !!p);
  } catch {
    return [];
  }
}

export function AgentPage() {
  // :tmuxName is an agent REF — "host:name" for remote machines, bare name locally
  const { tmuxName } = useParams<{ tmuxName: string }>();
  const navigate = useNavigate();
  const { agents, isLoading } = useAgents();
  const killNow = useKillAgent();
  const agent = agents.find((a) => refOf(a) === tmuxName);
  const agentRef = agent ? refOf(agent) : tmuxName!;
  const linked = useLinkedSession(agent);
  const summary = useLinkedSummary(agent);
  const doneFlash = useDoneFlash(agent ? agentRef : undefined);

  const [showTerminal, setShowTerminal] = useState(
    () => localStorage.getItem('terminalOpen') === '1',
  );
  const toggleTerminal = () => {
    setShowTerminal((v) => {
      localStorage.setItem('terminalOpen', v ? '0' : '1');
      return !v;
    });
  };

  const [panels, setPanelsState] = useState<PanelRef[]>(loadPanels);
  const [pickerOpen, setPickerOpen] = useState(false);
  const setPanels = (list: PanelRef[]) => {
    setPanelsState(list);
    localStorage.setItem('workspacePanels', JSON.stringify(list.map(encodePanelRef)));
  };
  const addPanel = (p: PanelRef) => {
    const key = encodePanelRef(p);
    if (panels.some((x) => encodePanelRef(x) === key)) return;
    setPanels([...panels, p].slice(0, MAX_PANELS));
  };
  const removePanel = (p: PanelRef) => {
    const key = encodePanelRef(p);
    setPanels(panels.filter((x) => encodePanelRef(x) !== key));
  };
  // a panel showing the agent already on the primary pane is meaningless
  const activePanels = panels.filter((p) => !(p.kind === 'term' && p.name === agentRef));

  // clicking the tab of a panel'd agent swaps it with the previous primary
  const prevAgentRef = useRef(agentRef);
  useEffect(() => {
    const prev = prevAgentRef.current;
    if (agentRef && prev && prev !== agentRef) {
      const idx = panels.findIndex((p) => p.kind === 'term' && p.name === agentRef);
      if (idx >= 0) {
        const next = [...panels];
        next[idx] = { kind: 'term', name: prev };
        setPanels(next);
      }
    }
    prevAgentRef.current = agentRef;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
      if (e.key === 't') toggleTerminal();
      if (e.key === 's') setPickerOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-mut">
        {isLoading ? 'loading…' : (
          <>
            <div>tmux session “{tmuxName}” is not running</div>
            <button onClick={() => navigate('/')} className="rounded-md border border-edge px-3 py-1 text-[12px] hover:text-ink">
              ← back home
            </button>
          </>
        )}
      </div>
    );
  }

  // any managed agent gets the chat surface — the transcript hydrates once
  // the conversation links (a fresh codex only writes its session file on
  // the first message, so `linked` starts out null)
  const hasChat = !!agent.provider;
  const terminalVisible = showTerminal || !hasChat;

  const frameActions = (
    <>
      <span
        className="mr-1 hidden font-mono text-[10px] font-semibold uppercase tracking-[0.14em] sm:inline"
        style={{ color: STATUS_COLOR[agent.status] }}
      >
        {STATUS_GLYPH[agent.status]} {STATUS_SHORT[agent.status]}
        {agent.status === 'working' && <WorkingTimer name={agentRef} />}
      </span>
      {hasChat && (
        <button
          data-term-toggle
          onClick={toggleTerminal}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${
            showTerminal ? 'border-faint text-ink' : 'border-edge text-mut hover:text-ink'
          }`}
          title={`toggle raw terminal (t / ${altLabel('T')})`}
        >
          <SquareTerminal size={11} /> Terminal
        </button>
      )}
      <div className="relative">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${
            activePanels.length ? 'border-faint text-ink' : 'border-edge text-mut hover:text-ink'
          }`}
          title="open another chat, agent, or conversation beside this (s)"
        >
          <Columns2 size={11} /> Split
          {activePanels.length > 0 && <span className="text-faint">{activePanels.length + 1}</span>}
        </button>
        <PanelPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={addPanel}
          excludeRefs={[
            encodePanelRef({ kind: 'term', name: agentRef }),
            ...panels.map(encodePanelRef),
          ]}
        />
      </div>
      <SnoozeButton name={agentRef} muted={doneFlash.muted} />
      <ConfirmButton
        label="Kill"
        confirmLabel="Really kill this agent?"
        description={agentRef}
        title={`kill this agent (or ${/Mac|iP/.test(navigator.platform) ? '⌘⌥⌫' : 'Ctrl+Alt+Backspace'} twice)`}
        onConfirm={() => {
          void killNow(agentRef);
          navigate('/');
        }}
      />
      <AgentMenu agent={agent} />
    </>
  );

  const title = (
    <>
      {agentLabel(agent, agents)}
      {isRemoteHost(agent.host) && (
        <span className="ml-2 rounded-sm border border-edge bg-surface2 px-1 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-mut">
          {agent.host}
        </span>
      )}
      {agent.provider && (
        <span className="ml-2 text-faint">
          {agent.provider}
          <ModelEffortMenu agent={agent} summary={summary} prefix=" · " />
        </span>
      )}
    </>
  );

  const primaryPane = (
    <Pane
      agentName={agentRef}
      icon={<AgentStatusDot status={agent.status} />}
      title={title}
      titleAttr={agent.cwd}
      alert={agent.status === 'needs-approval'}
      flash={doneFlash.flash}
      remind={doneFlash.remind}
      dim={doneFlash.muted}
      actions={frameActions}
    >
      {hasChat ? <ChatPane agent={agent} /> : <XtermPane key={agentRef} name={agentRef} />}
    </Pane>
  );

  // chain side panels: primary | panel0 | panel1 | …, equal-ish by default
  const withPanels = activePanels.reduce<ReactNode>(
    (acc, p, i) => (
      <SplitPane
        key={encodePanelRef(p)}
        storageKey={`workspace-panel-${i}`}
        defaultPct={1 / (activePanels.length - i + 1)}
        minPx={300}
        minFirstPx={320}
        first={acc}
        second={<SidePanel panel={p} onClose={() => removePanel(p)} />}
      />
    ),
    primaryPane,
  );

  const terminalPane = (
    <Pane
      agentName={agentRef}
      title={
        <>
          {agent.title ?? (agent.cwd ? basename(agent.cwd) : agent.name)}
          <span className="ml-2 text-faint">terminal</span>
        </>
      }
      actions={
        <button
          data-term-toggle
          onClick={toggleTerminal}
          className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
          title={`hide terminal (t / ${altLabel('T')})`}
        >
          <X size={13} />
        </button>
      }
    >
      <XtermPane key={agentRef} name={agentRef} />
    </Pane>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-edge bg-surface px-2 pt-1.5">
        {agents.map((a) => (
          <NavLink
            key={refOf(a)}
            to={`/agents/${encodeURIComponent(refOf(a))}`}
            className={({ isActive }) =>
              `flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 font-mono text-[12px] ${
                isActive ? 'border-edge bg-bg text-ink' : 'border-transparent text-mut hover:text-ink'
              }`
            }
          >
            <AgentStatusDot status={a.status} />
            {agentLabel(a, agents)}
            {isRemoteHost(a.host) && <span className="text-[9px] uppercase text-faint">{a.host}</span>}
            {activePanels.some((p) => p.kind === 'term' && p.name === refOf(a)) && (
              <Columns2 size={11} className="text-faint" />
            )}
          </NavLink>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        {terminalVisible && hasChat ? (
          <SplitPane
            storageKey="chat-terminal"
            defaultPct={0.45}
            minPx={340}
            minFirstPx={380}
            first={withPanels}
            second={terminalPane}
          />
        ) : (
          <div className="min-w-0 flex-1">{withPanels}</div>
        )}
      </div>
    </div>
  );
}
