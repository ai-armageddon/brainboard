import { S, changed, checkpoint, getItem, requestRender } from './state';
import type { Box, Camera, ColorKey, EdgeItem, Item, NodeItem, ShapeKind, TextualItem, Tool } from './types';
import { applyCamera, render, textElOf, viewport } from './render';
import { api, canEdit, imageUrl, session } from './net';
import { clamp, intersects, unionBox } from './geometry';
import { toast, updateToolUI } from './ui';

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const isNode = (it: Item | undefined): it is NodeItem => !!it && it.type !== 'edge';
export const isTextual = (it: Item | undefined): it is TextualItem =>
  !!it && (it.type === 'note' || it.type === 'text' || it.type === 'shape');
export const canEditText = (it: Item | undefined) => isTextual(it) || it?.type === 'edge';

// ---------------------------------------------------------------- tools & selection

export function setTool(t: Tool) {
  if (S.editing) stopEditing();
  S.tool = t;
  if (t !== 'select' && t !== 'hand') S.selected.clear();
  viewport.dataset.tool = t;
  updateToolUI();
  requestRender();
}

export function selectIds(ids: Iterable<string>) {
  S.selected = new Set(ids);
  requestRender();
}

export function selectAll() {
  selectIds(S.items.filter(isNode).map((i) => i.id));
}

/** Selected nodes plus every edge whose both ends are selected (or that is itself selected and attached). */
export function selectionItems(): Item[] {
  const ids = S.selected;
  return S.items.filter((it) => (it.type === 'edge' ? ids.has(it.from) && ids.has(it.to) : ids.has(it.id)));
}

export function deleteSelection() {
  if (!S.selected.size) return;
  stopEditing();
  checkpoint();
  const del = new Set(S.selected);
  S.items = S.items.filter((it) => !del.has(it.id) && !(it.type === 'edge' && (del.has(it.from) || del.has(it.to))));
  S.selected.clear();
  changed();
}

export function cloneItems(src: Item[], dx: number, dy: number): Item[] {
  const ids = new Map<string, string>();
  const out: Item[] = [];
  for (const it of src) {
    if (it.type === 'edge') continue;
    const n = structuredClone(it);
    n.id = uid();
    n.x += dx;
    n.y += dy;
    ids.set(it.id, n.id);
    out.push(n);
  }
  for (const it of src) {
    if (it.type !== 'edge' || !ids.has(it.from) || !ids.has(it.to)) continue;
    out.push({ ...structuredClone(it), id: uid(), from: ids.get(it.from)!, to: ids.get(it.to)! });
  }
  return out;
}

/** Caller is responsible for checkpoint(). */
export function duplicateSelection(offset: number) {
  stopEditing();
  const out = cloneItems(selectionItems(), offset, offset);
  if (!out.length) return;
  S.items.push(...out);
  S.selected = new Set(out.filter(isNode).map((i) => i.id));
  changed();
}

export function pasteItems(items: Item[], at: { x: number; y: number }) {
  const nodes = items.filter(isNode);
  if (!nodes.length) return;
  const b = unionBox(nodes);
  const out = cloneItems(items, at.x - (b.x + b.w / 2), at.y - (b.y + b.h / 2));
  checkpoint();
  S.items.push(...out);
  S.selected = new Set(out.filter(isNode).map((i) => i.id));
  if (S.tool !== 'select') setTool('select');
  changed();
}

export function reorder(front: boolean) {
  if (!S.selected.size) return;
  checkpoint();
  const sel = S.items.filter((i) => S.selected.has(i.id));
  const rest = S.items.filter((i) => !S.selected.has(i.id));
  S.items = front ? [...rest, ...sel] : [...sel, ...rest];
  changed();
}

export function nudge(dx: number, dy: number) {
  const nodes = S.items.filter((i): i is NodeItem => isNode(i) && S.selected.has(i.id));
  if (!nodes.length) return;
  checkpoint();
  for (const n of nodes) { n.x += dx; n.y += dy; }
  changed();
}

