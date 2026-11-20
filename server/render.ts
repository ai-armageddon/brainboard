// Render a board (or part of it) to PNG so multimodal agents can see what the user sees.
import { Resvg } from '@resvg/resvg-js';
import type { Box, ColorKey, Item, NodeItem } from '../src/types.ts';
import { edgeGeom, shapePath, strokePath, unionBox } from '../src/geometry.ts';
import { imageSize, readImage, type Board } from './store.ts';
import { SHAPE_TEXT_W, isEdge, isNode, wrapLines } from './agent.ts';

const FILL: Record<ColorKey, string> = {
  ink: '#ffffff', gray: '#eef0f2', red: '#ffe1e3', orange: '#ffe7cf', yellow: '#fff2a8', green: '#d8f5e1', blue: '#dbecff', purple: '#ece2ff',
};
const INK: Record<ColorKey, string> = {
  ink: '#1d2026', gray: '#8a919b', red: '#e5484d', orange: '#f0701f', yellow: '#cf9d00', green: '#2f9e5e', blue: '#1a82f0', purple: '#8b4fd0',
};
const BG = '#f5f5f2';
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => Math.round(v * 100) / 100;

function textBlock(lines: string[], x: number, y: number, fs: number, lh: number, fill: string, anchor: 'start' | 'middle', weight = 400) {
  const spans = lines.map((l, i) => `<tspan x="${n(x)}" dy="${i ? n(lh) : 0}">${esc(l) || ' '}</tspan>`).join('');
  return `<text x="${n(x)}" y="${n(y)}" font-family="${FONT}" font-size="${n(fs)}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${spans}</text>`;
}

async function nodeSvg(it: NodeItem): Promise<string> {
  switch (it.type) {
    case 'note': {
      const fs = it.fs, padX = fs * 1.05, padY = fs * 0.95, lh = fs * 1.38;
      const lines = wrapLines(it.text, fs, it.w - padX * 2);
      const h = Math.max(it.h, lines.length * lh + padY * 2);
      return `<rect x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(h)}" rx="${n(fs * 0.35)}" fill="${FILL[it.color]}" stroke="rgba(0,0,0,0.07)"/>` +
        textBlock(lines, it.x + padX, it.y + padY + fs * 1.0, fs, lh, '#1d2026', 'start');
    }
    case 'text': {
      const lh = it.fs * 1.25;
      return textBlock(it.text.split('\n'), it.x + it.fs * 0.15, it.y + it.fs * 1.0, it.fs, lh, INK[it.color], 'start', 500);
    }
    case 'shape': {
      const sw = it.fs / 8, lh = it.fs * 1.38;
      const lines = wrapLines(it.text, it.fs, it.w * SHAPE_TEXT_W[it.shape] - it.fs * 1.4);
      const top = it.y + it.h / 2 - (lines.length * lh) / 2 + it.fs * 0.98;
      return `<path transform="translate(${n(it.x)} ${n(it.y)})" d="${shapePath(it.shape, it.w, it.h, sw / 2)}" fill="${FILL[it.color]}" stroke="${INK[it.color]}" stroke-width="${n(sw)}" stroke-linejoin="round"/>` +
        textBlock(lines, it.x + it.w / 2, top, it.fs, lh, '#1d2026', 'middle', 500);
    }
    case 'image': {
      const img = await readImage(it.blob);
      const ph = `<rect x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" rx="6" fill="#e3e5e8"/>`;
      if (!img) return ph;
      return ph + `<image x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" preserveAspectRatio="xMidYMid slice" href="data:${img.mime};base64,${img.buf.toString('base64')}"/>`;
    }
    case 'stroke':
      return `<path transform="translate(${n(it.x)} ${n(it.y)})" d="${strokePath(it.points)}" fill="none" stroke="${INK[it.color]}" stroke-width="${n(it.size)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
}

export interface RenderOpts {
  ids?: string[];
  maxSize?: number;
  showIds?: boolean;
}

/** Returns a PNG, or null when there is nothing to draw. */
export async function renderBoard(b: Board, opts: RenderOpts = {}): Promise<{ png: Buffer; box: Box; scale: number } | null> {
  const want = opts.ids?.length ? new Set(opts.ids) : null;
  const nodes = b.items.filter((i): i is NodeItem => isNode(i) && (!want || want.has(i.id)));
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((x) => x.id));
  const byId = new Map<string, Item>(b.items.map((i) => [i.id, i]));
  const edges = b.items.filter(isEdge).filter((e) => ids.has(e.from) && ids.has(e.to));

  const raw = unionBox(nodes);
  const pad = Math.max(40, Math.max(raw.w, raw.h) * 0.03);
  const box = { x: raw.x - pad, y: raw.y - pad, w: raw.w + pad * 2, h: raw.h + pad * 2 };
  const maxSize = Math.min(Math.max(opts.maxSize ?? 1600, 256), 4096);
  const scale = Math.min(maxSize / Math.max(box.w, box.h), 2);

  const parts: string[] = [];
  for (const e of edges) {
    const a = byId.get(e.from) as NodeItem, c = byId.get(e.to) as NodeItem;
    const g = edgeGeom(a, c, e.sw);
    parts.push(`<path d="${g.d}" fill="none" stroke="${INK[e.color]}" stroke-width="${n(e.sw)}" stroke-linecap="round"/><path d="${g.arrow}" fill="${INK[e.color]}"/>`);
  }
  for (const it of nodes) parts.push(await nodeSvg(it));
  for (const e of edges) {
    if (!e.label) continue;
    const g = edgeGeom(byId.get(e.from) as NodeItem, byId.get(e.to) as NodeItem, e.sw);
    const lines = e.label.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * e.fs * 0.56 + e.fs * 1.1;
    const h = lines.length * e.fs * 1.3 + e.fs * 0.36;
    parts.push(`<rect x="${n(g.mid.x - w / 2)}" y="${n(g.mid.y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(e.fs * 0.6)}" fill="${BG}"/>` +
      textBlock(lines, g.mid.x, g.mid.y - h / 2 + e.fs * 1.12, e.fs, e.fs * 1.3, '#5a616d', 'middle', 500));
  }
  if (opts.showIds) {
    const fs = 11 / scale;
    for (const it of [...nodes, ...edges]) {
      const at = isEdge(it)
        ? (({ x, y }) => ({ x: x - it.id.length * fs * 0.31, y: y + it.fs * 0.9 }))(edgeGeom(byId.get(it.from) as NodeItem, byId.get(it.to) as NodeItem, it.sw).mid)
        : { x: it.x, y: it.y - fs * 1.6 };
      const w = it.id.length * fs * 0.62 + fs;
      parts.push(`<rect x="${n(at.x)}" y="${n(at.y)}" width="${n(w)}" height="${n(fs * 1.45)}" rx="${n(fs * 0.3)}" fill="#4f6bff"/>` +
        textBlock([it.id], at.x + fs * 0.5, at.y + fs * 1.08, fs, fs, '#ffffff', 'start', 600));
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" width="${n(box.w)}" height="${n(box.h)}"><rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="${BG}"/>${parts.join('')}</svg>`;
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(box.w * scale)) },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  }).render().asPng();
  return { png, box, scale };
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
