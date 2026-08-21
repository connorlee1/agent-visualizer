/**
 * Platform-aware hotkey helpers. Bindings match on e.code (physical keys,
 * layout-independent — macOS turns ⌥+letter into accent characters, Linux
 * Alt doesn't, and neither matters to e.code). Labels render mac glyphs
 * (⌥S, ⌘K) on macOS and PC-style names (Alt+S, Ctrl+K) elsewhere.
 *
 * Cross-platform notes the bindings encode:
 * - ⌥Tab never reaches the browser on Windows/Linux (the OS app switcher
 *   owns it), so panel cycling also answers to ⌥]/⌥[ — free everywhere.
 * - Super/meta chords are the tiling-WM convention on Linux, but the WM
 *   grabs them before the browser sees them; Alt is the usable modifier.
 */
export const isMac = /Mac|iP/.test(navigator.platform);

/** A bare ⌥/Alt chord: alt held, no other modifiers. */
export const altOnly = (e: KeyboardEvent): boolean =>
  e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;

/** ⌥S on mac, Alt+S elsewhere. */
export const altLabel = (k: string): string => (isMac ? `⌥${k}` : `Alt+${k}`);

/** ⌘K on mac, Ctrl+K elsewhere (the platform's primary shortcut modifier). */
export const modLabel = (k: string): string => (isMac ? `⌘${k}` : `Ctrl+${k}`);

/**
 * Panel-cycle direction for a keydown, or 0. ⌥Tab/⌥⇧Tab where the OS allows
 * it (macOS), ⌥]/⌥[ everywhere.
 */
export const cycleDir = (e: KeyboardEvent): -1 | 0 | 1 => {
  if (!e.altKey || e.metaKey || e.ctrlKey) return 0;
  if (e.key === 'Tab') return e.shiftKey ? -1 : 1;
  if (e.shiftKey) return 0;
  if (e.code === 'BracketRight') return 1;
  if (e.code === 'BracketLeft') return -1;
  return 0;
};

/** Cheatsheet/hint label for the panel-cycle keys. */
export const cycleLabel = (): string => (isMac ? '⌥⇥ · ⌥] / ⌥[' : 'Alt+] / Alt+[');
