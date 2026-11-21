// Render a board (or part of it) to PNG so multimodal agents can see what the user sees.
import { Resvg } from '@resvg/resvg-js';
import { textSpans } from '../src/text-runs.ts';
import { FONTS, type Box, type ColorKey, type Item, type NodeItem, type TextualItem, type EdgeItem } from '../src/types.ts';
import { edgeGeom, shapePath, inkPath, unionBox } from '../src/geometry.ts';
import { imageSize, readImage, type Board } from './store.ts';
import { SHAPE_TEXT_W, isEdge, isNode, wrapLines } from './agent.ts';

export type Theme = 'light' | 'dark';

/** Colours match the app's light and dark themes. */
const PALETTE: Record<Theme, { fill: Record<ColorKey, string>; ink: Record<ColorKey, string>; bg: string; text: string; label: string; placeholder: string; noteEdge: string }> = {
  light: {
    fill: { ink: '#ffffff', gray: '#f0f0f0', red: '#ffe1e3', orange: '#ffe7cf', yellow: '#fff2a8', green: '#d8f5e1', blue: '#dbecff', purple: '#ece2ff' },
    ink: { ink: '#0a0a0a', gray: '#8a8a8a', red: '#e5484d', orange: '#f0701f', yellow: '#cf9d00', green: '#2f9e5e', blue: '#1a82f0', purple: '#8b4fd0' },
    bg: '#fafafa', text: '#0a0a0a', label: '#525252', placeholder: '#e8e8e8', noteEdge: 'rgba(0,0,0,0.07)',
  },
  dark: {
    fill: { ink: '#141414', gray: '#262626', red: '#47252a', orange: '#48301f', yellow: '#463d1c', green: '#1e3c2a', blue: '#1b334f', purple: '#33294b' },
    ink: { ink: '#fafafa', gray: '#9a9a9a', red: '#ff6b70', orange: '#ff8d45', yellow: '#f2c84b', green: '#4cc38a', blue: '#5aaeff', purple: '#b48cf2' },
    bg: '#0a0a0a', text: '#fafafa', label: '#a3a3a3', placeholder: '#262626', noteEdge: 'rgba(255,255,255,0.08)',
  },
};
const FONT = "'Geist Variable', Geist, Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => Math.round(v * 100) / 100;

function textBlock(lines: string[], x: number, y: number, fs: number, lh: number, fill: string, anchor: 'start' | 'middle', weight = 400, item?: TextualItem | EdgeItem) {
  const text = item?.type === 'edge' ? item.label : item?.text ?? '';
  const pieces = item?.runs?.length ? [...textSpans(text, item.runs)] : [];
  let offset = 0, piece = 0;
  function lineContent(line: string) {
    if (!pieces.length || !line) return esc(line) || ' ';
    const start = text.indexOf(line, offset);
    if (start < 0) return esc(line);
    offset = start + line.length;
    let content = '';
    while (piece < pieces.length) {
      const { start: a, end: b, style } = pieces[piece];
      if (a >= offset) break;
      if (b > start) {
        const value = esc(text.slice(Math.max(a, start), Math.min(b, offset)));
        const face = style.font && Object.hasOwn(FONTS, style.font) ? FONTS[style.font][1] : '';
        content += `<tspan${face ? ` font-family="${esc(face)}"` : ''}${style.bold ? ' font-weight="700"' : ''}${style.underline ? ' text-decoration="underline"' : ''}>${value}</tspan>`;
      }
      if (b > offset) break;
      piece++;
    }
    return content;
  }
  const spans = lines.map((l, i) => `<tspan x="${n(x)}" dy="${i ? n(lh) : 0}">${lineContent(l)}</tspan>`).join('');
  return `<text x="${n(x)}" y="${n(y)}" font-family="${esc(FONT)}" font-size="${n(fs)}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${spans}</text>`;
}

