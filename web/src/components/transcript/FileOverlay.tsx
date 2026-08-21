import { createContext, useEffect, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { fetchTextFile, fileRawUrl } from '../../lib/api';
import { Markdown } from './Markdown';

/** Opens a file in the transcript's in-pane viewer. */
export const OpenFileContext = createContext<(path: string) => void>(() => {});

const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(p);
const isJson = (p: string) => /\.json$/i.test(p);

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text; // not actually JSON — show as-is
  }
}

/**
 * In-pane file viewer: fills whatever box the transcript lives in — a side
 * panel, a wall tile, or the full session page. Markdown renders, JSON
 * pretty-prints, images display, everything else shows as plain text.
 * Within markdown, anchor links scroll in-document, relative links to other
 * files follow (with back), external links open a new tab.
 */
export function FileOverlay({ path: initialPath, host, onClose }: {
  path: string;
  host?: string;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<string[]>([initialPath]);
  const path = stack[stack.length - 1];
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const image = isImage(path);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    if (image) return; // <img> fetches for itself via /file/raw
    fetchTextFile(path, host)
      .then((f) => {
        if (!cancelled) setContent(f.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, host, image]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // capture, so the viewer wins over anything else listening for Escape
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const onClickContent = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' });
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
    } else if (href) {
      // relative link: follow it here
      setStack((s) => [...s, new URL(href, `file://${path}`).pathname]);
    }
  };

  let body;
  if (error) {
    body = <div className="px-5 py-4 text-[12px] text-red-400">{error}</div>;
  } else if (image) {
    body = (
      <div className="flex justify-center px-5 py-4">
        <img
          src={fileRawUrl(path, host)}
          alt={path}
          className="max-w-full rounded-md border border-edge"
          onError={() => setError('could not load image')}
        />
      </div>
    );
  } else if (content == null) {
    body = <div className="px-5 py-4 text-[12px] text-faint">loading…</div>;
  } else if (isMarkdown(path)) {
    body = (
      <div className="mx-auto max-w-[820px] px-5 py-4">
        <Markdown text={content} slugs />
      </div>
    );
  } else {
    body = (
      <pre className="px-5 py-4 font-mono text-[11.5px] leading-relaxed text-mut">
        {isJson(path) ? prettyJson(content) : content}
      </pre>
    );
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-3 py-2">
        {stack.length > 1 && (
          <button
            onClick={() => setStack((s) => s.slice(0, -1))}
            className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
            title="back"
          >
            <ArrowLeft size={13} />
          </button>
        )}
        <span className="truncate font-mono text-[12px] text-mut" title={path}>
          {path}
        </span>
        <button
          onClick={onClose}
          className="ml-auto shrink-0 rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
          title="close (Esc)"
        >
          <X size={13} />
        </button>
      </div>
      <div ref={scrollRef} onClick={onClickContent} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );
}
