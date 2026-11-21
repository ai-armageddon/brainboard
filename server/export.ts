// Board exports: PNG, PDF, SVG, Markdown and the re-importable brainboard file.
import zlib from 'node:zlib';
import type { Board } from './store.ts';
import { readImage } from './store.ts';
import { boardSvg, rasterize, type Theme } from './render.ts';
import { isEdge, isNode } from './agent.ts';
import type { Box, Item, NodeItem } from '../src/types.ts';

export type ExportFormat = 'png' | 'pdf' | 'svg' | 'md' | 'json';
export const EXPORT_TYPES: Record<ExportFormat, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
  svg: { mime: 'image/svg+xml', ext: 'svg' },
  md: { mime: 'text/markdown; charset=utf-8', ext: 'md' },
  json: { mime: 'application/json', ext: 'brainboard.json' },
};

export interface ExportOpts {
  ids?: string[];
  theme?: Theme;
  /** false = transparent (PNG and SVG only) */
  background?: boolean;
  /** pixels per board unit for PNG (1–4) */
  scale?: number;
  /** fit the longest side into this many pixels instead (previews) */
  max?: number;
}

const MAX_PX = 8000;

/** Only the selected items, plus arrows between them. */
function subset(b: Board, ids?: string[]): Board {
  if (!ids?.length) return b;
  const keep = new Set(ids);
  return { ...b, items: b.items.filter((i) => (isEdge(i) ? keep.has(i.from) && keep.has(i.to) : keep.has(i.id))) };
}

export async function exportBoard(b: Board, format: ExportFormat, opts: ExportOpts = {}): Promise<Buffer | string | null> {
  const board = subset(b, opts.ids);
  if (format === 'md') return markdown(board);
  if (format === 'json') return JSON.stringify(await brainboardFile(board));
  const theme = opts.theme ?? 'light';
  const r = await boardSvg(board, { theme, background: format === 'pdf' ? true : opts.background !== false });
  if (!r) return null;
  if (format === 'svg') return `<?xml version="1.0" encoding="UTF-8"?>\n${r.svg}`;
  const longest = Math.max(r.box.w, r.box.h);
  let scale = opts.max ? opts.max / longest : Math.min(Math.max(opts.scale ?? 2, 0.25), 4);
  scale = Math.min(scale, MAX_PX / longest);
  if (format === 'png') return rasterize(r.svg, r.box.w * scale).asPng();
  // PDF: a page the size of the board at 96 dpi (capped at the PDF maximum), holding a sharp raster of it.
  const img = rasterize(r.svg, r.box.w * Math.min(Math.max(scale, 2), MAX_PX / longest));
  return pdf(img.pixels, img.width, img.height, r.box);
}

// ---------------------------------------------------------------- PDF (one page, one image)

function pdf(rgba: Buffer, w: number, h: number, box: Box): Buffer {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  const data = zlib.deflateSync(rgb, { level: 6 });
  let pw = box.w * 0.75, ph = box.h * 0.75; // CSS px → points
  const k = Math.min(1, 14400 / Math.max(pw, ph));
  pw = Math.round(pw * k * 100) / 100;
  ph = Math.round(ph * k * 100) / 100;
  const content = Buffer.from(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
  const objs: (string | Buffer)[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`],
    [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, data, '\nendstream'],
    [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream'],
    ['<< /Producer (brainboard) >>'],
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  let size = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((parts, i) => {
    offsets.push(size);
    for (const p of [`${i + 1} 0 obj\n`, ...parts, '\nendobj\n']) {
      const b = Buffer.isBuffer(p) ? p : Buffer.from(p, 'binary');
      chunks.push(b);
      size += b.length;
    }
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'binary'));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- Markdown outline

function readingOrder<T extends Box>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = Math.round((a.y + a.h / 2) / 120), rb = Math.round((b.y + b.h / 2) / 120);
    return ra - rb || a.x - b.x;
  });
}

const textOf = (i: Item | undefined) => (i && 'text' in i ? i.text.trim() : i?.type === 'image' ? '(image)' : '');
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' / ');

export function markdown(b: Board): string {
  const L: string[] = [`# ${b.name}`, ''];
  const nodes = b.items.filter(isNode);
  const edges = b.items.filter(isEdge);
  const byId = new Map<string, Item>(b.items.map((i) => [i.id, i]));
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));

  // Text, notes and lone shapes, top to bottom.
  for (const it of readingOrder(nodes)) {
    if (linked.has(it.id)) continue;
    if (it.type === 'text') {
      const t = it.text.trim();
      if (!t || t === b.name.trim()) continue; // the board's own title is already the heading
      L.push(it.fs >= 28 ? `## ${oneLine(t)}` : t, '');
    } else if (it.type === 'note') {
      const t = it.text.trim();
      if (!t) continue;
      L.push(...t.split('\n').map((l) => `> ${l}`), '');
    } else if (it.type === 'shape' && it.text.trim()) {
      L.push(`- ${oneLine(it.text.trim())}`, '');
    }
  }

  if (edges.length) {
    L.push('## Flow', '');
    const out = new Map<string, { to: string; label: string }[]>();
    const indeg = new Map<string, number>();
    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from)!.push({ to: e.to, label: e.label });
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
      if (!indeg.has(e.from)) indeg.set(e.from, 0);
    }
    const seen = new Set<string>();
    const walk = (id: string, depth: number, label: string) => {
      const name = oneLine(textOf(byId.get(id))) || 'untitled';
      const line = `${'  '.repeat(depth)}- ${label ? `*${oneLine(label)}:* ` : ''}${name}`;
      if (seen.has(id)) { L.push(`${line} (back to it)`); return; }
      seen.add(id);
      L.push(line);
      for (const c of out.get(id) ?? []) walk(c.to, depth + 1, c.label);
    };
    const starts = readingOrder([...indeg.keys()].map((id) => byId.get(id) as NodeItem));
    for (const n of starts) if (!indeg.get(n.id)) walk(n.id, 0, '');
    for (const n of starts) if (!seen.has(n.id)) walk(n.id, 0, '');
    L.push('');
  }

  const images = nodes.filter((i) => i.type === 'image').length;
  const drawings = nodes.filter((i) => i.type === 'stroke').length;
  if (images || drawings) {
    L.push('---', '', `*Also on this board: ${[images && `${images} image${images === 1 ? '' : 's'}`, drawings && `${drawings} drawing${drawings === 1 ? '' : 's'}`].filter(Boolean).join(' and ')}. Export as PNG or PDF to see them.*`, '');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------- brainboard file (import it again later)

async function brainboardFile(b: Board) {
  const blobs: Record<string, string> = {};
  for (const it of b.items) {
    if (it.type !== 'image' || blobs[it.blob]) continue;
    const img = await readImage(it.blob);
    if (img) blobs[it.blob] = `data:${img.mime};base64,${img.buf.toString('base64')}`;
  }
  return { app: 'brainboard', version: 1, name: b.name, items: b.items, blobs };
}

