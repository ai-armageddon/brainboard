// Agent-friendly operations on a board: readable outlines, batch creation with auto-layout, edits.
import { replaceItemText } from '../src/text-runs.ts';
import type { Box, ColorKey, EdgeItem, Item, NodeItem, ShapeKind, TextualItem } from '../src/types.ts';
import { COLORS } from '../src/types.ts';
import { intersects, resizeStroke, unionBox } from '../src/geometry.ts';
import { newId, type Board } from './store.ts';

export const isNode = (it: Item): it is NodeItem => it.type !== 'edge';
export const isEdge = (it: Item): it is EdgeItem => it.type === 'edge';
export const isTextual = (it: Item): it is TextualItem => it.type === 'note' || it.type === 'text' || it.type === 'shape';

export const SHAPE_NAME: Record<ShapeKind, string> = { ellipse: 'bubble', pill: 'pill', rect: 'box', diamond: 'decision' };
const SHAPE_ALIAS: Record<string, ShapeKind> = {
  bubble: 'ellipse', ellipse: 'ellipse', circle: 'ellipse', oval: 'ellipse',
  pill: 'pill', box: 'rect', rect: 'rect', rectangle: 'rect', square: 'rect',
  decision: 'diamond', diamond: 'diamond',
};
const COLOR_ALIAS: Record<string, ColorKey> = {
  default: 'ink', ink: 'ink', black: 'ink', white: 'ink', none: 'ink',
  gray: 'gray', grey: 'gray', red: 'red', pink: 'red', orange: 'orange', yellow: 'yellow',
  green: 'green', blue: 'blue', purple: 'purple', violet: 'purple',
};
export const COLOR_HELP = `${COLORS.join(', ')} ("ink" is the plain default)`;

export function normColor(c: string | undefined, fallback: ColorKey): ColorKey {
  if (!c) return fallback;
  const k = COLOR_ALIAS[c.toLowerCase().trim()];
  if (!k) throw new Error(`Unknown color "${c}". Use one of: ${COLOR_HELP}`);
  return k;
}
export function normShape(s: string): ShapeKind {
  const k = SHAPE_ALIAS[s.toLowerCase().trim()];
  if (!k) throw new Error(`Unknown shape "${s}". Use bubble, box, pill or decision.`);
  return k;
}

const r = (n: number) => Math.round(n);
const quote = (s: string, max = 60) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return `"${one.length > max ? one.slice(0, max - 1) + '…' : one}"`;
};

export function kindName(it: Item): string {
  switch (it.type) {
    case 'shape': return SHAPE_NAME[it.shape];
    case 'note': return 'sticky note';
    case 'text': return 'text';
    case 'image': return 'image';
    case 'stroke': return 'drawing';
    case 'edge': return 'connection';
  }
}

export function shortLabel(it: Item | undefined): string {
  if (!it) return '(missing)';
  if (isTextual(it)) return it.text.trim() ? quote(it.text, 40) : `(empty ${kindName(it)})`;
  return `(${kindName(it)})`;
}

/** Top-to-bottom, left-to-right reading order. */
function readingOrder<T extends Box>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = Math.round((a.y + a.h / 2) / 120), rb = Math.round((b.y + b.h / 2) / 120);
    return ra - rb || a.x - b.x;
  });
}

// ------------------------------------------------------------------ reading