// ---------------------------------------------------------------- style

export function setColor(c: ColorKey) {
  const its = S.items.filter((i) => S.selected.has(i.id) && 'color' in i) as (Item & { color: ColorKey })[];
  if (!its.length) return;
  checkpoint();
  for (const it of its) {
    it.color = c;
    if (it.type === 'note' || it.type === 'shape' || it.type === 'text' || it.type === 'edge') S.last[it.type] = c;
  }
  changed();
}

export function setShape(kind: ShapeKind) {
  const its = S.items.filter((i) => S.selected.has(i.id) && i.type === 'shape');
  if (!its.length) return;
  checkpoint();
  for (const it of its) if (it.type === 'shape') it.shape = kind;
  changed();
}

export function bumpFont(f: number) {
  const its = S.items.filter((i) => S.selected.has(i.id) && 'fs' in i) as (Item & { fs: number })[];
  if (!its.length) return;
  checkpoint();
  for (const it of its) it.fs = clamp(it.fs * f, 2, 4000);
  changed();
}

// ---------------------------------------------------------------- creating things

export function defaultSize(kind: 'note' | 'text' | ShapeKind) {
  const k = 1 / S.cam.z;
  switch (kind) {
    case 'note': return { w: 200 * k, h: 200 * k };
    case 'ellipse': return { w: 170 * k, h: 100 * k };
    case 'pill': return { w: 180 * k, h: 72 * k };
    case 'rect': return { w: 170 * k, h: 90 * k };
    case 'diamond': return { w: 150 * k, h: 120 * k };
    default: return { w: 0, h: 0 };
  }
}

/** Caller is responsible for checkpoint(). */
export function createNode(kind: 'note' | 'text' | ShapeKind, box: Box): TextualItem {
  const k = 1 / S.cam.z;
  const { x, y, w, h } = box;
  let it: TextualItem;
  if (kind === 'note') it = { id: uid(), type: 'note', x, y, w, h, text: '', color: S.last.note, fs: 16 * k };
  else if (kind === 'text') it = { id: uid(), type: 'text', x, y, w, h, text: '', color: S.last.text, fs: 22 * k };
  else it = { id: uid(), type: 'shape', shape: kind, x, y, w, h, text: '', color: S.last.shape, fs: 16 * k };
  S.items.push(it);
  return it;
}

export function makeEdge(from: string, to: string): EdgeItem {
  const src = getItem(from);
  const sw = src && (src.type === 'shape' || src.type === 'note') ? src.fs / 8 : 2 / S.cam.z;
  return { id: uid(), type: 'edge', from, to, label: '', color: S.last.edge, fs: sw * 7, sw };
}

/** A blank node shaped like `src` (used for "add connected bubble"). Not yet added to the board. */
export function siblingOf(src: NodeItem): NodeItem {
  if (src.type === 'shape' || src.type === 'note') return { ...structuredClone(src), id: uid(), text: '' };
  const sz = defaultSize('ellipse');
  return { id: uid(), type: 'shape', shape: 'ellipse', x: 0, y: 0, w: sz.w, h: sz.h, text: '', color: S.last.shape, fs: 16 / S.cam.z };
}

export type Side = 'n' | 'e' | 's' | 'w';

