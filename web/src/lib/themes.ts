/**
 * Faithful implementations of popular VS Code color themes.
 *
 * Each theme maps the palette's *published* hex values onto the app's fixed
 * semantic roles (the --color-* tokens Tailwind utilities read), plus the
 * theme's published terminal ANSI palette so the embedded xterm terminals and
 * ANSI previews re-skin with the rest of the UI. Colors are applied as CSS
 * custom properties on <html>, overriding the @theme defaults in index.css.
 *
 * Sources (official palette repos / marketplace themes):
 *   One Dark Pro  — Binaryify/OneDark-Pro (Atom One Dark palette)
 *   Dracula       — dracula/visual-studio-code
 *   Monokai       — classic Monokai (VS Code built-in)
 *   GitHub        — primer/github-vscode-theme (dark + light)
 *   Tokyo Night   — enkia/tokyo-night-vscode-theme (Night variant)
 *   Catppuccin    — catppuccin/catppuccin (Mocha)
 *   Nord          — nordtheme/nord
 *   Gruvbox       — morhetz/gruvbox (dark, medium)
 *   Solarized     — altercation/solarized (dark + light)
 *   Night Owl     — sdras/night-owl-vscode-theme
 *   Ayu Mirage    — ayu-theme/ayu-colors
 *   Rosé Pine     — rose-pine/rose-pine (main)
 *   Synthwave '84 — robb0wen/synthwave-vscode
 * Surface/border tones missing from a published palette are derived from its
 * background ramp.
 */

export interface Theme {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  colors: {
    bg: string;       // page + terminal background
    surface: string;  // sidebar, pane headers, cards
    surface2: string; // hover / raised
    edge: string;     // borders, dividers
    ink: string;      // primary text
    mut: string;      // secondary text
    faint: string;    // tertiary text
    accent: string;   // primary accent (--color-claude)
    accent2: string;  // secondary accent (--color-codex)
    ok: string;       // working / success
    warn: string;     // waiting
    alert: string;    // needs approval
    onAccent: string; // text on accent-filled buttons
    sel: string;      // text selection background
    cursor: string;   // terminal cursor
  };
  /** black, red, green, yellow, blue, magenta, cyan, white, then brights. */
  ansi: [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string,
  ];
}