export function describeBoard(b: Board): string {
  const nodes = b.items.filter(isNode);
  const edges = b.items.filter(isEdge);
  const byId = new Map<string, Item>(b.items.map((i) => [i.id, i]));
  const L: string[] = [];
  L.push(`# ${b.name}`);
  L.push(`board id: ${b.id} · rev ${b.rev} · updated ${b.updated} · ${nodes.length} items, ${edges.length} connections`);
  if (!b.items.length) {
    L.push('', '(empty board)');
    return L.join('\n');
  }
  const bb = unionBox(nodes);
  L.push(`canvas extent: x ${r(bb.x)}…${r(bb.x + bb.w)}, y ${r(bb.y)}…${r(bb.y + bb.h)} (x grows right, y grows down)`);

  const textual = readingOrder(nodes.filter(isTextual));
  const shapes = textual.filter((i) => i.type === 'shape');
  const notes = textual.filter((i) => i.type === 'note');
  const texts = textual.filter((i) => i.type === 'text');
  const images = readingOrder(nodes.filter((i) => i.type === 'image'));
  const strokes = nodes.filter((i) => i.type === 'stroke');
  const geo = (i: NodeItem) => `at (${r(i.x)}, ${r(i.y)}) ${r(i.w)}×${r(i.h)}`;
  const col = (i: Item) => ('color' in i && i.color !== 'ink' ? ` · ${i.color}` : '');
  const body = (t: string) => t.split('\n').map((l) => `    ${l}`).join('\n');

  if (shapes.length) {
    L.push('', '## Flow-chart shapes');
    for (const s of shapes) L.push(`- [${s.id}] ${kindName(s)} ${s.text.includes('\n') ? '' : quote(s.text, 200)}${col(s)} · ${geo(s)}${s.text.includes('\n') ? '\n' + body(s.text) : ''}`);
  }
  if (notes.length) {
    L.push('', '## Sticky notes');
    for (const n of notes) L.push(`- [${n.id}] note${col(n)} · ${geo(n)}${n.text.trim() ? '\n' + body(n.text.slice(0, 4000)) : ' (empty)'}`);
  }
  if (texts.length) {
    L.push('', '## Text');
    for (const t of texts) L.push(`- [${t.id}]${col(t)} · ${geo(t)} · font ${r(t.fs)}\n${body(t.text.slice(0, 4000))}`);
  }
  if (images.length) {
    L.push('', '## Images  (call view_image to look at one)');
    for (const i of images) L.push(`- [${i.id}] image · ${geo(i)}`);
  }
  if (strokes.length) {
    const sb = unionBox(strokes);
    const ids = strokes.slice(0, 30).map((s) => s.id).join(', ') + (strokes.length > 30 ? ', …' : '');
    L.push('', '## Pen drawings  (call render_board to see them)');
    L.push(`- ${strokes.length} freehand stroke${strokes.length > 1 ? 's' : ''} within x ${r(sb.x)}…${r(sb.x + sb.w)}, y ${r(sb.y)}…${r(sb.y + sb.h)}; ids: ${ids}`);
  }
  if (edges.length) {
    L.push('', '## Connections');
    for (const e of edges) {
      L.push(`- [${e.id}] [${e.from}] ${shortLabel(byId.get(e.from))} → [${e.to}] ${shortLabel(byId.get(e.to))}${e.label ? ` · label ${quote(e.label)}` : ''}`);
    }
    L.push('', '## Flow outline');
    L.push(...flowOutline(b.items));
  }
  return L.join('\n');
}

function flowOutline(items: Item[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map<string, { to: string; label: string }[]>();
  const indeg = new Map<string, number>();
  for (const e of items.filter(isEdge)) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push({ to: e.to, label: e.label });
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    if (!indeg.has(e.from)) indeg.set(e.from, indeg.get(e.from) ?? 0);
  }
  const connected = readingOrder([...indeg.keys()].map((id) => byId.get(id) as NodeItem));
  const seen = new Set<string>();
  const lines: string[] = [];
  const walk = (id: string, depth: number, label: string) => {
    const pre = depth ? `${'  '.repeat(depth)}→ ${label ? `(${label}) ` : ''}` : '';
    const line = `${pre}${shortLabel(byId.get(id))} [${id}]`;
    if (seen.has(id)) { lines.push(`${line} ↺`); return; }
    seen.add(id);
    lines.push(line);
    for (const c of out.get(id) ?? []) walk(c.to, depth + 1, c.label);
  };
  for (const n of connected) if (!indeg.get(n.id)) walk(n.id, 0, '');
  for (const n of connected) if (!seen.has(n.id)) walk(n.id, 0, '');
  return lines;
}

/** Full detail for programmatic use; pen points are summarised to keep it small. */
export function boardJson(b: Board) {
  const round = (v: unknown): unknown =>
    typeof v === 'number' ? Math.round(v * 10) / 10 : v;
  return {
    id: b.id, name: b.name, rev: b.rev, updated: b.updated,
    items: b.items.map((it) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(it)) {
        if (k === 'points') o.pointCount = (v as number[]).length / 2;
        else if (k === 'outline') o.outlineCount = (v as number[][]).length;
        else if (k === 'blob') continue;
        else o[k] = round(v);
      }
      if (it.type === 'shape') o.shape = SHAPE_NAME[it.shape];
      return o;
    }),
  };
}

// ------------------------------------------------------------------ sizing

const CHAR = 0.56, LINE = 1.38;

