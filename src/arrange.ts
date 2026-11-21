// Align, space evenly and tidy up the selected items. Moves glide briefly into place, then save as one undo step.
import { S, changed, checkpoint, requestRender } from './state';
import { isNode } from './actions';
import { canEdit } from './net';
import { unionBox } from './geometry';
import type { NodeItem } from './types';

export type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type ArrangeKind = AlignKind | 'space-h' | 'space-v' | 'tidy';

export const ARRANGE: Record<ArrangeKind, { label: string; tip: string; icon: string; key: string; code: string; shift?: true }> = {
  left: { label: 'Left', tip: 'Align left edges', icon: 'alignLeft', key: '⌥A', code: 'KeyA' },
  center: { label: 'Center', tip: 'Align centers', icon: 'alignCenter', key: '⌥H', code: 'KeyH' },
  right: { label: 'Right', tip: 'Align right edges', icon: 'alignRight', key: '⌥D', code: 'KeyD' },
  top: { label: 'Top', tip: 'Align top edges', icon: 'alignTop', key: '⌥W', code: 'KeyW' },
  middle: { label: 'Middle', tip: 'Align middles', icon: 'alignMiddle', key: '⌥V', code: 'KeyV' },
  bottom: { label: 'Bottom', tip: 'Align bottom edges', icon: 'alignBottom', key: '⌥S', code: 'KeyS' },
  'space-h': { label: 'Space evenly across', tip: 'Equal gaps left to right', icon: 'spaceH', key: '⌥⇧H', code: 'KeyH', shift: true },
  'space-v': { label: 'Space evenly down', tip: 'Equal gaps top to bottom', icon: 'spaceV', key: '⌥⇧V', code: 'KeyV', shift: true },
  tidy: { label: 'Tidy up', tip: 'Line everything up in neat rows with even gaps', icon: 'tidy', key: '⌥⇧T', code: 'KeyT', shift: true },
};

/** The arrange action for an Alt (+Shift) shortcut, if any. */
export function arrangeForKey(code: string, shift: boolean): ArrangeKind | null {
  for (const [k, v] of Object.entries(ARRANGE)) if (v.code === code && !!v.shift === shift) return k as ArrangeKind;
  return null;
}

const selectedNodes = () => S.items.filter((i): i is NodeItem => isNode(i) && S.selected.has(i.id));

/** How many items are selected, and whether each action makes sense for them. */
export function arrangeAvailable(kind: ArrangeKind, count = selectedNodes().length) {
  return kind === 'space-h' || kind === 'space-v' ? count >= 3 : count >= 2;
}

const GAP = 24;

function targets(kind: ArrangeKind, nodes: NodeItem[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const b = unionBox(nodes);
  const set = (n: NodeItem, x = n.x, y = n.y) => out.set(n.id, { x, y });
  switch (kind) {
    case 'left': for (const n of nodes) set(n, b.x); break;
    case 'center': for (const n of nodes) set(n, b.x + (b.w - n.w) / 2); break;
    case 'right': for (const n of nodes) set(n, b.x + b.w - n.w); break;
    case 'top': for (const n of nodes) set(n, n.x, b.y); break;
    case 'middle': for (const n of nodes) set(n, n.x, b.y + (b.h - n.h) / 2); break;
    case 'bottom': for (const n of nodes) set(n, n.x, b.y + b.h - n.h); break;
    case 'space-h': case 'space-v': {
      const h = kind === 'space-h';
      const pos = (n: NodeItem) => (h ? n.x : n.y), size = (n: NodeItem) => (h ? n.w : n.h);
      const sorted = [...nodes].sort((p, q) => pos(p) + size(p) / 2 - (pos(q) + size(q) / 2));
      const first = sorted[0], last = sorted[sorted.length - 1];
      const span = pos(last) + size(last) - pos(first);
      const gap = (span - sorted.reduce((s, n) => s + size(n), 0)) / (sorted.length - 1);
      let at = pos(first);
      for (const n of sorted) {
        if (h) set(n, at); else set(n, n.x, at);
        at += size(n) + gap;
      }
      break;
    }
    case 'tidy': {
      // Keep the rough rows the user already made, in reading order, then lay them out on a neat grid.
      const byY = [...nodes].sort((p, q) => p.y + p.h / 2 - (q.y + q.h / 2));
      const rows: NodeItem[][] = [];
      let band = -Infinity;
      for (const n of byY) {
        const mid = n.y + n.h / 2;
        if (rows.length && mid <= band) {
          rows[rows.length - 1].push(n);
          band = Math.max(band, n.y + n.h);
        } else {
          rows.push([n]);
          band = n.y + n.h;
        }
      }
      for (const r of rows) r.sort((p, q) => p.x - q.x);
      // Every item on its own row means a loose pile, not a column: make a grid that's about as wide as it's tall.
      if (rows.length === nodes.length && nodes.length > 3 && b.w > b.h * 0.6) {
        const sorted = rows.flat();
        const cols = Math.ceil(Math.sqrt(sorted.length));
        rows.length = 0;
        for (let i = 0; i < sorted.length; i += cols) rows.push(sorted.slice(i, i + cols).sort((p, q) => p.x - q.x));
      }
      const colW: number[] = [];
      for (const r of rows) r.forEach((n, i) => { colW[i] = Math.max(colW[i] ?? 0, n.w); });
      let y = b.y;
      for (const r of rows) {
        const rowH = Math.max(...r.map((n) => n.h));
        let x = b.x;
        r.forEach((n, i) => {
          set(n, x + (colW[i] - n.w) / 2, y + (rowH - n.h) / 2);
          x += colW[i] + GAP;
        });
        y += rowH + GAP;
      }
      break;
    }
  }
  return out;
}

let tween = 0;
let finish: (() => void) | null = null;

/** Align, space or tidy the selection. Returns false when there's nothing to do. */
export function arrange(kind: ArrangeKind): boolean {
  if (!canEdit()) return false;
  finish?.();
  const nodes = selectedNodes();
  if (!arrangeAvailable(kind, nodes.length)) return false;
  const to = targets(kind, nodes);
  const from = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (nodes.every((n) => Math.abs(to.get(n.id)!.x - n.x) < 0.01 && Math.abs(to.get(n.id)!.y - n.y) < 0.01)) return true;

  checkpoint();
  const place = (t: number) => {
    for (const n of nodes) {
      const a = from.get(n.id)!, b = to.get(n.id)!;
      n.x = a.x + (b.x - a.x) * t;
      n.y = a.y + (b.y - a.y) * t;
    }
  };
  const done = () => {
    cancelAnimationFrame(tween);
    finish = null;
    place(1);
    changed();
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return true; }
  finish = done;
  const start = performance.now(), ms = 200;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    if (t >= 1) return done();
    place(1 - (1 - t) ** 3);
    requestRender();
    tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
  return true;
}
