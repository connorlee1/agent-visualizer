import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import type { ContentBlock, Message, Provider } from '@shared/types';
import { MessageBlock } from './MessageBlock';

type ToolResult = Extract<ContentBlock, { kind: 'tool_result' }>;

// Chat-style windowing: open pinned to the latest messages, render only a small
// tail window, and reveal older messages (then fetch older pages) as the reader
// scrolls up. The anchor is a message id, so refetches/prepends don't jump.
const INITIAL_WINDOW = 30;
const WINDOW_STEP = 50;

type RenderItem =
  | { kind: 'msg'; msg: Message }
  | { kind: 'steps'; id: string; count: number; msgs: Message[] };

const HARNESS_RE = />>> (TRANSCRIPT DELTA|APPROVAL REQUEST) /;

const textOf = (m: Message): string =>
  m.content.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n');

function isJsonBlob(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal mode: keep only human prompts and the agent's prose. Everything
 * else — tool calls, thinking, harness-injected blobs, raw JSON verdicts —
 * folds into compact expandable "n steps" rows.
 */
function toRenderItems(list: Message[], minimal: boolean): RenderItem[] {
  if (!minimal) return list.map((msg) => ({ kind: 'msg' as const, msg }));
  const out: RenderItem[] = [];
  let hidden: Message[] = [];
  const flush = () => {
    if (!hidden.length) return;
    const count = hidden.reduce(
      (n, m) => n + Math.max(1, m.content.filter((b) => b.kind === 'tool_use').length),
      0,
    );
    out.push({ kind: 'steps', id: `steps-${hidden[0].id}`, count, msgs: hidden });
    hidden = [];
  };
  for (const m of list) {
    const texts = m.content.filter((b) => b.kind === 'text');
    const text = textOf(m);
    if (m.role === 'assistant') {
      if (!texts.length || isJsonBlob(text)) {
        hidden.push(m);
        continue;
      }
      const nonText = m.content.filter((b) => b.kind !== 'text');
      flush();
      out.push({ kind: 'msg', msg: nonText.length ? { ...m, content: texts } : m });
      if (nonText.length) hidden.push({ ...m, id: `${m.id}~t`, content: nonText });
      continue;
    }
    if (HARNESS_RE.test(text)) {
      hidden.push(m);
      continue;
    }
    flush();
    out.push({ kind: 'msg', msg: m });
  }
  flush();
  return out;
}

export function TranscriptView({ messages, provider, live = false, hasEarlier = false, onLoadEarlier, loadingEarlier = false, forceToolsOpen, narrow = false, minimal = false, footer }: {
  messages: Message[];
  provider: Provider;
  live?: boolean;
  hasEarlier?: boolean;
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  forceToolsOpen?: boolean;
  narrow?: boolean;
  /** Hide tool calls / machine noise; show only prompts and prose. */
  minimal?: boolean;
  /** Rendered inside the scroll area after the last message (typing indicator). */
  footer?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const initialised = useRef(false);
  const prevFirstId = useRef<string | undefined>(undefined);
  const prevScrollHeight = useRef(0);

  const toolResults = new Map<string, ToolResult>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.kind === 'tool_result' && block.toolId) toolResults.set(block.toolId, block);
    }
  }
  // tool-result-only user messages render under their tool call, not as rows
  const visible = messages.filter(
    (m) => !(m.role === 'user' && m.content.every((b) => b.kind === 'tool_result')),
  );

  let startIdx = Math.max(0, visible.length - INITIAL_WINDOW);
  if (anchorId) {
    const idx = visible.findIndex((m) => m.id === anchorId);
    if (idx >= 0) startIdx = idx;
  }
  const windowed = visible.slice(startIdx);
  const items = toRenderItems(windowed, minimal);

  // adopt an anchor once data arrives; re-adopt if ours left the fetch window
  useEffect(() => {
    if (!visible.length) return;
    if (!anchorId || !visible.some((m) => m.id === anchorId)) {
      setAnchorId(visible[Math.max(0, visible.length - INITIAL_WINDOW)].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, anchorId]);

  // open pinned to the latest messages
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || initialised.current || !windowed.length) return;
    el.scrollTop = el.scrollHeight;
    initialised.current = true;
    setReady(true);
  });

  // keep the viewport stable when older content appears above
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = windowed[0]?.id;
    if (
      prevFirstId.current &&
      firstId !== prevFirstId.current &&
      windowed.some((m) => m.id === prevFirstId.current)
    ) {
      el.scrollTop += el.scrollHeight - prevScrollHeight.current;
    }
    prevFirstId.current = firstId;
    prevScrollHeight.current = el.scrollHeight;
  });

  // live mode: stay pinned to the bottom only while the reader is truly at it
  useEffect(() => {
    const el = scrollRef.current;
    if (el && live && nearBottom) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 2px tolerance covers sub-pixel scrollTop rounding; any real scroll-up pauses following
    const onScroll = () => setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 2);
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // reveal older messages as the top approaches; fetch more once local ones run out
  useEffect(() => {
    const el = topSentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root || !ready) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      if (startIdx > 0) setAnchorId(visible[Math.max(0, startIdx - WINDOW_STEP)].id);
      else if (hasEarlier && !loadingEarlier) onLoadEarlier?.();
    }, { root, rootMargin: '800px 0px 0px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  });

  const atStart = !hasEarlier && startIdx === 0 && windowed.length > 0;
  let lastRole: string | null = null;

  return (
    <div className="relative h-full min-h-0">
      <div ref={scrollRef} data-transcript-scroll className="h-full overflow-y-auto">
        <div className={`center-col mx-auto flex flex-col gap-2 px-4 py-4 ${narrow ? '' : 'max-w-[880px]'}`}>
          <div ref={topSentinelRef} />
          {loadingEarlier && (
            <div className="py-2 text-center text-[12px] text-faint">loading earlier…</div>
          )}
          {atStart && (
            <div className="py-2 text-center text-[11px] text-faint">· start of conversation ·</div>
          )}
          {items.map((item) => {
            if (item.kind === 'steps') {
              lastRole = null;
              const open = expandedSteps.has(item.id);
              return (
                <div key={item.id}>
                  <button
                    onClick={() =>
                      setExpandedSteps((s) => {
                        const next = new Set(s);
                        if (open) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                    className="flex items-center gap-1.5 pl-1 font-mono text-[11px] text-[color:var(--ansi-blue)] opacity-75 hover:opacity-100"
                  >
                    <Wrench size={10} />
                    {item.count} step{item.count === 1 ? '' : 's'} {open ? '▾' : '▸'}
                  </button>
                  {open &&
                    item.msgs.map((m) => (
                      <MessageBlock
                        key={m.id}
                        msg={m}
                        provider={provider}
                        toolResults={toolResults}
                        forceToolsOpen={forceToolsOpen}
                      />
                    ))}
                </div>
              );
            }
            const showHeader = item.msg.role !== lastRole;
            lastRole = item.msg.role;
            return (
              <MessageBlock
                key={item.msg.id}
                msg={item.msg}
                provider={provider}
                toolResults={toolResults}
                forceToolsOpen={forceToolsOpen}
                showHeader={showHeader}
              />
            );
          })}
          {visible.length === 0 && !footer && (
            <div className="py-8 text-center text-[12px] text-faint">no messages yet</div>
          )}
          {footer}
        </div>
      </div>
      {!nearBottom && (
        <button
          onClick={() => {
            setNearBottom(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-edge bg-surface px-3 py-1 text-[11px] text-mut shadow-lg hover:text-ink"
        >
          {live ? '↓ following paused — jump to latest' : '↓ jump to latest'}
        </button>
      )}
    </div>
  );
}