export function wrapLines(text: string, fs: number, maxW: number): string[] {
  const perLine = Math.max(1, Math.floor(maxW / (fs * CHAR)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (let word of para.split(/(\s+)/)) {
      while (word.length > perLine) {
        if (line) { out.push(line.trimEnd()); line = ''; }
        out.push(word.slice(0, perLine));
        word = word.slice(perLine);
      }
      if ((line + word).trimEnd().length > perLine) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
    }
    out.push(line.trimEnd());
  }
  return out;
}

const SHAPE_DEFAULT: Record<ShapeKind, { w: number; h: number }> = {
  ellipse: { w: 170, h: 100 }, rect: { w: 170, h: 90 }, pill: { w: 180, h: 72 }, diamond: { w: 150, h: 120 },
};
/** Fraction of the shape's width available for text. */
export const SHAPE_TEXT_W: Record<ShapeKind, number> = { ellipse: 0.7, rect: 1, pill: 0.88, diamond: 0.56 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function shapeSize(kind: ShapeKind, text: string, fs: number) {
  const d = SHAPE_DEFAULT[kind];
  const longest = Math.max(0, ...text.split('\n').map((l) => l.length));
  const grow = { ellipse: 1.3, rect: 1, pill: 1.1, diamond: 1.7 }[kind];
  const w = clamp((longest * fs * CHAR + 40) * grow, d.w, kind === 'diamond' ? 360 : 300);
  const inner = w * SHAPE_TEXT_W[kind] - 28;
  const lines = wrapLines(text, fs, inner).length;
  const h = Math.max(d.h, lines * fs * LINE * (kind === 'diamond' ? 1.9 : kind === 'ellipse' ? 1.4 : 1) + 28);
  return { w, h };
}

const TEXT_SIZES: Record<string, number> = { S: 16, M: 22, L: 32, XL: 48 };

// ------------------------------------------------------------------ adding

export interface AddSpec {
  type: string;
  text?: string;
  label?: string;
  color?: string;
  ref?: string;
  from?: string;
  to?: string;
  near?: string;
  size?: string;
  x?: number; y?: number; w?: number; h?: number;
}
export interface Added { ref?: string; id: string; type: string; summary: string }

const GAP = 100;

/**
 * `anchor`: where new, unconnected items should start (e.g. inside the area the user is looking at).
 * Without it they go beside existing content.
 */
export function addItems(board: Board, specs: AddSpec[], direction: 'right' | 'down' = 'right', anchor?: { x: number; y: number }): Added[] {
  const refs = new Map<string, string>();
  const created: { node: NodeItem; spec: AddSpec; explicit: boolean }[] = [];
  const edgeSpecs: AddSpec[] = [];

  for (const s of specs) {
    const type = s.type.toLowerCase().trim();
    if (type === 'edge' || type === 'connection' || type === 'arrow') { edgeSpecs.push(s); continue; }
    const text = s.text ?? '';
    const id = newId();
    let node: NodeItem;
    if (type === 'note' || type === 'sticky' || type === 'sticky note') {
      const fs = 16;
      const w = s.w ?? (text.length > 160 ? 260 : 200);
      const est = wrapLines(text, fs, w - 34).length * fs * LINE + 32;
      node = { id, type: 'note', x: 0, y: 0, w, h: s.h ?? Math.max(est, text.length > 40 ? 140 : 200), text, color: normColor(s.color, 'yellow'), fs };
    } else if (type === 'text') {
      const fs = TEXT_SIZES[(s.size ?? 'M').toUpperCase()] ?? 22;
      const lines = text.split('\n');
      node = {
        id, type: 'text', x: 0, y: 0, text, color: normColor(s.color, 'ink'), fs,
        w: Math.max(...lines.map((l) => l.length)) * fs * CHAR + 8, h: lines.length * fs * 1.25 + 4,
      };
    } else {
      const shape = normShape(type === 'shape' ? 'bubble' : type);
      const fs = 16;
      const sz = shapeSize(shape, text, fs);
      node = { id, type: 'shape', shape, x: 0, y: 0, w: s.w ?? sz.w, h: s.h ?? sz.h, text, color: normColor(s.color, 'ink'), fs };
    }
    if (s.ref) {
      if (refs.has(s.ref)) throw new Error(`Duplicate ref "${s.ref}"`);
      refs.set(s.ref, id);
    }
    const explicit = typeof s.x === 'number' && typeof s.y === 'number';
    if (explicit) { node.x = s.x!; node.y = s.y!; }
    created.push({ node, spec: s, explicit });
  }

  const allNodes = (): NodeItem[] => [...board.items.filter(isNode), ...created.map((c) => c.node)];
  const resolve = (key: string, what: string): string => {
    if (refs.has(key)) return refs.get(key)!;
    if (allNodes().some((n) => n.id === key)) return key;
    const k = key.trim().toLowerCase();
    const matches = board.items.filter((i) => isTextual(i) && i.text.trim().toLowerCase() === k);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error(`${what} "${key}" matches ${matches.length} items by text; use an id instead (${matches.map((m) => m.id).join(', ')}).`);
    throw new Error(`${what} "${key}" is not a ref from this call, an item id, or the exact text of an item on the board.`);
  };

  // Resolve edges up front so errors surface before anything is written.
  const edges = edgeSpecs.map((s) => {
    if (!s.from || !s.to) throw new Error('Every edge needs "from" and "to".');
    return { from: resolve(s.from, 'Edge "from"'), to: resolve(s.to, 'Edge "to"'), spec: s };
  });

  // ---- layout: place each new node next to its parent, avoiding overlaps
  const parentOf = new Map<string, string>();
  for (const c of created) {
    if (c.explicit) continue;
    if (c.spec.near) parentOf.set(c.node.id, resolve(c.spec.near, '"near"'));
    else {
      const e = edges.find((e) => e.to === c.node.id && e.from !== c.node.id);
      if (e) parentOf.set(c.node.id, e.from);
    }
  }

  const placed: NodeItem[] = [...board.items.filter(isNode), ...created.filter((c) => c.explicit).map((c) => c.node)];
  const pad = 28;
  const collides = (n: NodeItem) => {
    const probe = { x: n.x - pad, y: n.y - pad, w: n.w + pad * 2, h: n.h + pad * 2 };
    return placed.some((o) => o !== n && intersects(probe, o));
  };
  const settle = (n: NodeItem, sx: number, sy: number) => {
    for (let i = 0; i < 400 && collides(n); i++) { n.x += sx; n.y += sy; }
  };

  const existing = board.items.filter(isNode);
  const content = existing.length ? unionBox(existing) : null;
  const newPlaced: NodeItem[] = [];
  const pending = created.filter((c) => !c.explicit).map((c) => c.node);

  const placeRoot = (n: NodeItem) => {
    if (direction === 'right') {
      const below = newPlaced.length ? Math.max(...newPlaced.map((p) => p.y + p.h)) + GAP : null;
      n.x = anchor ? anchor.x : content ? content.x + content.w + GAP * 2 : 0;
      if (newPlaced.length) n.x = Math.min(...newPlaced.map((p) => p.x));
      n.y = below ?? (anchor ? anchor.y : content ? content.y : 0);
      settle(n, 0, n.h / 2 + GAP / 2);
    } else {
      const right = newPlaced.length ? Math.max(...newPlaced.map((p) => p.x + p.w)) + GAP : null;
      n.y = anchor ? anchor.y : content ? content.y + content.h + GAP * 2 : 0;
      if (newPlaced.length) n.y = Math.min(...newPlaced.map((p) => p.y));
      n.x = right ?? (anchor ? anchor.x : content ? content.x : 0);
      settle(n, n.w / 2 + GAP / 2, 0);
    }
  };
  const placeChild = (n: NodeItem, p: NodeItem) => {
    if (direction === 'right') {
      n.x = p.x + p.w + GAP;
      n.y = p.y + p.h / 2 - n.h / 2;
      settle(n, 0, n.h / 2 + GAP / 4);
    } else {
      n.y = p.y + p.h + GAP;
      n.x = p.x + p.w / 2 - n.w / 2;
      settle(n, n.w / 2 + GAP / 4, 0);
    }
  };

  while (pending.length) {
    let progress = false;
    for (let i = 0; i < pending.length; i++) {
      const n = pending[i];
      const pid = parentOf.get(n.id);
      const parent = pid ? placed.find((p) => p.id === pid) : undefined;
      if (pid && !parent && pending.some((q) => q.id === pid)) continue; // wait for parent
      if (parent) placeChild(n, parent); else placeRoot(n);
      placed.push(n);
      newPlaced.push(n);
      pending.splice(i--, 1);
      progress = true;
    }
    if (!progress) { // cycle among new nodes: break it
      const n = pending.shift()!;
      placeRoot(n);
      placed.push(n);
      newPlaced.push(n);
    }
  }

  // ---- commit
  const result: Added[] = [];
  for (const c of created) {
    board.items.push(c.node);
    result.push({
      ref: c.spec.ref, id: c.node.id, type: kindName(c.node),
      summary: `${kindName(c.node)} ${shortLabel(c.node)} at (${r(c.node.x)}, ${r(c.node.y)}) ${r(c.node.w)}×${r(c.node.h)}`,
    });
  }
  for (const e of edges) {
    const dup = board.items.find((i) => isEdge(i) && i.from === e.from && i.to === e.to) as EdgeItem | undefined;
    if (dup) {
      if (e.spec.label !== undefined) replaceItemText(dup, e.spec.label);
      result.push({ ref: e.spec.ref, id: dup.id, type: 'connection', summary: 'connection already existed' + (e.spec.label !== undefined ? ' (label updated)' : '') });
      continue;
    }
    const src = board.items.find((i) => i.id === e.from);
    const sw = src && (src.type === 'shape' || src.type === 'note') ? src.fs / 8 : 2;
    const edge: EdgeItem = {
      id: newId(), type: 'edge', from: e.from, to: e.to, label: e.spec.label ?? e.spec.text ?? '',
      color: normColor(e.spec.color, 'gray'), fs: sw * 7, sw,
    };
    board.items.push(edge);
    const byId = new Map(board.items.map((i) => [i.id, i]));
    result.push({ ref: e.spec.ref, id: edge.id, type: 'connection', summary: `${shortLabel(byId.get(e.from))} → ${shortLabel(byId.get(e.to))}${edge.label ? ` (${edge.label})` : ''}` });
  }
  return result;
}

// ------------------------------------------------------------------ editing

export interface UpdateSpec {
  id: string;
  text?: string;
  label?: string;
  color?: string;
  shape?: string;
  x?: number; y?: number; w?: number; h?: number;
  dx?: number; dy?: number;
}

export function updateItems(board: Board, updates: UpdateSpec[]): string[] {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const errors: string[] = [];
  for (const u of updates) {
    const it = byId.get(u.id);
    if (!it) { errors.push(`No item with id "${u.id}"`); continue; }
    try {
      if (u.color) normColor(u.color, 'ink');
      if (u.shape) {
        normShape(u.shape);
        if (it.type !== 'shape') throw new Error(`"${u.id}" is a ${kindName(it)}, not a flow-chart shape`);
      }
      if (u.text !== undefined && !isTextual(it) && it.type !== 'edge') throw new Error(`"${u.id}" is a ${kindName(it)} and has no text`);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length) throw new Error(`Nothing was changed:\n- ${errors.join('\n- ')}`);

  const done: string[] = [];
  for (const u of updates) {
    const it = byId.get(u.id)!;
    const changes: string[] = [];
    if (it.type === 'edge') {
      const label = u.label ?? u.text;
      if (label !== undefined) { replaceItemText(it, label); changes.push('label'); }
    } else {
      if (u.text !== undefined && isTextual(it)) { replaceItemText(it, u.text); changes.push('text'); }
      if (u.shape && it.type === 'shape') { it.shape = normShape(u.shape); changes.push('shape'); }
      if (u.x !== undefined) it.x = u.x;
      if (u.y !== undefined) it.y = u.y;
      if (u.dx) it.x += u.dx;
      if (u.dy) it.y += u.dy;
      if (u.x !== undefined || u.y !== undefined || u.dx || u.dy) changes.push('position');
      if (u.w !== undefined && u.w > 0) {
        if (it.type === 'stroke') resizeStroke(it, it, u.w / it.w, 1);
        it.w = u.w;
        changes.push('width');
      }
      if (u.h !== undefined && u.h > 0) {
        if (it.type === 'stroke') resizeStroke(it, it, 1, u.h / it.h);
        it.h = u.h;
        changes.push('height');
      }
    }
    if (u.color && 'color' in it) { it.color = normColor(u.color, it.color); changes.push('color'); }
    done.push(`[${it.id}] ${kindName(it)}: ${changes.length ? changes.join(', ') : 'no changes'}`);
  }
  return done;
}

export function deleteItems(board: Board, ids: string[]): { removed: number; edges: number } {
  const want = new Set(ids);
  const missing = ids.filter((id) => !board.items.some((i) => i.id === id));
  if (missing.length) throw new Error(`Nothing was deleted. Unknown ids: ${missing.join(', ')}`);
  const before = board.items.length;
  const direct = board.items.filter((i) => want.has(i.id)).length;
  board.items = board.items.filter((i) => !want.has(i.id) && !(isEdge(i) && (want.has(i.from) || want.has(i.to))));
  return { removed: direct, edges: before - board.items.length - direct };
}