export function createSibling(id: string, side: Side = 'e') {
  const src = getItem(id);
  if (!isNode(src) || src.type === 'stroke') return;
  stopEditing();
  const n = siblingOf(src);
  const gap = Math.max(src.w, src.h) * 0.35 + 24 / S.cam.z;
  const cx = src.x + src.w / 2, cy = src.y + src.h / 2;
  if (side === 'e') { n.x = src.x + src.w + gap; n.y = cy - n.h / 2; }
  else if (side === 'w') { n.x = src.x - gap - n.w; n.y = cy - n.h / 2; }
  else if (side === 's') { n.y = src.y + src.h + gap; n.x = cx - n.w / 2; }
  else { n.y = src.y - gap - n.h; n.x = cx - n.w / 2; }

  // Step sideways until there's free space so siblings fan out instead of stacking.
  const others = S.items.filter(isNode);
  const pad = gap * 0.25;
  for (let i = 0; i < 60; i++) {
    const probe = { x: n.x - pad, y: n.y - pad, w: n.w + pad * 2, h: n.h + pad * 2 };
    if (!others.some((o) => intersects(probe, o))) break;
    if (side === 'e' || side === 'w') n.y += n.h + gap * 0.4;
    else n.x += n.w + gap * 0.4;
  }

  checkpoint();
  S.items.push(n, makeEdge(src.id, n.id));
  S.selected = new Set([n.id]);
  changed();
  if (isTextual(n)) startEditing(n.id);
  else panIntoView(n);
}

function panIntoView(b: Box) {
  const { x, y, z } = S.cam;
  const L = b.x * z + x, T = b.y * z + y, R = L + b.w * z, B = T + b.h * z;
  const m = 80;
  let dx = 0, dy = 0;
  if (R > innerWidth - m) dx = innerWidth - m - R;
  if (L + dx < m) dx = m - L;
  if (B > innerHeight - m) dy = innerHeight - m - B;
  if (T + dy < m) dy = m - T;
  if (dx || dy) animateCam({ x: x + dx, y: y + dy, z });
}

// ---------------------------------------------------------------- text editing

export function startEditing(id: string) {
  const it = getItem(id);
  if (!canEditText(it)) return;
  if (S.editing && S.editing !== id) stopEditing();
  S.editing = id;
  S.selected = new Set([id]);
  render();
  const t = textElOf(id);
  if (!t) return;
  try { t.contentEditable = 'plaintext-only'; } catch { t.contentEditable = 'true'; }
  t.classList.add('editing');
  t.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(t);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  if (isNode(it)) panIntoView(it);
}

export function stopEditing() {
  const id = S.editing;
  if (!id) return;
  S.editing = null;
  const t = textElOf(id);
  const it = getItem(id);
  if (t) {
    t.contentEditable = 'false';
    t.classList.remove('editing');
  }
  if (it && t) {
    const text = t.innerText.replace(/\n+$/, '');
    if (it.type === 'edge') {
      if (text !== it.label) { checkpoint(); it.label = text; }
    } else if (isTextual(it)) {
      if (text !== it.text) { checkpoint(); it.text = text; }
      if (it.type === 'text' && !text.trim()) {
        S.items = S.items.filter((i) => i !== it && !(i.type === 'edge' && (i.from === it.id || i.to === it.id)));
        S.selected.delete(it.id);
      }
    }
  }
  getSelection()?.removeAllRanges();
  changed();
}

// ---------------------------------------------------------------- images

function loadImage(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = url;
  });
}

export async function addImages(files: File[], at: { x: number; y: number }) {
  if (!canEdit()) return;
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  const k = 1 / S.cam.z;
  const created: NodeItem[] = [];
  let off = 0;
  for (const f of imgs) {
    const url = URL.createObjectURL(f);
    const dims = await loadImage(url);
    URL.revokeObjectURL(url);
    let blob: string;
    try {
      blob = await api.uploadImage(f);
    } catch {
      toast('Could not upload that image');
      continue;
    }
    const s = Math.min(1, 520 / Math.max(dims.w, dims.h));
    const w = dims.w * s * k, h = dims.h * s * k;
    created.push({ id: uid(), type: 'image', blob, x: at.x - w / 2 + off, y: at.y - h / 2 + off, w, h });
    off += 24 * k;
  }
  if (!created.length) return;
  stopEditing();
  checkpoint();
  S.items.push(...created);
  if (S.tool !== 'select') setTool('select');
  S.selected = new Set(created.map((c) => c.id));
  changed();
}

// ---------------------------------------------------------------- camera

