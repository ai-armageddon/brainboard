import { S, changed, checkpoint, getItem, isBrushTool, redo, requestRender, undo } from './state';
import type { Box, Item, NodeItem, StrokeItem, Tool } from './types';
import { applyCamera, live, marquee, nodeElOf, viewport } from './render';
import {
  addImages, bumpFont, canEditText, createNode, createSibling, formatSelection, defaultSize, deleteSelection, duplicateSelection,
  importBoard, isNode, isTextual, liveText, makeEdge, nudge, pasteItems, reorder, screenToWorld, selectAll,
  selectionItems, setTool, siblingOf, startEditing, stopCamAnim, stopEditing, uid, zoomAt, zoomBy,
  zoomToFit, setZoom, type Side,
} from './actions';
import { clamp, contains, resizeStroke, edgeGeom, strokePath, unionBox } from './geometry';
import { closePopovers, openImagePicker, setBrushSize, toast, toggleShortcuts } from './ui';
import { canEdit } from './net';
import { userMovedCamera } from './collab';
import { vimKey } from './vim';
import { openExport } from './export';
import { inkEnd, inkMove, inkStart } from './ink';
import { eraseStroke } from './erase';
import { IS_MAC, keyLabel } from './keys';
import { recognize, steady, taper, type ShapeName } from './beautify';
import { arrange, arrangeForKey } from './arrange';

type Drag =
  | { kind: 'brush-size'; tool: 'pen' | 'eraser'; pointerId: number; startX: number; startSize: number }
  | { kind: 'pan'; lx: number; ly: number }
  | { kind: 'move'; sx: number; sy: number; started: boolean; orig: Map<string, { x: number; y: number }>; clickId: string; wasSelected: boolean; shift: boolean }
  | { kind: 'marquee'; sx: number; sy: number; base: Set<string> }
  | { kind: 'resize'; corner: string; start: Box; origs: Map<string, NodeItem> ; lock: boolean }
  | {
    kind: 'draw'; pts: number[]; id: string; size: number; color: StrokeItem['color'];
    /** beauty mode: steadied input, tapered ink, shapes snap */
    beauty: boolean;
    /** set while the user holds still at the end of a stroke and it snapped to a shape */
    snap: { points: number[]; name: ShapeName } | null;
    /** screen point the hold-still timer measures from */
    anchor: { x: number; y: number };
    hold: number;
  }
  | { kind: 'erase'; last: { x: number; y: number }; did: boolean }
  | { kind: 'create'; tool: Tool; start: { x: number; y: number }; sx: number; sy: number; id: string | null }
  | { kind: 'connect'; from: string; side: Side | null; sx: number; sy: number; moved: boolean; target: string | null };

let drag: Drag | null = null;
const brushCursor = document.getElementById('brush-cursor')!;

function positionBrushCursor(e: MouseEvent) {
  brushCursor.hidden = false;
  brushCursor.style.left = `${e.clientX}px`;
  brushCursor.style.top = `${e.clientY}px`;
}

/** Hold this and drag to pan: ⌘ on Mac (Ctrl-click is right-click there), Ctrl elsewhere. */
const PAN_KEY = IS_MAC ? 'Meta' : 'Control';
const panModifier = (e: MouseEvent | KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);
const pointer = { x: innerWidth / 2, y: innerHeight / 2 };
let internalClip: Item[] | null = null;
const MARK = 'brainboard/v1:';

const isEditableTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');

function begin(d: Drag, e: PointerEvent) {
  drag = d;
  viewport.setPointerCapture(e.pointerId);
  if (d.kind === 'pan') viewport.classList.add('panning');
}

function setBusy(on: boolean) {
  document.body.classList.toggle('busy', on);
}

// ------------------------------------------------------------------ pointer down

