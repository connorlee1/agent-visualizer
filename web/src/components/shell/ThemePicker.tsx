import { useEffect, useState } from 'react';
import { Check, ChevronRight, Palette, RefreshCw } from 'lucide-react';
import {
  currentStyle,
  currentTheme,
  DRIFT_MINUTES,
  isDrifting,
  nudgeTheme,
  pickStyle,
  pickTheme,
  setDrift,
  STYLE_LIST,
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
 * Sidebar control for the skin: style (shape/type/glyphs — pinned, never
 * drifts) and color theme. The name opens the picker; the › hops to a
 * random different color theme. Color themes also drift on their own every
 * DRIFT_MINUTES unless one is pinned by picking it from the list.
 */
export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [themeId, setThemeId] = useState(() => currentTheme().id);
  const [styleId, setStyleId] = useState(() => currentStyle().id);
  const [drifting, setDrifting] = useState(isDrifting);

  // drift (or another control) can change the theme underneath us
  useEffect(
    () =>
      subscribeTheme(() => {
        setThemeId(currentTheme().id);
        setStyleId(currentStyle().id);
        setDrifting(isDrifting());
      }),
    [],
  );

  return (
    <div className="relative">
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-[60vh] w-full overflow-y-auto rounded-(--radius-panel) border border-edge bg-surface py-1 shadow-xl shadow-black/30">
          {/* styles are pinned — the auto-cycle below only ever hops colors */}
          <div className="px-3 pb-0.5 pt-1.5 font-body text-[9px] font-semibold uppercase tracking-[0.14em] text-faint">
            Style
          </div>
          {STYLE_LIST.map((s) => (
            <button
              key={s.id}
              onClick={() => pickStyle(s.id)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-[12px] hover:bg-surface2 ${
                s.id === styleId ? 'text-ink' : 'text-mut hover:text-ink'
              }`}
              title={s.tagline}
            >
              <span className="truncate">{s.name}</span>
              {s.id === styleId && <Check size={12} className="ml-auto shrink-0" />}
            </button>
          ))}
          <div className="mt-1 border-t border-edge px-3 pb-0.5 pt-1.5 font-body text-[9px] font-semibold uppercase tracking-[0.14em] text-faint">
            Colors
          </div>
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
          <span className="truncate">
            {THEME_LIST.find((t) => t.id === themeId)?.name ?? 'Theme'}
            {styleId !== 'console' && ` · ${STYLE_LIST.find((s) => s.id === styleId)?.name ?? ''}`}
          </span>
        </button>
        <button
          onClick={nudgeTheme}
          className="shrink-0 rounded-r-md py-2 pl-1 pr-2.5 text-mut hover:text-claude"
          title="random theme (resets the auto-cycle clock)"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
