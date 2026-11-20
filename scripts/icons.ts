// Regenerate the app icons in public/ from the brand mark: node scripts/icons.ts
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const mark = (pad: number, round: boolean) => {
  const s = 32 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${s} ${s}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#9a5cf5"/></linearGradient></defs>
  ${round ? '<rect width="32" height="32" rx="9" fill="url(#g)"/>' : `<rect x="${-pad}" y="${-pad}" width="${s}" height="${s}" fill="url(#g)"/>`}
  <path d="M10.4 7.6V18.4" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="16.4" cy="18.4" r="6" fill="none" stroke="#fff" stroke-width="3.4"/>
  <path d="M20.6 13.9 22.5 11" stroke="#fff" stroke-opacity=".75" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="23.9" cy="8.6" r="2.5" fill="#fff" fill-opacity=".92"/>
</svg>`;
};
const png = (svg: string, size: number) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

writeFileSync('public/favicon.svg', mark(0, true));
writeFileSync('public/icon-192.png', png(mark(0, true), 192));
writeFileSync('public/icon-512.png', png(mark(0, true), 512));
writeFileSync('public/icon-maskable-512.png', png(mark(6, false), 512)); // full-bleed for Android masks
writeFileSync('public/apple-touch-icon.png', png(mark(3, false), 180));
console.log('icons written to public/');