function onDown(e: PointerEvent) {
  if (drag?.kind === 'brush-size' || (isBrushTool(S.tool) && !e.isPrimary)) return;
  const t = e.target as Element;
  if (t.closest('.txt.editing')) return;
  closePopovers();
  if (S.editing) stopEditing();
  stopCamAnim();
  const p = screenToWorld(e.clientX, e.clientY);

  if (e.button === 1 || (e.button === 0 && (S.space || S.tool === 'hand' || panModifier(e)))) {
    e.preventDefault();
    if (!userMovedCamera()) return;
    begin({ kind: 'pan', lx: e.clientX, ly: e.clientY }, e);
    return;
  }
  if (e.button !== 0) return;
  const ro = !canEdit();

  if (isBrushTool(S.tool)) {
    if (ro) return;
    positionBrushCursor(e);
    if (e.shiftKey) {
      e.preventDefault();
      begin({ kind: 'brush-size', tool: S.tool, pointerId: e.pointerId, startX: e.clientX, startSize: S[S.tool].size }, e);
      return;
    }
  }
  const handle = t.closest<HTMLElement>('.handle');
  if (handle && !ro) { beginResize(handle.dataset.corner!, e); return; }

  const itemEl = t.closest<HTMLElement>('[data-id]');
  const id = itemEl?.dataset.id ?? null;
  const port = t.closest<HTMLElement>('.port');
  if (port && id && !ro) {
    begin({ kind: 'connect', from: id, side: port.dataset.side as Side, sx: e.clientX, sy: e.clientY, moved: false, target: null }, e);
    return;
  }

  switch (S.tool) {
    case 'pen': {
      const pts = [p.x, p.y];
      const id = uid();
      const size = S.pen.size / S.cam.z;
      const color = S.pen.color;
      begin({ kind: 'draw', pts, id, size, color, beauty: S.pen.beauty, snap: null, anchor: { x: e.clientX, y: e.clientY }, hold: 0 }, e);
      if (S.pen.beauty) armHold(drag as DrawDrag);
      live.stroke.style.strokeWidth = `${size}px`;
      live.stroke.style.stroke = `var(--s-${color})`;
      drawLive(pts);
      inkStart(id, color, size, pts);
      return;
    }
    case 'eraser':
      begin({ kind: 'erase', last: p, did: false }, e);
      eraseAlong(drag as Extract<Drag, { kind: 'erase' }>, p);
      return;
    case 'note': case 'text': case 'ellipse': case 'rect': case 'diamond':
      begin({ kind: 'create', tool: S.tool, start: p, sx: e.clientX, sy: e.clientY, id: null }, e);
      return;
    case 'connect':
      if (id && isNode(getItem(id))) {
        begin({ kind: 'connect', from: id, side: null, sx: e.clientX, sy: e.clientY, moved: false, target: null }, e);
      } else {
        begin({ kind: 'pan', lx: e.clientX, ly: e.clientY }, e);
      }
      return;
    case 'select':
    case 'hand':
      if (id && ro) {
        S.selected = e.shiftKey ? new Set([...S.selected, id]) : new Set([id]);
        requestRender();
      } else if (id) {
        const wasSelected = S.selected.has(id);
        if (e.shiftKey) {
          if (wasSelected) { S.selected.delete(id); requestRender(); return; }
          S.selected.add(id);
        } else if (!wasSelected) {
          S.selected = new Set([id]);
        }
        requestRender();
        begin({ kind: 'move', sx: e.clientX, sy: e.clientY, started: false, orig: new Map(), clickId: id, wasSelected, shift: e.shiftKey }, e);
      } else {
        const base = e.shiftKey ? new Set(S.selected) : new Set<string>();
        if (!e.shiftKey && S.selected.size) { S.selected.clear(); requestRender(); }
        begin({ kind: 'marquee', sx: e.clientX, sy: e.clientY, base }, e);
      }
  }
}

function beginResize(corner: string, e: PointerEvent) {
  const nodes = S.items.filter((i): i is NodeItem => isNode(i) && S.selected.has(i.id));
  if (!nodes.length) return;
  checkpoint();
  const origs = new Map(nodes.map((n) => [n.id, structuredClone(n)]));
  const lock = nodes.length > 1 || nodes.some((n) => n.type === 'image' || n.type === 'text' || n.type === 'stroke');
  begin({ kind: 'resize', corner, start: unionBox(nodes), origs, lock }, e);
  setBusy(true);
}

// ------------------------------------------------------------------ pointer move

