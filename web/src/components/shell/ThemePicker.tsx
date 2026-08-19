import { useEffect, useState } from 'react';
import { Check, ChevronRight, Palette, RefreshCw } from 'lucide-react';
import {
  currentTheme,
  DRIFT_MINUTES,
  isDrifting,
  nudgeTheme,
  pickTheme,
  setDrift,
  subscribeTheme,
  THEME_LIST,
  type Theme,
} from '../../lib/themes';

function Swatches({ theme }: { theme: Theme }) {
  const c = theme.colors;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        className="h-3 w-3 rounded-full"
        style={{ backgroundColor: c.bg, border: `1px solid ${c.faint}` }}
      />
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: c.accent }} />
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: c.accent2 }} />
    </span>
  );
}

/**
 * Sidebar control for the color theme. The name opens the picker; the ›
 * advances to the next theme. Themes also drift on their own every
 * DRIFT_MINUTES unless a theme is pinned by picking it from the list.
 */
export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [themeId, setThemeId] = useState(() => currentTheme().id);
  const [drifting, setDrifting] = useState(isDrifting);

  // drift (or another control) can change the theme underneath us
  useEffect(
    () =>
      subscribeTheme(() => {
        setThemeId(currentTheme().id);
        setDrifting(isDrifting());
      }),
    [],
  );

  return (
    <div className="relative">
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-[60vh] w-full overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-xl shadow-black/30">
          <button
            onClick={() => setDrift(!drifting)}
            className={`flex w-full items-center gap-2.5 border-b border-edge px-3 py-2 text-[12px] ${
              drifting ? 'text-ink' : 'text-mut hover:text-ink'
            }`}
            title="ambient mode: hop to a random theme on an interval"
          >
            <RefreshCw size={12} className={drifting ? 'text-claude' : 'text-faint'} />
            Auto-cycle · {DRIFT_MINUTES} min
            {drifting && <Check size={12} className="ml-auto shrink-0" />}
          </button>
          {THEME_LIST.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                pickTheme(t.id);
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-[12px] hover:bg-surface2 ${
                t.id === themeId ? 'text-ink' : 'text-mut hover:text-ink'
              }`}
              title="pick a theme (pins it — turns auto-cycle off)"
            >
              <Swatches theme={t} />
              <span className="truncate">{t.name}</span>
              {t.id === themeId && <Check size={12} className="ml-auto shrink-0" />}
            </button>
          ))}
        </div>
      )}
      <div
        className={`flex items-center rounded-md ${
          open ? 'bg-surface2' : 'hover:bg-surface2'
        }`}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-l-md px-3 py-2 text-[13px] font-medium ${
            open ? 'text-ink' : 'text-mut hover:text-ink'
          }`}
          title={drifting ? `color theme — auto-cycling every ${DRIFT_MINUTES} min` : 'color theme (pinned)'}
        >
          <Palette size={15} className={drifting ? 'text-claude' : undefined} />
          <span className="truncate">{THEME_LIST.find((t) => t.id === themeId)?.name ?? 'Theme'}</span>
        </button>
        <button
          onClick={nudgeTheme}
          className="shrink-0 rounded-r-md py-2 pl-1 pr-2.5 text-mut hover:text-claude"
          title="next theme (resets the auto-cycle clock)"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
