import { useRef, useState, type ReactNode } from 'react';

/**
 * Horizontal two-pane split with a draggable divider. The second (right) pane
 * is sized as a fraction of the container; sizes persist per storageKey.
 * Double-click the divider to reset.
 */
export function SplitPane({ first, second, storageKey, defaultPct = 0.3, minPx = 260, minFirstPx = 320 }: {
  first: ReactNode;
  second: ReactNode;
  storageKey: string;
  /** Second pane's share of the width, 0–1. */
  defaultPct?: number;
  /** Minimum width of the second pane, px. */
  minPx?: number;
  /** Minimum width of the first pane, px. */
  minFirstPx?: number;
}) {
  const key = `pane:${storageKey}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(() => {
    const v = Number(localStorage.getItem(key));
    return v > 0.05 && v < 0.95 ? v : defaultPct;
  });
  const [dragging, setDragging] = useState(false);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const px = Math.max(minPx, Math.min(rect.right - e.clientX, rect.width - minFirstPx));
    setPct(px / rect.width);
  };

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 min-w-0 flex-1 ${dragging ? 'select-none' : ''}`}
    >
      <div className="min-w-0 flex-1 overflow-hidden">{first}</div>
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
          localStorage.setItem(key, String(pct));
        }}
        onDoubleClick={() => {
          setPct(defaultPct);
          localStorage.removeItem(key);
        }}
        className={`relative z-10 w-[4px] shrink-0 cursor-col-resize touch-none rounded-full transition-colors ${
          dragging ? 'bg-claude/60' : 'bg-transparent hover:bg-faint/60'
        }`}
        title="drag to resize · double-click to reset"
      />
      <div style={{ width: `${pct * 100}%` }} className="min-w-0 shrink-0 overflow-hidden">
        {second}
      </div>
    </div>
  );
}