function onMove(e: PointerEvent) {
  if (drag?.kind === 'brush-size' && drag.pointerId !== e.pointerId) return;
  if (isBrushTool(S.tool) && e.isPrimary) positionBrushCursor(e);
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  if (!drag) return;
  const z = S.cam.z;
  const p = screenToWorld(e.clientX, e.clientY);

  switch (drag.kind) {
    case 'brush-size':
      if (S.tool === drag.tool) setBrushSize(drag.startSize + (e.clientX - drag.startX) / 4);
      return;
    case 'pan':
      S.cam.x += e.clientX - drag.lx;
      S.cam.y += e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      applyCamera();
      return;

    case 'move': {
      const dxs = e.clientX - drag.sx, dys = e.clientY - drag.sy;
      if (!drag.started) {
        if (Math.hypot(dxs, dys) < 3) return;
        drag.started = true;
        checkpoint();
        if (e.altKey) duplicateSelection(0); // alt-drag leaves a copy behind
        for (const id of S.selected) {
          const it = getItem(id);
          if (isNode(it)) drag.orig.set(id, { x: it.x, y: it.y });
        }
        setBusy(true);
      }
      for (const [id, o] of drag.orig) {
        const it = getItem(id) as NodeItem | undefined;
        if (it) { it.x = o.x + dxs / z; it.y = o.y + dys / z; }
      }
      changed();
      return;
    }

    case 'marquee': {
      const x0 = Math.min(drag.sx, e.clientX), y0 = Math.min(drag.sy, e.clientY);
      const w = Math.abs(e.clientX - drag.sx), h = Math.abs(e.clientY - drag.sy);
      Object.assign(marquee.style, { display: 'block', transform: `translate(${x0}px,${y0}px)`, width: `${w}px`, height: `${h}px` });
      const a = screenToWorld(x0, y0);
      const rect = { x: a.x, y: a.y, w: w / z, h: h / z };
      const sel = new Set(drag.base);
      for (const it of S.items) if (isNode(it) && contains(rect, it)) sel.add(it.id);
      S.selected = sel;
      requestRender();
      return;
    }

    case 'resize':
      doResize(drag, p, e.shiftKey);
      return;

    case 'draw': {
      const d = drag;
      const moved = Math.hypot(e.clientX - d.anchor.x, e.clientY - d.anchor.y);
      if (d.beauty) {
        // A snapped shape holds until the pen clearly moves on; then it's freehand again.
        if (d.snap && moved < 10) return;
        if (d.snap) { d.snap = null; live.stroke.style.removeProperty('opacity'); }
        if (moved > 3) { d.anchor = { x: e.clientX, y: e.clientY }; armHold(d); }
      }
      const evs = e.getCoalescedEvents?.() ?? [e];
      const pts = d.pts;
      for (const ev of evs) {
        let q = screenToWorld(ev.clientX, ev.clientY);
        const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
        if (d.beauty) q = steady(lx, ly, q.x, q.y);
        if (Math.hypot(q.x - lx, q.y - ly) * z < 1.5) continue;
        pts.push(q.x, q.y);
      }
      drawLive(pts);
      inkMove();
      return;
    }

    case 'erase': {
      const samples = e.getCoalescedEvents?.();
      if (samples?.length) {
        for (const sample of samples) eraseAlong(drag, screenToWorld(sample.clientX, sample.clientY));
      } else eraseAlong(drag, p);
      return;
    }

    case 'create': {
      if (drag.tool === 'text') return;
      if (!drag.id && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      let w = Math.abs(p.x - drag.start.x), h = Math.abs(p.y - drag.start.y);
      if (e.shiftKey) w = h = Math.max(w, h);
      const min = 24 / z;
      w = Math.max(w, min); h = Math.max(h, min);
      const x = p.x < drag.start.x ? drag.start.x - w : drag.start.x;
      const y = p.y < drag.start.y ? drag.start.y - h : drag.start.y;
      if (!drag.id) {
        checkpoint();
        const kind = drag.tool === 'note' ? 'note' : (drag.tool as 'ellipse' | 'rect' | 'diamond');
        drag.id = createNode(kind, { x, y, w, h }).id;
        S.selected = new Set([drag.id]);
        setBusy(true);
      }
      const it = getItem(drag.id) as NodeItem;
      Object.assign(it, { x, y, w, h });
      changed();
      return;
    }

    case 'connect': {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
        drag.moved = true;
        setBusy(true);
      }
      if (!drag.moved) return;
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('#items [data-id]');
      const tid = under?.dataset.id ?? null;
      const target = tid && tid !== drag.from ? tid : null;
      if (target !== drag.target) {
        if (drag.target) nodeElOf(drag.target)?.classList.remove('connect-target');
        if (target) nodeElOf(target)?.classList.add('connect-target');
        drag.target = target;
      }
      const src = getItem(drag.from) as NodeItem;
      const dst = target ? (getItem(target) as NodeItem) : { x: p.x, y: p.y, w: 0, h: 0 };
      const sw = makeEdge(drag.from, drag.from).sw;
      const g = edgeGeom(src, dst, sw);
      live.edge.setAttribute('d', g.d);
      live.arrow.setAttribute('d', g.arrow);
      live.edge.style.strokeWidth = `${sw}px`;
      return;
    }
  }
}