export const THEMES: Record<string, Theme> = {
  terracotta: {
    id: 'terracotta',
    name: 'Terracotta',
    mode: 'dark',
    colors: {
      bg: '#0b0e14', surface: '#11151c', surface2: '#161b24', edge: '#1e242e',
      ink: '#e6e9ef', mut: '#8b93a3', faint: '#5c6370',
      accent: '#d97757', accent2: '#2dd4bf',
      ok: '#4ade80', warn: '#facc15', alert: '#fb923c',
      onAccent: '#000000', sel: '#2a3547', cursor: '#d97757',
    },
    ansi: [
      '#1e242e', '#f07178', '#4ade80', '#facc15', '#82aaff', '#c792ea', '#2dd4bf', '#c7cdd8',
      '#5c6370', '#ff8b92', '#6ee7a0', '#fde047', '#9ec1ff', '#dcaff5', '#5eead4', '#e6e9ef',
    ],
  },

  'one-dark-pro': {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    mode: 'dark',
    colors: {
      bg: '#282c34', surface: '#21252b', surface2: '#2c313a', edge: '#3e4451',
      ink: '#abb2bf', mut: '#848b98', faint: '#5c6370',
      accent: '#61afef', accent2: '#c678dd',
      ok: '#98c379', warn: '#e5c07b', alert: '#d19a66',
      onAccent: '#21252b', sel: '#3e4451', cursor: '#528bff',
    },
    ansi: [
      '#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#545862', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4',
    ],
  },

  dracula: {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    colors: {
      bg: '#282a36', surface: '#21222c', surface2: '#343746', edge: '#44475a',
      ink: '#f8f8f2', mut: '#adb3cb', faint: '#6272a4',
      accent: '#bd93f9', accent2: '#8be9fd',
      ok: '#50fa7b', warn: '#f1fa8c', alert: '#ffb86c',
      onAccent: '#282a36', sel: '#44475a', cursor: '#f8f8f2',
    },
    ansi: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
    ],
  },

  monokai: {
    id: 'monokai',
    name: 'Monokai',
    mode: 'dark',
    colors: {
      bg: '#272822', surface: '#1e1f1c', surface2: '#34352f', edge: '#3e3d32',
      ink: '#f8f8f2', mut: '#a6a28c', faint: '#75715e',
      accent: '#f92672', accent2: '#66d9ef',
      ok: '#a6e22e', warn: '#e6db74', alert: '#fd971f',
      onAccent: '#ffffff', sel: '#49483e', cursor: '#f8f8f0',
    },
    ansi: [
      '#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5',
    ],
  },

  'github-dark': {
    id: 'github-dark',
    name: 'GitHub Dark',
    mode: 'dark',
    colors: {
      bg: '#0d1117', surface: '#161b22', surface2: '#21262d', edge: '#30363d',
      ink: '#e6edf3', mut: '#8b949e', faint: '#6e7681',
      accent: '#2f81f7', accent2: '#a371f7',
      ok: '#3fb950', warn: '#d29922', alert: '#db6d28',
      onAccent: '#ffffff', sel: '#264f78', cursor: '#2f81f7',
    },
    ansi: [
      '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
      '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
    ],
  },

  'tokyo-night': {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    colors: {
      bg: '#1a1b26', surface: '#16161e', surface2: '#24283b', edge: '#292e42',
      ink: '#c0caf5', mut: '#9aa5ce', faint: '#565f89',
      accent: '#7aa2f7', accent2: '#bb9af7',
      ok: '#9ece6a', warn: '#e0af68', alert: '#ff9e64',
      onAccent: '#16161e', sel: '#33467c', cursor: '#c0caf5',
    },
    ansi: [
      '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
    ],
  },

  'catppuccin-mocha': {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    colors: {
      bg: '#1e1e2e', surface: '#181825', surface2: '#313244', edge: '#313244',
      ink: '#cdd6f4', mut: '#a6adc8', faint: '#6c7086',
      accent: '#cba6f7', accent2: '#89b4fa',
      ok: '#a6e3a1', warn: '#f9e2af', alert: '#fab387',
      onAccent: '#1e1e2e', sel: '#45475a', cursor: '#f5e0dc',
    },
    ansi: [
      '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
    ],
  },

  nord: {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    colors: {
      bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', edge: '#4c566a',
      ink: '#eceff4', mut: '#d8dee9', faint: '#7b88a1',
      accent: '#88c0d0', accent2: '#81a1c1',
      ok: '#a3be8c', warn: '#ebcb8b', alert: '#d08770',
      onAccent: '#2e3440', sel: '#434c5e', cursor: '#d8dee9',
    },
    ansi: [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
    ],
  },

  'gruvbox-dark': {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    mode: 'dark',
    colors: {
      bg: '#282828', surface: '#32302f', surface2: '#3c3836', edge: '#504945',
      ink: '#ebdbb2', mut: '#bdae93', faint: '#928374',
      accent: '#fabd2f', accent2: '#83a598',
      ok: '#b8bb26', warn: '#d79921', alert: '#fe8019',
      onAccent: '#282828', sel: '#504945', cursor: '#ebdbb2',
    },
    ansi: [
      '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
    ],
  },

  'solarized-dark': {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    colors: {
      bg: '#002b36', surface: '#073642', surface2: '#0a4250', edge: '#0a4a5a',
      ink: '#eee8d5', mut: '#93a1a1', faint: '#586e75',
      accent: '#268bd2', accent2: '#2aa198',
      ok: '#859900', warn: '#b58900', alert: '#cb4b16',
      onAccent: '#fdf6e3', sel: '#0a4a5a', cursor: '#839496',
    },
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3',
    ],
  },

  'night-owl': {
    id: 'night-owl',
    name: 'Night Owl',
    mode: 'dark',
    colors: {
      bg: '#011627', surface: '#0b2942', surface2: '#1d3b53', edge: '#122d42',
      ink: '#d6deeb', mut: '#8fa8bf', faint: '#5f7e97',
      accent: '#82aaff', accent2: '#7fdbca',
      ok: '#addb67', warn: '#ecc48d', alert: '#f78c6c',
      onAccent: '#011627', sel: '#1d3b53', cursor: '#80a4c2',
    },
    ansi: [
      '#011627', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#ffffff',
      '#575656', '#ef5350', '#22da6e', '#ffeb95', '#82aaff', '#c792ea', '#7fdbca', '#ffffff',
    ],
  },

  'ayu-mirage': {
    id: 'ayu-mirage',
    name: 'Ayu Mirage',
    mode: 'dark',
    colors: {
      bg: '#1f2430', surface: '#232834', surface2: '#2c3242', edge: '#323a4c',
      ink: '#cccac2', mut: '#a0a7b4', faint: '#707a8c',
      accent: '#ffcc66', accent2: '#73d0ff',
      ok: '#bae67e', warn: '#ffd173', alert: '#ffad66',
      onAccent: '#1f2430', sel: '#33415e', cursor: '#ffcc66',
    },
    ansi: [
      '#191e2a', '#f28779', '#bae67e', '#ffd173', '#73d0ff', '#dfbfff', '#95e6cb', '#cbccc6',
      '#707a8c', '#f28779', '#bae67e', '#ffd173', '#73d0ff', '#dfbfff', '#95e6cb', '#ffffff',
    ],
  },

  'rose-pine': {
    id: 'rose-pine',
    name: 'Rosé Pine',
    mode: 'dark',
    colors: {
      bg: '#191724', surface: '#1f1d2e', surface2: '#26233a', edge: '#403d52',
      ink: '#e0def4', mut: '#908caa', faint: '#6e6a86',
      accent: '#c4a7e7', accent2: '#ebbcba',
      ok: '#9ccfd8', warn: '#f6c177', alert: '#eb6f92',
      onAccent: '#191724', sel: '#403d52', cursor: '#e0def4',
    },
    ansi: [
      '#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4',
      '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4',
    ],
  },

  'synthwave-84': {
    id: 'synthwave-84',
    name: "Synthwave '84",
    mode: 'dark',
    colors: {
      bg: '#262335', surface: '#241b2f', surface2: '#2a2139', edge: '#34294f',
      ink: '#f0eff1', mut: '#b6b1d6', faint: '#848bbd',
      accent: '#ff7edb', accent2: '#36f9f6',
      ok: '#72f1b8', warn: '#fede5d', alert: '#ff8b39',
      onAccent: '#241b2f', sel: '#3b2f5e', cursor: '#ff7edb',
    },
    ansi: [
      '#241b2f', '#fe4450', '#72f1b8', '#fede5d', '#03edf9', '#ff7edb', '#36f9f6', '#f0eff1',
      '#848bbd', '#fe4450', '#72f1b8', '#fede5d', '#03edf9', '#ff7edb', '#36f9f6', '#ffffff',
    ],
  },

  'github-light': {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    colors: {
      bg: '#ffffff', surface: '#f6f8fa', surface2: '#eaeef2', edge: '#d0d7de',
      ink: '#1f2328', mut: '#57606a', faint: '#8c959f',
      accent: '#0969da', accent2: '#8250df',
      ok: '#1a7f37', warn: '#9a6700', alert: '#bc4c00',
      onAccent: '#ffffff', sel: '#b3d4fc', cursor: '#0969da',
    },
    ansi: [
      '#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f',
    ],
  },

  'solarized-light': {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    colors: {
      bg: '#fdf6e3', surface: '#eee8d5', surface2: '#e3ddc8', edge: '#d3cbb7',
      ink: '#586e75', mut: '#657b83', faint: '#93a1a1',
      accent: '#268bd2', accent2: '#2aa198',
      ok: '#859900', warn: '#b58900', alert: '#cb4b16',
      onAccent: '#fdf6e3', sel: '#c9e0ea', cursor: '#586e75',
    },
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#93a1a1', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3',
    ],
  },
};

