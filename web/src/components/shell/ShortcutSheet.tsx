import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';

const SECTIONS: Array<{ title: string; rows: Array<[keys: string, what: string]> }> = [
  {
    title: 'Anywhere',
    rows: [
      ['⌘K', 'launch a new agent'],
      ['1–9', 'jump to the nth running agent'],
      ['⌥U', 'reopen the last closed agent'],
      ['g', 'open the wall'],
      ['⌥C', 'next color theme'],
      ['⌥?', 'this cheatsheet'],
    ],
  },
  {
    title: 'Panels',
    rows: [
      ['⌥⇥ / ⌥⇧⇥', 'focus next / previous panel'],
      ['⌥S', 'sleep or wake the focused panel'],
      ['⌥F', 'fullscreen the focused panel (toggle)'],
      ['⌥T', 'flip the focused panel chat ↔ terminal'],
      ['⌥↓', 'jump to the latest message / output'],
      ['⌥R', 'expand / collapse the recap strip'],
      ['⌘⌥⌫ ×2', 'kill the focused panel’s agent'],
      ['click', 'focus a panel'],
    ],
  },
  {
    title: 'Agent page',
    rows: [
      ['t', 'toggle the raw terminal'],
      ['s', 'open a split panel beside this one'],
      ['⏎ / ⇧⏎', 'send · newline, in the composer'],
    ],
  },
  {
    title: 'Elsewhere',
    rows: [
      ['/', 'focus search, on the home page'],
      ['⌘⏎', 'launch, in the new-agent form'],
    ],
  },
];

/**
 * Sidebar keyboard-shortcut reference: a keyboard icon beside the theme
 * picker; the panel opens rightward over the main content. ⌥? (⌥⇧/)
 * toggles it from anywhere, typing included — capture phase so a focused
 * xterm can't swallow it; e.code, since macOS turns the chord into "¿".
 */
export function ShortcutSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (e.code !== 'Slash' || !e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <div className="relative">
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {open && (
        <div className="absolute bottom-0 left-full z-50 ml-3 max-h-[85vh] w-[300px] overflow-y-auto rounded-lg border border-edge bg-surface py-2 shadow-xl shadow-black/30">
          {SECTIONS.map((s) => (
            <div key={s.title} className="px-3 pb-2">
              <div className="px-1 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-widest text-faint">
                {s.title}
              </div>
              {s.rows.map(([keys, what]) => (
                <div key={keys} className="flex items-baseline gap-2.5 px-1 py-[3px] text-[12px]">
                  <span className="w-[88px] shrink-0 font-mono text-[11px] text-[color:var(--ansi-yellow)]">
                    {keys}
                  </span>
                  <span className="text-mut">{what}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="border-t border-edge px-4 pb-1 pt-2 text-[10px] text-faint">
            letter keys wait while you’re typing in a text box
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-md p-2 ${
          open ? 'bg-surface2 text-ink' : 'text-mut hover:bg-surface2 hover:text-ink'
        }`}
        title="keyboard shortcuts (⌥?)"
      >
        <Keyboard size={15} />
      </button>
    </div>
  );
}