function doResize(d: Extract<Drag, { kind: 'resize' }>, p: { x: number; y: number }, shift: boolean) {
  const s = d.start;
  const min = 12 / S.cam.z;
  let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
  const west = d.corner.includes('w'), north = d.corner.includes('n');
  if (west) x0 = Math.min(p.x, x1 - min); else x1 = Math.max(p.x, x0 + min);
  if (north) y0 = Math.min(p.y, y1 - min); else y1 = Math.max(p.y, y0 + min);
  let sx = (x1 - x0) / (s.w || 1), sy = (y1 - y0) / (s.h || 1);
  if (d.lock !== shift) {
    const k = Math.max(sx, sy);
    sx = sy = k;
    if (west) x0 = x1 - s.w * k; else x1 = x0 + s.w * k;
    if (north) y0 = y1 - s.h * k; else y1 = y0 + s.h * k;
  }
  const multi = d.origs.size > 1;
  for (const [id, o] of d.origs) {
    const it = getItem(id) as NodeItem | undefined;
    if (!it) continue;
    it.x = x0 + (o.x - s.x) * sx;
    it.y = y0 + (o.y - s.y) * sy;
    it.w = o.w * sx;
    it.h = o.h * sy;
    if (it.type === 'stroke' && o.type === 'stroke') resizeStroke(it, o, sx, sy);
    if (it.type === 'text' && o.type === 'text') it.fs = o.fs * sx;
    else if (multi && 'fs' in it && 'fs' in o) it.fs = o.fs * Math.min(sx, sy);
  }
  changed();
}

// ------------------------------------------------------------------ pointer up

function onUp(e: PointerEvent) {
  const d = drag;
  if (d?.kind === 'brush-size' && d.pointerId !== e.pointerId) return;
  if (e.pointerType === 'touch' || e.type === 'pointercancel') brushCursor.hidden = true;
  if (!d) return;
  drag = null;
  setBusy(false);
  viewport.classList.remove('panning');
  const p = screenToWorld(e.clientX, e.clientY);

  switch (d.kind) {
    case 'erase':
      if (e.type === 'pointerup' && (d.last.x !== p.x || d.last.y !== p.y)) eraseAlong(d, p);
      break;
    case 'move':
      if (!d.started && !d.shift && d.wasSelected && S.selected.size > 1) S.selected = new Set([d.clickId]);
      break;
    case 'marquee':
      marquee.style.display = 'none';
      break;
    case 'draw':
      clearTimeout(d.hold);
      live.stroke.setAttribute('d', '');
      live.stroke.style.removeProperty('opacity');
      if (e.type !== 'pointercancel') {
        // Steadied ink trails the pen a little: finish where it actually lifted.
        const lx = d.pts[d.pts.length - 2], ly = d.pts[d.pts.length - 1];
        if (d.beauty && !d.snap && Math.hypot(p.x - lx, p.y - ly) * S.cam.z > 1) d.pts.push(p.x, p.y);
        finishStroke(d);
      }
      inkEnd(e.type === 'pointercancel' ? 'cancel' : 'done');
      break;
    case 'create': {
      let id = d.id;
      if (!id) {
        checkpoint();
        if (d.tool === 'text') {
          const fs = 22 / S.cam.z;
          id = createNode('text', { x: d.start.x - fs * 0.2, y: d.start.y - fs * 0.75, w: 0, h: 0 }).id;
        } else {
          const kind = d.tool === 'note' ? 'note' : (d.tool as 'ellipse' | 'rect' | 'diamond');
          const sz = defaultSize(kind);
          id = createNode(kind, { x: d.start.x - sz.w / 2, y: d.start.y - sz.h / 2, ...sz }).id;
        }
      }
      setTool('select');
      startEditing(id);
      break;
    }
    case 'connect':
      live.edge.setAttribute('d', '');
      live.arrow.setAttribute('d', '');
      finishConnect(d, p);
      break;
  }
  requestRender();
}

