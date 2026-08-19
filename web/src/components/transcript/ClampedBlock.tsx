import { useState, type ReactNode } from 'react';

const MAX_LINES = 24;
const MAX_CHARS = 2000;

/**
 * Clamp very long message bodies to roughly one screen. The mask fades the
 * text out over any background; a toggle reveals the full content.
 */
export function ClampedBlock({ text, children }: { text: string; children: ReactNode }) {
  const lines = text.split('\n').length;
  const isLong = lines > MAX_LINES || text.length > MAX_CHARS;
  const [open, setOpen] = useState(false);
  if (!isLong) return <>{children}</>;

  return (
    <div>
      <div
        className={open ? '' : 'max-h-[300px] overflow-hidden'}
        style={
          open
            ? undefined
            : {
                maskImage: 'linear-gradient(to bottom, black 65%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, black 65%, transparent 100%)',
              }
        }
      >
        {children}
      </div>
      <button
        onClick={() => setOpen(!open)}
        className="mt-1 rounded-md border border-edge px-2 py-0.5 text-[11px] text-mut hover:bg-surface2 hover:text-ink"
      >
        {open ? '− Show less' : `⋯ Show all ${lines > MAX_LINES ? `(${lines} lines)` : ''}`}
      </button>
    </div>
  );
}