export const THEME_LIST = Object.values(THEMES);
const DEFAULT_ID = 'terracotta';
const STORAGE_KEY = 'themeId';
const DRIFT_KEY = 'themeDrift'; // '1' = ambient auto-cycle on
const DRIFT_AT_KEY = 'themeDriftAt'; // epoch ms of the last automatic change
export const DRIFT_MINUTES = 30;
const DRIFT_MS = DRIFT_MINUTES * 60 * 1000;

let currentId = DEFAULT_ID;
const listeners = new Set<() => void>();

export function currentTheme(): Theme {
  return THEMES[currentId] ?? THEMES[DEFAULT_ID];
}

/** Set every --color and --ansi custom property on <html> and notify subscribers. */
export function applyTheme(id: string): void {
  const theme = THEMES[id] ?? THEMES[DEFAULT_ID];
  currentId = theme.id;
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch { /* private mode */ }

  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const c = theme.colors;
  set('--color-bg', c.bg);
  set('--color-surface', c.surface);
  set('--color-surface2', c.surface2);
  set('--color-edge', c.edge);
  set('--color-ink', c.ink);
  set('--color-mut', c.mut);
  set('--color-faint', c.faint);
  set('--color-claude', c.accent);
  set('--color-codex', c.accent2);
  set('--color-ok', c.ok);
  set('--color-warn', c.warn);
  set('--color-alert', c.alert);
  set('--color-on-accent', c.onAccent);
  set('--color-sel', c.sel);
  ANSI_SLOTS.forEach((slot, i) => set(`--ansi-${slot}`, theme.ansi[i]));
  root.dataset.theme = theme.id;
  root.dataset.mode = theme.mode;
  root.style.colorScheme = theme.mode;
  listeners.forEach((fn) => fn());
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch { /* private mode */ }
};

