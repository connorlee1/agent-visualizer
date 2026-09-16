import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ImagePlus, ListTree, SendHorizonal, X } from 'lucide-react';
import type { Message } from '@shared/types';
import type { AgentWithStatus } from '../../queries';
import { useHosts, useTranscript } from '../../queries';
import { sendAgentInput, uploadAgentImage } from '../../lib/api';
import { hostOf, isRemoteHost, refOf } from '../../lib/agentRef';
import { parseApprovalDialog } from '../../lib/approval';
import { altLabel } from '../../lib/keys';
import { RECAP_IDLE_MS, stripAnsi } from '../../lib/status';
import { basename } from '../../lib/format';
import { useLinkedSession } from '../../lib/useLinkedSession';
import { consumeComposerFocus } from '../../lib/focusAgent';
import { TranscriptView } from '../transcript/TranscriptView';

/**
 * App-native surface for talking to a running agent: rendered transcript +
 * composer. Input is relayed into the agent's tmux pane, so the raw terminal
 * stays fully usable in parallel.
 */
export function ChatPane({ agent }: { agent: AgentWithStatus }) {
  const agentRef = refOf(agent);
  const linked = useLinkedSession(agent);
  const transcript = useTranscript(linked?.provider, linked?.id, true, hostOf(agent));
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // grow the composer to fit its content (wrapped lines included); the
  // max-height class keeps a runaway paste from swallowing the transcript
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft]);

  // a freshly launched agent asks for its composer to be focused (see focusAgent.ts)
  useEffect(() => {
    if (consumeComposerFocus(agentRef)) inputRef.current?.focus();
  }, [agentRef]);
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // images dropped/pasted into the composer, already saved on the agent's
  // machine; their paths are prepended to the message on send
  const [attached, setAttached] = useState<{ path: string; url: string; name: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSteps, setShowSteps] = useState(() => localStorage.getItem('chatSteps') === '1');
  const toggleSteps = () => {
    setShowSteps((v) => {
      localStorage.setItem('chatSteps', v ? '0' : '1');
      return !v;
    });
  };

  const messages = transcript.data?.messages ?? [];

  // drop the optimistic message once it lands in the real transcript
  useEffect(() => {
    if (!pending) return;
    const landed = messages.some(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.kind === 'text' && b.text.trim() === pending.trim()),
    );
    if (landed) {
      setPending(null);
      return;
    }
    const timeout = setTimeout(() => setPending(null), 12_000);
    return () => clearTimeout(timeout);
  }, [messages, pending]);

  const shown = useMemo<Message[]>(
    () =>
      pending
        ? [...messages, {
            id: '__pending__',
            role: 'user',
            timestamp: new Date().toISOString(),
            content: [{ kind: 'text', text: pending }],
          }]
        : messages,
    [messages, pending],
  );

  /** Save dropped/pasted/picked images and attach them to the next message. */
  const attachFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      if (files.length) setSendError('only images can be attached');
      return;
    }
    setSendError(null);
    setUploading((n) => n + images.length);
    await Promise.all(
      images.map(async (file) => {
        try {
          const path = await uploadAgentImage(agentRef, file);
          setAttached((a) => [...a, { path, url: URL.createObjectURL(file), name: file.name || 'image' }]);
        } catch (err) {
          setSendError(err instanceof Error ? err.message : String(err));
        } finally {
          setUploading((n) => n - 1);
        }
      }),
    );
  };

  const removeAttachment = (path: string) =>
    setAttached((a) => {
      const gone = a.find((x) => x.path === path);
      if (gone) URL.revokeObjectURL(gone.url);
      return a.filter((x) => x.path !== path);
    });

  const send = async () => {
    const text = draft.trim();
    // an image on its own is a valid message — the CLI reads the path
    if (!text && !attached.length) return;
    // paths first so the CLI resolves them before reading the instruction
    const body = [...attached.map((a) => a.path), text].filter(Boolean).join(' ');
    setDraft('');
    attached.forEach((a) => URL.revokeObjectURL(a.url));
    setAttached([]);
    // slash commands run in the TUI without producing a user message,
    // so an optimistic bubble would just linger
    setPending(body.startsWith('/') ? null : body);
    setSendError(null);
    try {
      await sendAgentInput(agentRef, { text: body });
    } catch (err) {
      setPending(null);
      setDraft(text);
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const pressKey = (key: string) => {
    void sendAgentInput(agentRef, { key }).catch(() => {});
  };

  const dialog = useMemo(() => parseApprovalDialog(agent.preview), [agent.preview]);
  // raw-tail fallback when the pane text doesn't parse as a dialog
  const approvalContext = dialog?.question.length
    ? dialog.question.join('\n')
    : stripAnsi(agent.preview)
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(-8)
        .join('\n');

  // Keyboard path to the approval dialog: while it's pending and the composer
  // is EMPTY, dialog keys pressed anywhere in the pane go to the agent's
  // terminal (matching the hint text) instead of typing into the textarea.
  // A non-empty draft disables forwarding so digits/Enter in a typed message
  // still behave normally. y/n stay typeable — they start words too often.
  const forwardDialogKeys = (e: KeyboardEvent) => {
    if (agent.status !== 'needs-approval' || draft) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key =
      /^[1-9]$/.test(e.key) ? e.key
      : e.key === 'Escape' ? 'Escape'
      : e.key === 'Enter' ? 'Enter'
      : e.key === 'ArrowUp' ? 'Up'
      : e.key === 'ArrowDown' ? 'Down'
      : null;
    if (!key) return;
    e.preventDefault();
    e.stopPropagation(); // keep bare digits away from the wall's 1-9 pane-jump
    pressKey(key);
  };

  const working = agent.status === 'working' || !!pending;

  // A stalled tunnel or failing poll leaves the transcript frozen on stale
  // data with no other tell — say so instead of reading as a rendering bug.
  // Only after failures have PERSISTED, though: one slow cold load or one
  // blip mid-reconnect self-heals on the next 3s poll, and a banner that
  // flashes for those cries wolf.
  const host = hostOf(agent);
  const { data: hostsInfo } = useHosts();
  const hostDown =
    isRemoteHost(host) && !!hostsInfo && !hostsInfo.some((h) => h.id === host && h.status === 'connected');
  const dataAge = Date.now() - (transcript.dataUpdatedAt || 0);
  const degraded = (hostDown || transcript.isError) && dataAge > 15_000;

  // orientation strip after a real pause — the wall is where recaps get read
  const showRecap =
    !!agent.idleSummary &&
    agent.status === 'waiting' &&
    agent.lastWriteMs != null &&
    Date.now() - agent.lastWriteMs > RECAP_IDLE_MS;
  const [recapOpen, setRecapOpen] = useState(false);

  // No conversation after a normal startup window means the CLI is sitting on
  // a terminal-only screen chat can't show (first-run login, trust prompt, a
  // menu) — seen constantly on fresh remote machines. Without this, the pane
  // is an eternal spinner and nothing tells you the terminal is where to look.
  const needsTerminal =
    shown.length === 0 &&
    !transcript.isLoading &&
    !degraded &&
    Date.now() - new Date(agent.createdAt).getTime() > 15_000;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onKeyDown={forwardDialogKeys}
      // dragenter/over must both preventDefault or the browser navigates to the file
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // only when the pointer truly leaves the pane, not on inner-element churn
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        void attachFiles([...e.dataTransfer.files]);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-claude bg-bg/85">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-claude">
            <ImagePlus size={16} /> drop image to attach
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {needsTerminal ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-[420px] text-center text-[12.5px] leading-relaxed text-mut">
              <div className="pb-1 font-body text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                no conversation yet
              </div>
              The CLI is probably showing a screen only its terminal can display —
              a first-run login, a trust prompt, or a menu. Open the terminal
              (<span className="font-body text-ink">t</span> / <span className="font-body text-ink">{altLabel('T')}</span>)
              to see and answer it.
            </div>
          </div>
        ) : (
        <TranscriptView
          messages={shown}
          provider={linked?.provider ?? agent.provider ?? 'claude'}
          host={hostOf(agent)}
          live
          minimal={!showSteps}
          footer={
            working ? (
              <div className="flex items-center gap-2.5 py-1 pl-1">
                <span className="typing-dots"><span /><span /><span /></span>
                <span className="font-body text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">working…</span>
              </div>
            ) : null
          }
        />
        )}
      </div>

      {/* min-h-0 (and no height cap) lets the approval banner take the whole
          panel in short panes — the transcript collapses before options do */}
      <div className="flex min-h-0 flex-col border-t border-edge bg-surface px-3 pb-3 pt-2.5">
        <div className="center-col mx-auto flex w-full min-h-0 max-w-[880px] flex-col">
          {degraded && (
            <div className="mb-1.5 flex shrink-0 items-center gap-1.5 rounded-md border border-edge bg-surface2 px-2 py-1 text-[11px] text-mut">
              <span className="text-alert">●</span>
              <span className="min-w-0 truncate">
                {hostDown ? `connection to ${host} lost — reconnecting` : 'transcript updates failing — retrying'}
                {messages.length ? '; showing last fetched messages' : ''}
              </span>
            </div>
          )}
          {agent.status === 'needs-approval' && (
            <div className="mb-2.5 flex min-h-0 flex-col overflow-y-auto rounded-lg border border-alert/50 bg-alert/10 p-2.5">
              <div className="flex shrink-0 items-center gap-2">
                {/* "input", not "approval" — selector dialogs (Rewind, pickers) land here too */}
                <span className="font-body text-[10px] font-semibold uppercase tracking-[0.14em] text-alert"><span className="g-status" data-st="needs-approval" /> Input required</span>
                <span className="ml-auto min-w-0 truncate text-[11px] text-faint">keys are pressed in the agent’s terminal</span>
                {dialog?.multiSelect && (
                  <button
                    onClick={() => pressKey('Enter')}
                    title="number keys toggle options; this presses Enter to submit"
                    className="shrink-0 rounded-md border border-edge bg-bg px-2.5 py-0.5 font-mono text-[12px] text-ink hover:border-faint"
                  >
                    ↵ Submit
                  </button>
                )}
                <button
                  onClick={() => pressKey('Escape')}
                  title="presses Escape in the agent’s terminal"
                  className="shrink-0 rounded-md border border-edge bg-bg px-2.5 py-0.5 font-mono text-[12px] text-mut hover:border-faint"
                >
                  Esc
                </button>
              </div>
              {/* context gives way first; the option list keeps a real minimum
                  so several options stay visible even in short panes */}
              <pre className="mt-1.5 max-h-28 min-h-4 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-mut">
                {approvalContext}
              </pre>
              {dialog && (
                <div className="mt-2 flex min-h-32 flex-col gap-1 overflow-y-auto">
                  {dialog.options.map((o) => (
                    <button
                      key={o.key}
                      onClick={() => pressKey(o.key)}
                      title={o.detail ? `${o.label} — ${o.detail}` : o.label}
                      className={`flex shrink-0 items-baseline gap-2 rounded-md border bg-bg px-2.5 py-1.5 text-left text-[12px] hover:border-faint ${
                        o.selected ? 'border-alert/60' : 'border-edge'
                      }`}
                    >
                      <span className="w-3 shrink-0 font-mono text-[11px] text-faint">{o.key}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-ink">{o.label}</span>
                        {o.detail && <span className="block truncate text-[11px] text-faint">{o.detail}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!dialog && agent.provider === 'kimi' && (
                <div className="mt-2 flex gap-2">
                  {(['Up', 'Down', 'Enter'] as const).map((key) => (
                    <button key={key} onClick={() => pressKey(key)} className="rounded-md border border-edge bg-bg px-3 py-1 text-[12px] text-ink hover:border-faint">
                      {key === 'Up' ? '↑' : key === 'Down' ? '↓' : '↵ Confirm'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {showRecap && (
            // one line on the wall; click to expand to the full summary
            <button
              data-recap-toggle
              onClick={() => setRecapOpen((v) => !v)}
              title={recapOpen ? `collapse (${altLabel('R')})` : `${agent.idleSummary} (${altLabel('R')})`}
              className="mb-1.5 flex w-full shrink-0 items-baseline gap-1.5 rounded-md border border-edge bg-surface2 px-2 py-0.5 text-left hover:border-faint"
            >
              <span className="shrink-0 font-body text-[9px] font-semibold uppercase tracking-[0.14em] text-faint">
                {recapOpen ? '▾' : '▸'} recap
              </span>
              <span
                className={`min-w-0 flex-1 text-[10.5px] leading-snug text-mut ${recapOpen ? '' : 'truncate'}`}
              >
                {agent.idleSummary}
              </span>
            </button>
          )}
          {sendError && <div className="mb-1.5 text-[12px] text-red-400">{sendError}</div>}
          {(attached.length > 0 || uploading > 0) && (
            <div className="mb-1.5 flex shrink-0 flex-wrap items-center gap-1.5">
              {attached.map((a) => (
                <div
                  key={a.path}
                  title={a.path}
                  className="group relative h-14 w-14 overflow-hidden rounded-(--radius-chip) border border-edge bg-bg"
                >
                  <img src={a.url} alt={a.name} className="h-full w-full object-cover" />
                  <button
                    onClick={() => removeAttachment(a.path)}
                    title="remove"
                    className="absolute right-0 top-0 rounded-bl bg-bg/80 p-0.5 text-mut opacity-0 group-hover:opacity-100 hover:text-ink"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              {uploading > 0 && (
                <div className="flex h-14 w-14 items-center justify-center rounded-(--radius-chip) border border-dashed border-edge text-[10px] text-faint">
                  saving…
                </div>
              )}
            </div>
          )}
          <div className="flex shrink-0 items-end gap-2">
            <div className="relative min-w-0 flex-1">
              <span className="g-prompt pointer-events-none absolute left-3 top-[7px] select-none font-body text-[13px] font-bold text-claude" />
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                onPaste={(e) => {
                  // screenshots arrive as clipboard files; let normal text paste through
                  const files = [...e.clipboardData.files];
                  if (!files.length) return;
                  e.preventDefault();
                  void attachFiles(files);
                }}
                rows={1}
                placeholder={`message ${agent.cwd ? basename(agent.cwd) : agent.name}…`}
                className="max-h-[40vh] w-full resize-none overflow-y-auto rounded-(--radius-chip) border border-edge bg-bg py-2 pl-8 pr-3 font-body text-[12.5px] leading-relaxed outline-none placeholder:text-faint focus:border-faint"
              />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void attachFiles([...(e.target.files ?? [])]);
                e.target.value = ''; // let the same file be picked again
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-(--radius-chip) border border-edge p-2.5 text-faint hover:text-mut"
              title="attach an image (or drop / paste one)"
            >
              <ImagePlus size={15} />
            </button>
            <button
              onClick={toggleSteps}
              className={`rounded-(--radius-chip) border p-2.5 ${
                showSteps ? 'border-faint text-ink' : 'border-edge text-faint hover:text-mut'
              }`}
              title={showSteps ? 'hide intermediate steps' : 'show intermediate steps'}
            >
              <ListTree size={15} />
            </button>
            <button
              onClick={() => void send()}
              disabled={!draft.trim() && !attached.length}
              className="rounded-(--radius-chip) bg-claude/90 p-2.5 text-on-accent hover:bg-claude disabled:opacity-40"
              title="send (Enter)"
            >
              <SendHorizonal size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
