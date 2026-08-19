/**
 * Per-directory accent colors: every pane/card showing an agent from the same
 * project directory gets the same border tint, so parallel agents on one repo
 * read as a group at a glance.
 *
 * A raw hash→hue mapping produces confusably-close hues in practice (two real
 * dirs landed at 214° and 225°), so colors come from a small palette of
 * well-separated hues instead: each dir hashes to a preferred slot, and
 * collisions probe to the next slot. Assignment runs over the sorted distinct
 * dir set, so a given set of dirs always maps to the same colors — across
 * renders and reloads.
 *
 * Each color is a light-dark() pair: the mid-light pastel that reads on dark
 * themes washes out against pale light-theme borders, so light mode gets a
 * darker, slightly stronger variant of the same hue. It resolves against the
 * color-scheme lib/themes.ts sets on <html> per theme, so tints track theme
 * drift live with no re-render.
 */

/** Palette hues, ordered so neighboring slots are far apart on the wheel —
 * a probed collision lands on a clearly different color. */
const HUES = [30, 210, 120, 300, 60, 240, 165, 345];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministically assign each distinct dir a palette color. */
export function dirColorMap(dirs: Iterable<string | undefined | null>): Map<string, string> {
  const distinct = [...new Set([...dirs].filter((d): d is string => !!d))].sort();
  const taken = new Set<number>();
  const map = new Map<string, string>();
  for (const dir of distinct) {
    let slot = hash(dir) % HUES.length;
    while (taken.has(slot) && taken.size < HUES.length) slot = (slot + 1) % HUES.length;
    taken.add(slot);
    const hue = HUES[slot];
    map.set(dir, `light-dark(oklch(0.5 0.16 ${hue}), oklch(0.68 0.14 ${hue}))`);
  }
  return map;
}

/** The tint blended toward the theme edge color — resting border strength. */
export function dimmed(color: string): string {
  return `color-mix(in srgb, ${color} 55%, var(--color-edge))`;
}
