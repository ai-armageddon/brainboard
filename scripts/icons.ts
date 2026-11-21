// Regenerate the app icons in public/ from the brand mark: node scripts/icons.ts
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { markGlyph } from '../src/brand.ts';

const INK = '#0a0a0a';
const PAPER = '#fafafa';

const mark = (pad: number, round: boolean) => {
  const s = 32 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${s} ${s}">
  ${round ? `<rect width="32" height="32" rx="2" fill="${INK}"/>` : `<rect x="${-pad}" y="${-pad}" width="${s}" height="${s}" fill="${INK}"/>`}
  ${markGlyph(PAPER)}
</svg>`;
};
const png = (svg: string, size: number) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

// The favicon flips to a light tile on dark browser chrome.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>svg{color:${PAPER}}.t{fill:${INK}}@media (prefers-color-scheme:dark){svg{color:${INK}}.t{fill:${PAPER}}}</style>
  <rect class="t" width="32" height="32" rx="2"/>
  ${markGlyph('currentColor')}
</svg>`;

writeFileSync('public/favicon.svg', favicon);
writeFileSync('public/icon-192.png', png(mark(0, true), 192));
writeFileSync('public/icon-512.png', png(mark(0, true), 512));
writeFileSync('public/icon-maskable-512.png', png(mark(6, false), 512)); // full-bleed for Android masks
writeFileSync('public/apple-touch-icon.png', png(mark(3, false), 180));
console.log('icons written to public/');