export const screenToWorld = (cx: number, cy: number) => ({ x: (cx - S.cam.x) / S.cam.z, y: (cy - S.cam.y) / S.cam.z });
export const viewCenter = () => screenToWorld(innerWidth / 2, innerHeight / 2);

export const MIN_Z = 0.03, MAX_Z = 8;

let anim = 0;
export function stopCamAnim() { cancelAnimationFrame(anim); anim = 0; }

export function zoomAt(cx: number, cy: number, nz: number) {
  stopCamAnim();
  nz = clamp(nz, MIN_Z, MAX_Z);
  const { x, y, z } = S.cam;
  const wx = (cx - x) / z, wy = (cy - y) / z;
  S.cam = { x: cx - wx * nz, y: cy - wy * nz, z: nz };
  applyCamera();
}

export function animateCam(to: Camera, ms = 260) {
  stopCamAnim();
  const vw = innerWidth / 2, vh = innerHeight / 2;
  const from = { ...S.cam };
  const c0 = { x: (vw - from.x) / from.z, y: (vh - from.y) / from.z };
  const c1 = { x: (vw - to.x) / to.z, y: (vh - to.y) / to.z };
  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    const z = Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * e);
    const cx = c0.x + (c1.x - c0.x) * e, cy = c0.y + (c1.y - c0.y) * e;
    S.cam = { x: vw - cx * z, y: vh - cy * z, z };
    applyCamera();
    anim = p < 1 ? requestAnimationFrame(step) : 0;
  };
  anim = requestAnimationFrame(step);
}

export function zoomBy(f: number) {
  const nz = clamp(S.cam.z * f, MIN_Z, MAX_Z);
  setZoom(nz);
}

export function setZoom(nz: number) {
  const c = viewCenter();
  animateCam({ x: innerWidth / 2 - c.x * nz, y: innerHeight / 2 - c.y * nz, z: nz });
}

export function zoomToFit() {
  const ns = S.items.filter(isNode);
  if (!ns.length) {
    animateCam({ x: innerWidth / 2, y: innerHeight / 2, z: 1 });
    return;
  }
  const b = unionBox(ns);
  const pad = 96;
  const z = clamp(Math.min((innerWidth - pad * 2) / (b.w || 1), (innerHeight - pad * 2) / (b.h || 1)), MIN_Z, 1.5);
  animateCam({ x: innerWidth / 2 - (b.x + b.w / 2) * z, y: innerHeight / 2 - (b.y + b.h / 2) * z, z });
}

// ---------------------------------------------------------------- board files

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

export async function exportBoard() {
  stopEditing();
  const blobs: Record<string, string> = {};
  for (const it of S.items) {
    if (it.type !== 'image' || blobs[it.blob]) continue;
    const res = await fetch(imageUrl(it.blob));
    if (res.ok) blobs[it.blob] = await blobToDataUrl(await res.blob());
  }
  const data = { app: 'brainboard', version: 1, name: session.boardName, items: S.items, blobs };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `${(session.boardName || 'brainboard').replace(/[^\w\- ]+/g, '').trim() || 'brainboard'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Board exported');
}

/** Import an exported .json as a new board (never overwrites the current one). */
export async function importBoard(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'brainboard' || !Array.isArray(data.items)) throw new Error('not a board');
    toast('Importing…');
    for (const [id, url] of Object.entries(data.blobs ?? {})) {
      const b = await (await fetch(String(url))).blob();
      await api.uploadImage(b, id);
    }
    const name = String(data.name ?? file.name.replace(/\.json$/i, '').replace(/^brainboard-/, 'Imported ')).slice(0, 80);
    const meta = await api.createBoard(name, data.items);
    location.hash = meta.id;
    toast(`Imported as “${meta.name}”`);
  } catch {
    toast('That file isn’t a brainboard export');
  }
}

export function clearBoard() {
  if (!S.items.length) return;
  stopEditing();
  checkpoint();
  S.items = [];
  S.selected.clear();
  changed();
  toast('Board cleared · ⌘Z to undo');
}