function finishConnect(d: Extract<Drag, { kind: 'connect' }>, p: { x: number; y: number }) {
  if (d.target) {
    nodeElOf(d.target)?.classList.remove('connect-target');
    const dup = S.items.some((i) => i.type === 'edge' && i.from === d.from && i.to === d.target);
    if (!dup) {
      checkpoint();
      S.items.push(makeEdge(d.from, d.target));
    }
    S.selected = new Set([d.target]);
    changed();
    return;
  }
  const src = getItem(d.from);
  if (!isNode(src)) return;
  if (d.moved) {
    // Dropped on empty canvas: grow a new connected bubble there.
    const n = siblingOf(src);
    n.x = p.x - n.w / 2;
    n.y = p.y - n.h / 2;
    checkpoint();
    S.items.push(n, makeEdge(src.id, n.id));
    S.selected = new Set([n.id]);
    if (S.tool !== 'select') setTool('select');
    changed();
    if (isTextual(n)) startEditing(n.id);
  } else if (d.side) {
    createSibling(d.from, d.side);
  }
}

// ------------------------------------------------------------------ pen & eraser

function drawLive(pts: number[]) {
  live.stroke.setAttribute('d', strokePath(pts.length === 2 ? [...pts, pts[0] + 0.01, pts[1]] : pts));
}

type DrawDrag = Extract<Drag, { kind: 'draw' }>;

/** Beauty mode: holding still for a moment snaps what's been drawn so far to a clean shape. */
function armHold(d: DrawDrag) {
  clearTimeout(d.hold);
  d.hold = window.setTimeout(() => {
    if (drag !== d || d.snap) return;
    const shape = recognize(d.pts, S.cam.z, true);
    if (!shape) return;
    d.snap = shape;
    drawLive(shape.points);
    live.stroke.style.opacity = '0.75';
    requestAnimationFrame(() => live.stroke.style.removeProperty('opacity'));
  }, 450);
}

/** A stroke item from world-space points, with an optional filled outline (also world space). */
function strokeItem(id: string, pts: number[], size: number, color: StrokeItem['color'], outline?: number[][] | null): StrokeItem {
  if (pts.length === 2) pts = [...pts, pts[0] + 0.01, pts[1]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (xs: number[]) => {
    for (let i = 0; i < xs.length; i += 2) {
      x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]);
      y0 = Math.min(y0, xs[i + 1]); y1 = Math.max(y1, xs[i + 1]);
    }
  };
  if (outline) outline.forEach(grow); else grow(pts);
  const pad = outline ? 0 : size / 2 + 1 / S.cam.z;
  const x = x0 - pad, y = y0 - pad;
  const rel = (xs: number[]) => xs.map((v, i) => Math.round((i % 2 ? v - y : v - x) * 100) / 100);
  return {
    id, type: 'stroke', x, y, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2, points: rel(pts), color, size,
    ...(outline ? { outline: outline.map(rel) } : {}),
  };
}

const SHAPE_WORDS: Record<ShapeName, string> = {
  line: 'a straight line', circle: 'a circle', ellipse: 'an ellipse', triangle: 'a triangle',
  square: 'a square', rectangle: 'a rectangle', shape: 'a clean shape', lines: 'straight lines',
};

function finishStroke(d: DrawDrag) {
  const { pts, id, size, color } = d;
  const z = S.cam.z;
  if (!d.beauty) {
    checkpoint();
    S.items.push(strokeItem(id, pts, size, color));
    changed();
    return;
  }
  const freehand = strokeItem(id, pts, size, color, taper(pts, size, z));
  const shape = d.snap ?? recognize(pts, z);
  checkpoint();
  S.items.push(freehand);
  changed();
  if (!shape) return;
  // Snapping is its own undo step: ⌘Z brings back the hand-drawn version.
  checkpoint();
  const i = S.items.findIndex((it) => it.id === id);
  if (i >= 0) S.items[i] = strokeItem(id, shape.points, size, color);
  changed();
  toast(keyLabel(`Snapped to ${SHAPE_WORDS[shape.name]} · ⌘Z to keep your drawing`));
}

function eraseAlong(d: Extract<Drag, { kind: 'erase' }>, p: { x: number; y: number }) {
  const radius = S.eraser.size / (2 * S.cam.z);
  const result: Item[] = [];
  let hit = false;
  for (const item of S.items) {
    const remaining = item.type === 'stroke' ? eraseStroke(item, d.last, p, radius, S.eraser.mode === 'whole') : item;
    if (remaining !== item) hit = true;
    if (remaining) result.push(remaining);
  }
  d.last = p;
  if (!hit) return;
  if (!d.did) { checkpoint(); d.did = true; }
  S.items = result;
  changed();
}

