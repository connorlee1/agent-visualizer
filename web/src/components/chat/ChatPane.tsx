import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTree, SendHorizonal } from 'lucide-react';
import type { Message } from '@shared/types';
import type { AgentWithStatus } from '../../queries';
import { useTranscript } from '../../queries';
import { sendAgentInput } from '../../lib/api';
import { parseApprovalDialog } from '../../lib/approval';
import { stripAnsi } from '../../lib/status';
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
  const linked = useLinkedSession(agent);
  const transcript = useTranscript(linked?.provider, linked?.id, true);
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
    if (consumeComposerFocus(agent.name)) inputRef.current?.focus();
  }, [agent.name]);
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
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

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    // slash commands run in the TUI without producing a user message,
    // so an optimistic bubble would just linger
    setPending(text.startsWith('/') ? null : text);
    setSendError(null);
    try {
      await sendAgentInput(agent.name, { text });
    } catch (err) {
      setPending(null);
      setDraft(text);
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const pressKey = (key: string) => {
    void sendAgentInput(agent.name, { key }).catch(() => {});
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

  const working = agent.status === 'working' || !!pending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView
          messages={shown}
          provider={linked?.provider ?? agent.provider ?? 'claude'}
          live
          minimal={!showSteps}
          footer={
            working ? (
              <div className="flex items-center gap-2.5 py-1 pl-1">
                <span className="typing-dots"><span /><span /><span /></span>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">working…</span>
              </div>
            ) : null
          }
        />
      </div>

      {/* min-h-0 (and no height cap) lets the approval banner take the whole
          panel in short panes — the transcript collapses before options do */}
      <div className="flex min-h-0 flex-col border-t border-edge bg-surface px-3 pb-3 pt-2.5">
        <div className="center-col mx-auto flex w-full min-h-0 max-w-[880px] flex-col">
          {agent.status === 'needs-approval' && (
            <div className="mb-2.5 flex min-h-0 flex-col overflow-y-auto rounded-lg border border-alert/50 bg-alert/10 p-2.5">
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[12px] font-medium text-alert">⚠ The agent is waiting for your approval</span>
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
            </div>
          )}
          {sendError && <div className="mb-1.5 text-[12px] text-red-400">{sendError}</div>}
          <div className="flex shrink-0 items-end gap-2">
            <div className="relative min-w-0 flex-1">
              <span className="pointer-events-none absolute left-3 top-[7px] select-none font-mono text-[13px] font-bold text-claude">❯</span>
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
                rows={1}
                placeholder={`message ${agent.cwd ? basename(agent.cwd) : agent.name}…`}
                className="max-h-[40vh] w-full resize-none overflow-y-auto rounded-[4px] border border-edge bg-bg py-2 pl-8 pr-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-faint focus:border-faint"
              />
            </div>
            <button
              onClick={toggleSteps}
              className={`rounded-[4px] border p-2.5 ${
                showSteps ? 'border-faint text-ink' : 'border-edge text-faint hover:text-mut'
              }`}
              title={showSteps ? 'hide intermediate steps' : 'show intermediate steps'}
            >
              <ListTree size={15} />
            </button>
            <button
              onClick={() => void send()}
              disabled={!draft.trim()}
              className="rounded-[4px] bg-claude/90 p-2.5 text-on-accent hover:bg-claude disabled:opacity-40"
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
