import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * App-styled replacement for a native <select>: the popup of a native select
 * always renders with OS styling, which clashes with the app's theme.
 */
export function Select({ value, options, onChange, className }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const openMenu = () => {
    const idx = options.findIndex((o) => o.value === value);
    setHi(idx < 0 ? 0 : idx);
    setOpen(true);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  // keep the highlighted row in view while navigating with the keyboard
  useEffect(() => {
    if (!open) return;
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      commit(options[hi].value);
    } else if (e.key === 'Escape') {
      // close just the dropdown, not a surrounding modal
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-edge bg-bg px-2 py-1.5 text-left text-[13px] text-ink outline-none focus:border-faint"
      >
        <span className="truncate">
          {selected?.label ?? value}
          {selected?.hint && <span className="text-faint"> — {selected.hint}</span>}
        </span>
        <ChevronDown size={13} className="shrink-0 text-faint" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              // preventDefault: were this inside a <label>, the default action
              // would forward the click to the trigger button and reopen
              e.preventDefault();
              setOpen(false);
            }}
          />
          <div
            ref={listRef}
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-edge bg-surface py-1 shadow-2xl"
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onClick={() => commit(o.value)}
                onMouseEnter={() => setHi(i)}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                  i === hi ? 'bg-surface2 text-ink' : 'text-mut'
                }`}
              >
                <span className="truncate">
                  {o.label}
                  {o.hint && <span className="text-faint"> — {o.hint}</span>}
                </span>
                {o.value === value && <Check size={12} className="shrink-0 text-claude" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