async function nodeSvg(it: NodeItem, P: (typeof PALETTE)[Theme]): Promise<string> {
  switch (it.type) {
    case 'note': {
      const fs = it.fs, padX = fs * 1.05, padY = fs * 0.95, lh = fs * 1.38;
      const lines = wrapLines(it.text, fs, it.w - padX * 2);
      const h = Math.max(it.h, lines.length * lh + padY * 2);
      return `<rect x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(h)}" rx="${n(fs * 0.08)}" fill="${P.fill[it.color]}" stroke="${P.noteEdge}"/>` +
        textBlock(lines, it.x + padX, it.y + padY + fs * 1.0, fs, lh, P.text, 'start', 400, it);
    }
    case 'text': {
      const lh = it.fs * 1.25;
      return textBlock(it.text.split('\n'), it.x + it.fs * 0.15, it.y + it.fs * 1.0, it.fs, lh, P.ink[it.color], 'start', 500, it);
    }
    case 'shape': {
      const sw = it.fs / 8, lh = it.fs * 1.38;
      const lines = wrapLines(it.text, it.fs, it.w * SHAPE_TEXT_W[it.shape] - it.fs * 1.4);
      const top = it.y + it.h / 2 - (lines.length * lh) / 2 + it.fs * 0.98;
      return `<path transform="translate(${n(it.x)} ${n(it.y)})" d="${shapePath(it.shape, it.w, it.h, sw / 2)}" fill="${P.fill[it.color]}" stroke="${P.ink[it.color]}" stroke-width="${n(sw)}" stroke-linejoin="round"/>` +
        textBlock(lines, it.x + it.w / 2, top, it.fs, lh, P.text, 'middle', 500, it);
    }
    case 'image': {
      const img = await readImage(it.blob);
      const ph = `<rect x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" rx="2" fill="${P.placeholder}"/>`;
      if (!img) return ph;
      return ph + `<image x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" preserveAspectRatio="xMidYMid slice" href="data:${img.mime};base64,${img.buf.toString('base64')}"/>`;
    }
    case 'stroke':
      if (it.outline) return `<path transform="translate(${n(it.x)} ${n(it.y)})" d="${inkPath(it)}" fill="${P.ink[it.color]}" fill-rule="evenodd"/>`;
      return `<path transform="translate(${n(it.x)} ${n(it.y)})" d="${inkPath(it)}" fill="none" stroke="${P.ink[it.color]}" stroke-width="${n(it.size)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
}

export interface SvgOpts {
  ids?: string[];
  showIds?: boolean;
  theme?: Theme;
  /** paint the theme background (default) or leave it transparent */
  background?: boolean;
  /** id-tag size depends on the final pixel scale */
  idScale?: number;
}

/** The board (or some of its items) as a standalone SVG document, or null when there's nothing to draw. */
export async function boardSvg(b: Board, opts: SvgOpts = {}): Promise<{ svg: string; box: Box } | null> {
  const P = PALETTE[opts.theme ?? 'light'];
  const want = opts.ids?.length ? new Set(opts.ids) : null;
  const nodes = b.items.filter((i): i is NodeItem => isNode(i) && (!want || want.has(i.id)));
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((x) => x.id));
  const byId = new Map<string, Item>(b.items.map((i) => [i.id, i]));
  const edges = b.items.filter(isEdge).filter((e) => ids.has(e.from) && ids.has(e.to));

  const raw = unionBox(nodes);
  const pad = Math.max(40, Math.max(raw.w, raw.h) * 0.03);
  const box = { x: raw.x - pad, y: raw.y - pad, w: raw.w + pad * 2, h: raw.h + pad * 2 };

  const parts: string[] = [];
  for (const e of edges) {
    const a = byId.get(e.from) as NodeItem, c = byId.get(e.to) as NodeItem;
    const g = edgeGeom(a, c, e.sw);
    parts.push(`<path d="${g.d}" fill="none" stroke="${P.ink[e.color]}" stroke-width="${n(e.sw)}" stroke-linecap="round"/><path d="${g.arrow}" fill="${P.ink[e.color]}"/>`);
  }
  for (const it of nodes) parts.push(await nodeSvg(it, P));
  for (const e of edges) {
    if (!e.label) continue;
    const g = edgeGeom(byId.get(e.from) as NodeItem, byId.get(e.to) as NodeItem, e.sw);
    const lines = e.label.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * e.fs * 0.56 + e.fs * 1.1;
    const h = lines.length * e.fs * 1.3 + e.fs * 0.36;
    parts.push(`<rect x="${n(g.mid.x - w / 2)}" y="${n(g.mid.y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(e.fs * 0.25)}" fill="${P.bg}"/>` +
      textBlock(lines, g.mid.x, g.mid.y - h / 2 + e.fs * 1.12, e.fs, e.fs * 1.3, P.label, 'middle', 500, e));
  }
  if (opts.showIds) {
    const fs = 11 / (opts.idScale ?? 1);
    for (const it of [...nodes, ...edges]) {
      const at = isEdge(it)
        ? (({ x, y }) => ({ x: x - it.id.length * fs * 0.31, y: y + it.fs * 0.9 }))(edgeGeom(byId.get(it.from) as NodeItem, byId.get(it.to) as NodeItem, it.sw).mid)
        : { x: it.x, y: it.y - fs * 1.6 };
      const w = it.id.length * fs * 0.62 + fs;
      parts.push(`<rect x="${n(at.x)}" y="${n(at.y)}" width="${n(w)}" height="${n(fs * 1.45)}" rx="${n(fs * 0.3)}" fill="#4f6bff"/>` +
        textBlock([it.id], at.x + fs * 0.5, at.y + fs * 1.08, fs, fs, '#ffffff', 'start', 600));
    }
  }
  const bg = opts.background === false ? '' : `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="${P.bg}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" width="${n(box.w)}" height="${n(box.h)}">${bg}${parts.join('')}</svg>`;
  return { svg, box };
}

/** Rasterise an SVG from boardSvg at `scale` pixels per board unit. */
export function rasterize(svg: string, width: number) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  }).render();
}

export interface RenderOpts {
  ids?: string[];
  maxSize?: number;
  showIds?: boolean;
}

/** PNG for agents (light theme), or null when there is nothing to draw. */
export async function renderBoard(b: Board, opts: RenderOpts = {}): Promise<{ png: Buffer; box: Box; scale: number } | null> {
  const probe = await boardSvg(b, { ids: opts.ids });
  if (!probe) return null;
  const maxSize = Math.min(Math.max(opts.maxSize ?? 1600, 256), 4096);
  const scale = Math.min(maxSize / Math.max(probe.box.w, probe.box.h), 2);
  const out = opts.showIds ? (await boardSvg(b, { ids: opts.ids, showIds: true, idScale: scale }))! : probe;
  return { png: rasterize(out.svg, out.box.w * scale).asPng(), box: out.box, scale };
}

/** Image bytes suitable for handing to a model: large or exotic images are re-encoded smaller. */
export async function imageForModel(blob: string, maxSize = 1568): Promise<{ data: Buffer; mime: string } | null> {
  const img = await readImage(blob);
  if (!img) return null;
  const size = imageSize(img.buf);
  const friendly = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(img.mime);
  if (friendly && img.buf.length < 3_500_000 && size && Math.max(size.w, size.h) <= 2400) return { data: img.buf, mime: img.mime };
  const w = size?.w ?? 1200, h = size?.h ?? 900;
  const href = `data:${img.mime};base64,${img.buf.toString('base64')}`;
  const svg = img.mime === 'image/svg+xml'
    ? img.buf.toString('utf8')
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="${href}"/></svg>`;
  const k = Math.min(1, maxSize / Math.max(w, h));
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: Math.max(1, Math.round(w * k)) } }).render().asPng();
  return { data: png, mime: 'image/png' };
}