// ------------------------------------------------------------------ keyboard

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select', h: 'hand', p: 'pen', e: 'eraser', n: 'note', t: 'text',
  o: 'ellipse', r: 'rect', d: 'diamond', c: 'connect',
};

function onKeyDown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === PAN_KEY && !S.editing) viewport.classList.add('panmod');

  const target = e.target instanceof HTMLElement ? e.target : null;
  if (e.key === 'Escape' && document.querySelector('#ctxbar details[open]')) {
    document.querySelector<HTMLDetailsElement>('#ctxbar details[open]')!.open = false;
    e.preventDefault();
    return;
  }
  if (target?.closest('#penbar, #ctxbar, #choose-follow') && ['Tab', 'Enter', ' '].includes(e.key)) return;
  const formatKey = mod && !e.altKey && !e.shiftKey ? e.key.toLowerCase() : '';
  if ((formatKey === 'b' || formatKey === 'u') && (S.editing || !isEditableTarget(e.target)) &&
      canEdit() && selectionItems().some(canEditText)) {
    e.preventDefault();
    formatSelection(formatKey === 'b' ? 'bold' : 'underline');
    return;
  }
  if (S.editing) {
    if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
      e.preventDefault();
      stopEditing();
    } else if (e.key === 'Tab') {
      const it = getItem(S.editing);
      if (it && (it.type === 'shape' || it.type === 'note')) {
        e.preventDefault();
        createSibling(it.id, e.shiftKey ? 's' : 'e');
      }
    }
    return;
  }
  if (isEditableTarget(e.target)) return;
  const ro = !canEdit();

  if (mod) {
    const k = e.key.toLowerCase();
    if (ro && ['z', 'y', 'd', 'x'].includes(k)) { e.preventDefault(); return; }
    if (k === 'e' && e.shiftKey) { e.preventDefault(); openExport(); return; }
    if (k === 'r' && e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); if (!ro) redo(); return; } // vim redo
    if (['=', '+', '-', '0'].includes(k) && !userMovedCamera()) { e.preventDefault(); return; }
    switch (k) {
      case 'z': e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
      case 'y': e.preventDefault(); redo(); return;
      case 'd': e.preventDefault(); if (S.selected.size) { checkpoint(); duplicateSelection(16 / S.cam.z); } return;
      case 'a': e.preventDefault(); if (S.tool !== 'select') setTool('select'); selectAll(); return;
      case '=': case '+': e.preventDefault(); zoomBy(1.25); return;
      case '-': e.preventDefault(); zoomBy(0.8); return;
      case '0': e.preventDefault(); setZoom(1); return;
      case 'c': case 'x': if (S.selected.size) internalClip = structuredClone(selectionItems()); return;
    }
    return;
  }
  if (e.altKey) {
    // ⌥A/H/D align left/center/right, ⌥W/V/S top/middle/bottom, ⌥⇧H/V space evenly, ⌥⇧T tidy up.
    const kind = e.ctrlKey || e.metaKey ? null : arrangeForKey(e.code, e.shiftKey);
    if (kind && S.selected.size) {
      e.preventDefault();
      if (!ro && !arrange(kind)) toast(kind === 'space-h' || kind === 'space-v' ? 'Select 3 or more items to space them evenly' : 'Select 2 or more items to line them up');
    }
    return;
  }

  if (e.key === ' ') {
    e.preventDefault();
    if (!S.space) { S.space = true; viewport.classList.add('space'); }
    return;
  }
  if (vimKey(e)) return;

  if (ro && ['Delete', 'Backspace', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '[', ']'].includes(e.key)) {
    if (e.key === 'Tab') e.preventDefault();
    return;
  }
  switch (e.key) {
    case '+': case '=': case '-':
      if (isBrushTool(S.tool) && !ro) {
        e.preventDefault();
        setBrushSize(S[S.tool].size + (e.key === '-' ? -1 : 1));
        return;
      }
      if (bumpFont(e.key === '-' ? 'smaller' : 'larger')) e.preventDefault();
      return;
    case 'Escape':
      closePopovers();
      if (S.tool !== 'select') setTool('select');
      if (S.selected.size) { S.selected.clear(); requestRender(); }
      return;
    case 'Delete': case 'Backspace':
      e.preventDefault();
      deleteSelection();
      return;
    case 'Enter': {
      const id = S.selected.size === 1 ? [...S.selected][0] : null;
      if (id && canEditText(getItem(id))) { e.preventDefault(); startEditing(id); }
      return;
    }
    case 'Tab': {
      const id = S.selected.size === 1 ? [...S.selected][0] : null;
      if (id && isNode(getItem(id))) { e.preventDefault(); createSibling(id, e.shiftKey ? 's' : 'e'); }
      else e.preventDefault();
      return;
    }
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
      if (!S.selected.size) return;
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / S.cam.z;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      nudge(dx, dy);
      return;
    }
    case ']': case '[':
      e.preventDefault();
      if (isBrushTool(S.tool)) setBrushSize(S[S.tool].size + (e.key === ']' ? 1 : -1));
      else reorder(e.key === ']');
      return;
    case '?': toggleShortcuts(); return;
  }
  if (e.code === 'Digit1' && e.shiftKey) { e.preventDefault(); if (userMovedCamera()) zoomToFit(); return; }

  const k = e.key.toLowerCase();
  if (k === 'i') { if (!ro) openImagePicker(); return; }
  const tool = TOOL_KEYS[k];
  if (tool && !e.shiftKey) setTool(tool);
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === PAN_KEY || !panModifier(e)) viewport.classList.remove('panmod');
  if (e.key === ' ') {
    S.space = false;
    viewport.classList.remove('space');
  }
}

