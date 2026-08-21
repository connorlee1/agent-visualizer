import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Columns2, Play } from 'lucide-react';
import type { Message, Provider } from '@shared/types';
import { fetchTranscript } from '../lib/api';
import { useAgents, useTranscript } from '../queries';
import { hostOf, refOf, LOCAL_HOST } from '../lib/agentRef';
import { useResume } from '../lib/useResume';
import { decodePanelRef, encodePanelRef, type PanelRef } from '../lib/panelRef';
import { TranscriptView } from '../components/transcript/TranscriptView';
import { ProviderBadge } from '../components/projects/ProviderBadge';
import { ModelChip } from '../components/projects/ModelChip';
import { SplitPane } from '../components/ui/SplitPane';
import { SidePanel } from '../components/panel/SidePanel';
import { PanelPicker } from '../components/panel/PanelPicker';
import { basename, encodeProjectId, relTime } from '../lib/format';

function dedupeById(list: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of list) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

export function SessionPage() {
  const params = useParams<{ provider: string; sessionId: string }>();
  const provider = (params.provider === 'codex' ? 'codex' : 'claude') as Provider;
  const sessionId = params.sessionId!;
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  // ?host= reads a remote machine's conversation through the forwarder
  const host = searchParams.get('host') ?? LOCAL_HOST;

  const query = useTranscript(provider, sessionId, true, host);
  const { agents } = useAgents();
  const { resume, busyId, error } = useResume();
  const [earlier, setEarlier] = useState<Message[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [expandTools, setExpandTools] = useState(false);

  const panel = decodePanelRef(searchParams.get('panel'));
  const [pickerOpen, setPickerOpen] = useState(false);
  const setPanel = (p: PanelRef | null) => {
    const next = new URLSearchParams(searchParams);
    if (p) next.set('panel', encodePanelRef(p));
    else next.delete('panel');
    setSearchParams(next);
  };

  const data = query.data;
  const session = data?.session;
  const earliestOffset = (data?.offset ?? 0) - earlier.length;
  const messages = useMemo(
    () => dedupeById([...earlier, ...(data?.messages ?? [])]),
    [earlier, data],
  );

  const runningAgent = agents.find(
    (a) => hostOf(a) === host && (a.sessionId === sessionId || a.resumedFrom === sessionId),
  );

  const loadingRef = useRef(false);
  const loadEarlier = async () => {
    if (!data || earliestOffset <= 0 || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    try {
      const start = Math.max(0, earliestOffset - 100);
      const res = await fetchTranscript(provider, sessionId, {
        offset: start,
        limit: earliestOffset - start,
        host,
      });
      if (res) setEarlier((prev) => [...res.messages, ...prev]);
    } finally {
      loadingRef.current = false;
      setLoadingEarlier(false);
    }
  };

  if (query.isLoading) {
    return <div className="flex h-full items-center justify-center text-mut">loading conversation…</div>;
  }
  if (query.isError || !session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-mut">
        <div>couldn’t load this conversation</div>
        <div className="text-[12px] text-faint">{query.error instanceof Error ? query.error.message : ''}</div>
      </div>
    );
  }

  const reader = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative z-30 border-b border-edge bg-surface px-6 py-3.5">
        <div className="mx-auto max-w-[880px]">
          <div className="flex items-center gap-3">
            <Link
              to={`/history/${encodeProjectId(session.projectPath)}`}
              className="shrink-0 rounded-md p-1 text-mut hover:bg-surface2 hover:text-ink"
              title="back to history"
            >
              <ArrowLeft size={16} />
            </Link>
            <h1 className="truncate text-[16px] font-semibold">{session.title}</h1>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <button
                onClick={() => setExpandTools((v) => !v)}
                className={`rounded-md border px-2.5 py-1.5 text-[12px] ${
                  expandTools ? 'border-faint text-ink' : 'border-edge text-mut hover:text-ink'
                }`}
              >
                {expandTools ? 'Collapse' : 'Expand'} tools
              </button>
              <div className="relative">
                <button
                  onClick={() => (panel ? setPanel(null) : setPickerOpen((v) => !v))}
                  className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[12px] ${
                    panel ? 'border-faint text-ink' : 'border-edge text-mut hover:text-ink'
                  }`}
                  title={panel ? 'close panel' : 'open an agent or conversation beside this'}
                >
                  <Columns2 size={12} /> Split
                </button>
                <PanelPicker
                  open={pickerOpen}
                  onClose={() => setPickerOpen(false)}
                  onSelect={setPanel}
                  excludeRefs={[
                    encodePanelRef({ kind: 'chat', provider, id: sessionId }),
                    ...(panel ? [encodePanelRef(panel)] : []),
                  ]}
                />
              </div>
              {runningAgent ? (
                <button
                  onClick={() => navigate(`/agents/${encodeURIComponent(refOf(runningAgent))}`)}
                  className="flex items-center gap-1.5 rounded-md bg-ok/15 px-3 py-1.5 text-[12px] font-medium text-ok"
                >
                  ▶ Open terminal
                </button>
              ) : (
                <button
                  onClick={() => void resume(provider, sessionId, host)}
                  disabled={busyId === sessionId}
                  className="flex items-center gap-1.5 rounded-md bg-claude/90 px-3 py-1.5 text-[12px] font-semibold text-on-accent hover:bg-claude disabled:opacity-50"
                >
                  <Play size={11} /> {busyId === sessionId ? 'Resuming…' : 'Resume'}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2.5 pl-9 pt-1 text-[12px] text-faint">
            <ProviderBadge provider={session.provider} />
            <ModelChip model={session.model} effort={session.effort} />
            <span>{basename(session.projectPath)}</span>
            {session.agentName && (
              <>
                <span>·</span>
                <span>named “{session.agentName}”</span>
              </>
            )}
            <span>·</span>
            <span>{data.total} messages</span>
            <span>·</span>
            <span>{relTime(session.lastActivityAt)}</span>
          </div>
          {error && <div className="pl-9 pt-1 text-[12px] text-red-400">{error}</div>}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <TranscriptView
          messages={messages}
          provider={provider}
          hasEarlier={earliestOffset > 0}
          onLoadEarlier={() => void loadEarlier()}
          loadingEarlier={loadingEarlier}
          forceToolsOpen={expandTools}
        />
      </div>
    </div>
  );

  return (
    <div className="h-full">
      {panel ? (
        <div className="flex h-full">
          <SplitPane
            storageKey="reader-panel"
            defaultPct={0.42}
            minPx={320}
            minFirstPx={420}
            first={reader}
            second={<SidePanel panel={panel} onClose={() => setPanel(null)} />}
          />
        </div>
      ) : (
        reader
      )}
    </div>
  );
}
