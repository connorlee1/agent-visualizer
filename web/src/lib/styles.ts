/**
 * Styles: the shape layer of the skin — typography, corner radii, border
 * treatment, glyphs, and whitelisted page effects. Orthogonal to color
 * themes (lib/themes.ts): any style can wear any palette, so 5 styles ×
 * 16 palettes come free. Styles are pinned — the 30-minute drift only ever
 * hops palettes, never styles (fonts/radii shifting under you while you
 * watch the wall would be disorienting, and font swaps refit terminals).
 *
 * Everything a style does is data → CSS custom properties, applied by
 * applyStyle in lib/themes.ts through the same channel as palettes. That is
 * what keeps a style hop safe for the wall: nothing remounts, no WebSocket
 * drops — the same contract drift ticks honor.
 *
 * Effects are a WHITELIST implemented once in index.css and opted into via
 * data-fx on <html>; styles never ship CSS. Page washes
 * (scanlines / parchment / vignette / horizon) share body::after — at most
 * ONE per style; 'grain' has its own body::before slot; the selector-only
 * effects (glow / pixel / ornate / soft) compose freely.
 */

export interface Style {
  id: string;
  name: string;
  /** One-liner shown in the picker. */
  tagline: string;
  fonts: {
    /** Identity surfaces: wordmark, page headers, agent names. */
    display: string;
    /** Every other piece of UI text — nav, rows, readouts, transcripts,
     *  buttons. Only true code/terminal surfaces (font-mono) are exempt,
     *  since those need a monospace grid in every style. */
    body: string;
    /** xterm font — null keeps the app default. Must be a real monospace
     *  face; most styles leave the terminal alone. */
    terminal: string | null;
    /** xterm font size (null = the default 13). The canvas renderer can't
     *  use font-size-adjust, so small faces compensate here instead. */
    terminalSize: number | null;
    /** CSS font-size-adjust for body text (null = none). Small-x-height
     *  faces (VT323, the serifs) render unreadably small at the app's
     *  10–13px sizes; this normalizes their visual size to the mono
     *  default's ≈0.54 aspect instead of bumping every text-[*] class. */
    adjust: string | null;
  };
  /** CSS lengths for the three radius tiers. */
  radius: { chip: string; pane: string; panel: string };
  border: { width: string; style: 'solid' | 'double' | 'dashed' };
  /** CSS-content strings — rendered via .g-* ::before rules so a style hop
   *  re-glyphs every readout without a React re-render. */
  glyphs: {
    prompt: string; // ❯ — wordmark, composer, hover rows, "You" header
    agent: string;  // ⏺ — assistant header
    working: string;
    approval: string;
    waiting: string;
    exited: string;
    shell: string;
    offline: string;
  };
  effects: Array<
    | 'scanlines' // CRT raster + bezel shading (::after wash)
    | 'parchment' // sepia vignette + paper mottle (::after wash)
    | 'vignette'  // lantern-lit dark edges (::after wash)
    | 'horizon'   // synthwave floor grid behind content (::after wash)
    | 'grain'     // film/paper noise (::before, rides any wash)
    | 'glow'      // neon halos, tinted rest borders, wide caps
    | 'pixel'     // stepped hard shadows, shouty headers
    | 'ornate'    // small caps, drop caps, fleuron rules
    | 'soft'      // lifted shadows, stitched seams, italic display
  >;
}

const MONO = `'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace`;

export const STYLES: Record<string, Style> = {
  console: {
    id: 'console',
    name: 'Console',
    tagline: 'the factory skin — tight radii, mono everywhere',
    fonts: { display: MONO, body: MONO, terminal: null, terminalSize: null, adjust: null },
    radius: { chip: '4px', pane: '5px', panel: '12px' },
    border: { width: '1px', style: 'solid' },
    glyphs: {
      prompt: '❯', agent: '⏺',
      working: '●', approval: '▲', waiting: '◌', exited: '■', shell: '·', offline: '⌁',
    },
    effects: [],
  },

  arcade: {
    id: 'arcade',
    name: '8-Bit Arcade',
    tagline: 'square corners, pixel type everywhere, CRT scanlines',
    // Press Start 2P is unreadable at body sizes; VT323 is the readable
    // pixel face — and a true monospace, so it can carry the terminals too.
    fonts: {
      display: `'Press Start 2P', ${MONO}`,
      body: `'VT323', ${MONO}`,
      terminal: `VT323, JetBrains Mono, Menlo, monospace`,
      terminalSize: 16,
      adjust: '0.54',
    },
    radius: { chip: '0px', pane: '0px', panel: '0px' },
    border: { width: '2px', style: 'solid' },
    glyphs: {
      prompt: '▶', agent: '◆',
      working: '►', approval: '‼', waiting: '…', exited: '□', shell: '·', offline: '✕',
    },
    effects: ['scanlines', 'pixel'],
  },

  neon: {
    id: 'neon',
    name: 'Neon',
    tagline: 'tinted halos on everything, a grid on the horizon',
    fonts: { display: MONO, body: MONO, terminal: null, terminalSize: null, adjust: null },
    radius: { chip: '1px', pane: '2px', panel: '4px' },
    border: { width: '1px', style: 'solid' },
    glyphs: {
      prompt: '❯', agent: '◉',
      working: '●', approval: '▲', waiting: '◌', exited: '■', shell: '·', offline: '⌁',
    },
    effects: ['glow', 'horizon'],
  },

  manuscript: {
    id: 'manuscript',
    name: 'Manuscript',
    tagline: 'drop caps, small caps, double-ruled parchment',
    fonts: {
      display: `'Luminari', 'Palatino', Georgia, serif`,
      body: `'Palatino', 'Iowan Old Style', Georgia, serif`,
      terminal: null,
      terminalSize: null,
      adjust: '0.5',
    },
    radius: { chip: '2px', pane: '3px', panel: '6px' },
    border: { width: '3px', style: 'double' },
    glyphs: {
      prompt: '❧', agent: '✒',
      working: '✦', approval: '⚑', waiting: '☾', exited: '†', shell: '·', offline: '☓',
    },
    effects: ['parchment', 'ornate', 'grain'],
  },

  rustic: {
    id: 'rustic',
    name: 'Rustic',
    tagline: 'stitched seams, paper grain, lantern light',
    fonts: {
      display: `'Iowan Old Style', 'Palatino', Georgia, serif`,
      body: `'Iowan Old Style', 'Palatino', Georgia, serif`,
      terminal: null,
      terminalSize: null,
      adjust: '0.5',
    },
    radius: { chip: '8px', pane: '10px', panel: '16px' },
    border: { width: '1px', style: 'solid' },
    glyphs: {
      prompt: '»', agent: '✎',
      working: '●', approval: '▲', waiting: '◌', exited: '■', shell: '·', offline: '⌁',
    },
    effects: ['vignette', 'grain', 'soft'],
  },
};

export const STYLE_LIST = Object.values(STYLES);
export const DEFAULT_STYLE_ID = 'console';