// ------------------------------------------------------------------ clipboard & drop

/** Put items in the internal clipboard (vim's unnamed register) and, when allowed, the system one. */
export function yank(items: Item[]) {
  internalClip = structuredClone(items);
  navigator.clipboard?.writeText(MARK + JSON.stringify(items)).catch(() => { /* not focused / not allowed */ });
}

/** Size of what's in the internal clipboard, or null when it's empty. */
export function clipBounds(): Box | null {
  const nodes = internalClip?.filter(isNode) ?? [];
  return nodes.length ? unionBox(nodes) : null;
}

export function putClip(at: { x: number; y: number }) {
  if (internalClip) pasteItems(internalClip, at);
}

export function pointerWorld() {
  const inside = pointer.x > 0 && pointer.y > 0 && pointer.x < innerWidth && pointer.y < innerHeight;
  return screenToWorld(inside ? pointer.x : innerWidth / 2, inside ? pointer.y : innerHeight / 2);
}

function onCopy(e: ClipboardEvent, cut: boolean) {
  if (S.editing || isEditableTarget(e.target)) return;
  const items = selectionItems();
  if (!items.length) return;
  e.preventDefault();
  internalClip = structuredClone(items);
  e.clipboardData?.setData('text/plain', MARK + JSON.stringify(items));
  if (cut && canEdit()) deleteSelection();
}

function onPaste(e: ClipboardEvent) {
  const dt = e.clipboardData;
  if (!dt) return;
  if (S.editing) {
    // keep pasted text plain inside notes/bubbles
    e.preventDefault();
    document.execCommand('insertText', false, dt.getData('text/plain'));
    return;
  }
  if (isEditableTarget(e.target) || !canEdit()) return;
  e.preventDefault();
  const at = pointerWorld();
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) { void addImages(files, at); return; }

  const text = dt.getData('text/plain');
  if (text.startsWith(MARK)) {
    try { pasteItems(JSON.parse(text.slice(MARK.length)), at); } catch { /* ignore */ }
    return;
  }
  if (!text.trim()) {
    if (internalClip) pasteItems(internalClip, at);
    return;
  }
  checkpoint();
  const long = text.length > 60 || text.includes('\n');
  const k = 1 / S.cam.z;
  const it = long
    ? createNode('note', { x: at.x - 140 * k, y: at.y - 60 * k, w: 280 * k, h: 120 * k })
    : createNode('text', { x: at.x, y: at.y, w: 0, h: 0 });
  it.text = text.replace(/\r\n/g, '\n').trimEnd();
  if (S.tool !== 'select') setTool('select');
  S.selected = new Set([it.id]);
  changed();
}

// ------------------------------------------------------------------ setup