/** Deterministic per-day pick so a reload keeps the same "theme of the day". */
export function themeForDate(dateStr: string): string {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (hash * 31 + dateStr.charCodeAt(i)) >>> 0;
  }
  return THEME_LIST[hash % THEME_LIST.length].id;
}

/** A random theme id different from `exclude`. */
export function randomThemeId(exclude?: string): string {
  const pool = THEME_LIST.filter((t) => t.id !== exclude);
  const list = pool.length ? pool : THEME_LIST;
  return list[Math.floor(Math.random() * list.length)].id;
}

/** The id after `current` in THEME_LIST, wrapping around. */
export function nextThemeId(current: string): string {
  const i = THEME_LIST.findIndex((t) => t.id === current);
  return THEME_LIST[(i + 1) % THEME_LIST.length].id;
}

// Ambient drift: only sets CSS custom properties + xterm options via the
// normal applyTheme path, so open terminals restyle in place — a drift tick
// never remounts a pane or drops a WebSocket (the wall must stay undisturbed).
let driftTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDrift(delayMs: number): void {
  if (driftTimer) clearTimeout(driftTimer);
  driftTimer = setTimeout(() => {
    applyTheme(randomThemeId(currentId));
    write(DRIFT_AT_KEY, String(Date.now()));
    scheduleDrift(DRIFT_MS);
  }, Math.max(5000, delayMs));
}

export function isDrifting(): boolean {
  return read(DRIFT_KEY) !== '0';
}

/** Turn ambient auto-cycling on/off. Turning it on grants a fresh full interval. */
export function setDrift(on: boolean): void {
  write(DRIFT_KEY, on ? '1' : '0');
  if (on) {
    write(DRIFT_AT_KEY, String(Date.now()));
    scheduleDrift(DRIFT_MS);
  } else if (driftTimer) {
    clearTimeout(driftTimer);
    driftTimer = null;
  }
  listeners.forEach((fn) => fn());
}

/** Explicit pick from the theme list: apply it and pin (stop drifting). */
export function pickTheme(id: string): void {
  applyTheme(id);
  setDrift(false);
}

/** Advance to the next theme now; if drifting, the clock resets to a full interval. */
export function nudgeTheme(): void {
  applyTheme(nextThemeId(currentId));
  if (isDrifting()) {
    write(DRIFT_AT_KEY, String(Date.now()));
    scheduleDrift(DRIFT_MS);
  }
}

/**
 * Restore the saved theme on startup. When drifting: a new day starts on the
 * day's deterministic pick, otherwise the saved theme continues with whatever
 * remains of its 30-minute slot.
 */
export function initTheme(): void {
  const saved = read(STORAGE_KEY);
  if (!isDrifting()) {
    applyTheme(saved ?? DEFAULT_ID);
    return;
  }
  const driftAt = Number(read(DRIFT_AT_KEY) ?? 0);
  const dayRolled = !driftAt || new Date(driftAt).toDateString() !== new Date().toDateString();
  if (!saved || dayRolled) {
    applyTheme(themeForDate(new Date().toDateString()));
    write(DRIFT_AT_KEY, String(Date.now()));
    scheduleDrift(DRIFT_MS);
  } else {
    applyTheme(saved);
    scheduleDrift(driftAt + DRIFT_MS - Date.now());
  }
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const ANSI_SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
] as const;

/** The active theme as an xterm.js ITheme. */
export function xtermTheme() {
  const { colors: c, ansi } = currentTheme();
  return {
    background: c.bg,
    foreground: c.ink,
    cursor: c.cursor,
    cursorAccent: c.bg,
    selectionBackground: c.sel,
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15],
  };
}
