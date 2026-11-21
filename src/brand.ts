// Brainboard mark: a geometric lowercase "b" (stem + bubble) beside a square node, on a sharp tile.
// Monochrome: the tile is the foreground colour and the glyph is the background colour, so it inverts with the theme.

/** Glyph geometry, shared with scripts/icons.ts. `ink` paints the glyph. */
export function markGlyph(ink: string) {
  return `<path d="M9 6.5V18" stroke="${ink}" stroke-width="3.2"/>
  <circle cx="15" cy="18.5" r="6" fill="none" stroke="${ink}" stroke-width="3.2"/>
  <rect x="20.2" y="6.5" width="4.3" height="4.3" fill="${ink}"/>`;
}

export function logoSvg(size = 32): string {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">
  <rect width="32" height="32" rx="2" fill="var(--logo-tile)"/>
  ${markGlyph('var(--logo-ink)')}
</svg>`;
}

/** Fill every `.logo` placeholder in the page (and any added later via `root`). */
export function paintLogos(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.logo:empty').forEach((el) => {
    el.innerHTML = logoSvg();
  });
}

export const WORDMARK = '<span class="wordmark">brain<span>board</span></span>';