export function initInput() {
  viewport.addEventListener('pointerdown', onDown);
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerleave', () => { brushCursor.hidden = true; });
  window.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  viewport.addEventListener('pointerup', onUp);
  viewport.addEventListener('pointercancel', onUp);
  viewport.addEventListener('lostpointercapture', (e) => { if (drag) onUp(e); });

  viewport.addEventListener('dblclick', (e) => {
    if (!canEdit() || (e.shiftKey && isBrushTool(S.tool))) return;
    // Pointer capture from the first click can retarget dblclick to the viewport, so hit-test the point too.
    const t = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as Element;
    if (t.closest('.txt.editing') || t.closest('.handle, .port')) return;
    const id = t.closest<HTMLElement>('[data-id]')?.dataset.id;
    if (id) {
      if (canEditText(getItem(id))) startEditing(id);
      return;
    }
    if (S.tool === 'select') {
      const p = screenToWorld(e.clientX, e.clientY);
      const fs = 22 / S.cam.z;
      checkpoint();
      const it = createNode('text', { x: p.x - fs * 0.2, y: p.y - fs * 0.75, w: 0, h: 0 });
      startEditing(it.id);
    }
  });

  // Trackpads emit a stream of fractional notches. Respond immediately, then
  // accumulate the rest so a slow swipe can still change size by just one pixel.
  let wheelRemainder = 0;
  let lastWheelAt = -Infinity;
  let lastDirection = 0;
  let lastBrush: Tool | null = null;
  function resizeWithWheel(e: WheelEvent) {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || !isBrushTool(S.tool) || !canEdit()) return false;
    e.preventDefault();
    if (drag) return true;
    // Some browsers deliver Shift + wheel on the horizontal axis.
    const delta = e.deltaY || e.deltaX;
    if (!delta) return true;
    const direction = -Math.sign(delta);
    const notches = Math.abs(delta) / (e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100);
    const fresh = e.timeStamp - lastWheelAt > 220 || direction !== lastDirection || S.tool !== lastBrush;
    const total = fresh ? Math.max(1, notches) : wheelRemainder + notches;
    const steps = Math.floor(total + 1e-9);
    wheelRemainder = Math.max(0, total - steps);
    lastWheelAt = e.timeStamp;
    lastDirection = direction;
    lastBrush = S.tool;
    if (e.currentTarget === viewport) positionBrushCursor(e);
    if (steps) setBrushSize(S[S.tool].size + direction * steps);
    return true;
  }
  document.getElementById('penbar')!.addEventListener('wheel', resizeWithWheel, { passive: false });
  viewport.addEventListener('wheel', (e) => {
    if (resizeWithWheel(e)) return;
    e.preventDefault();
    if (!userMovedCamera()) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, S.cam.z * Math.exp(clamp(-e.deltaY * unit, -25, 25) * 0.01));
    } else {
      stopCamAnim();
      S.cam.x -= e.deltaX * unit;
      S.cam.y -= e.deltaY * unit;
      applyCamera();
    }
  }, { passive: false });
  // stop browser page-zoom when pinching over floating panels
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  // Safari trackpad pinch
  let gz = 1;
  viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); gz = S.cam.z; });
  viewport.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!userMovedCamera()) return;
    const ge = e as unknown as { scale: number; clientX: number; clientY: number };
    zoomAt(ge.clientX, ge.clientY, gz * ge.scale);
  });

  // Commit text when focus leaves an editor (but not when the window itself loses focus).
  viewport.addEventListener('focusout', (e) => {
    if ((e.target as Element).classList?.contains('txt') && S.editing && document.hasFocus()) stopEditing();
  });
  viewport.addEventListener('input', () => { liveText(); requestRender(); });
  viewport.addEventListener('scroll', () => { viewport.scrollTop = 0; viewport.scrollLeft = 0; });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { S.space = false; viewport.classList.remove('space', 'panmod'); });

  document.addEventListener('copy', (e) => onCopy(e, false));
  document.addEventListener('cut', (e) => onCopy(e, true));
  document.addEventListener('paste', onPaste);

  viewport.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dropping'); });
  viewport.addEventListener('dragleave', () => viewport.classList.remove('dropping'));
  viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    viewport.classList.remove('dropping');
    if (!canEdit()) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    const board = files.find((f) => f.name.endsWith('.json'));
    if (board) { void importBoard(board); return; }
    void addImages(files, screenToWorld(e.clientX, e.clientY));
  });

  window.addEventListener('resize', () => applyCamera());
}
