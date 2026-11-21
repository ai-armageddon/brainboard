import type { Camera, ColorKey, Item, Tool } from './types';

export const S = {
  items: [] as Item[],
  cam: { x: 0, y: 0, z: 1 } as Camera,
  selected: new Set<string>(),
  tool: 'select' as Tool,
  editing: null as string | null,
  space: false,
  pen: { color: 'ink' as ColorKey, size: 3 },
  eraser: { size: 16, mode: 'partial' as 'partial' | 'whole' },
  last: { note: 'yellow', shape: 'ink', text: 'ink', edge: 'gray' } as Record<'note' | 'shape' | 'text' | 'edge', ColorKey>,
};

export const isBrushTool = (tool: Tool): tool is 'pen' | 'eraser' => tool === 'pen' || tool === 'eraser';

export const getItem = (id: string | null | undefined) => (id ? S.items.find((i) => i.id === id) : undefined);

// ---------------------------------------------------------------- per-user, item-level undo
// An entry remembers only the items *this* user changed, so undo never reverts other people's edits.

interface Entry {
  before: Map<string, string | null>;
  after: Map<string, string | null>;
  beforeOrder?: string[];
  afterOrder?: string[];
}
let open: { pre: Map<string, string>; preOrder: string[]; touched: Set<string>; order: boolean } | null = null;
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];

/** Hook for the sync layer: compute & ship pending local changes now. */
let collect = () => {};
export const setCollector = (fn: () => void) => { collect = fn; };

/** Called by the sync layer for every item this user changed. */
export function noteLocalChange(ids: Iterable<string>, order: boolean) {
  if (!open) return;
  for (const id of ids) open.touched.add(id);
  if (order) open.order = true;
}

function finalize() {
  collect();
  const o = open;
  open = null;
  if (!o || (!o.touched.size && !o.order)) return;
  const now = new Map(S.items.map((i) => [i.id, i]));
  const e: Entry = { before: new Map(), after: new Map() };
  for (const id of o.touched) {
    e.before.set(id, o.pre.get(id) ?? null);
    const cur = now.get(id);
    e.after.set(id, cur ? JSON.stringify(cur) : null);
  }
  if (o.order) {
    e.beforeOrder = o.preOrder;
    e.afterOrder = S.items.map((i) => i.id);
  }
  undoStack.push(e);
  if (undoStack.length > 200) undoStack.shift();
}

/** Call right before changing the board. */
export function checkpoint() {
  finalize();
  open = {
    pre: new Map(S.items.map((i) => [i.id, JSON.stringify(i)])),
    preOrder: S.items.map((i) => i.id),
    touched: new Set(),
    order: false,
  };
  redoStack.length = 0;
}

function applyState(state: Map<string, string | null>, order?: string[]) {
  let items = S.items.slice();
  for (const [id, json] of state) {
    const i = items.findIndex((x) => x.id === id);
    if (json === null) { if (i >= 0) items.splice(i, 1); }
    else if (i >= 0) items[i] = JSON.parse(json);
    else items.push(JSON.parse(json));
  }
  if (order) {
    const pos = new Map(order.map((id, i) => [id, i]));
    items = items.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  }
  S.items = items;
  pruneSelection();
  changed();
}

export const canUndo = () => undoStack.length > 0 || !!open?.touched.size;
export const canRedo = () => redoStack.length > 0;

export function undo() {
  finalize();
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push(e);
  applyState(e.before, e.beforeOrder);
}
export function redo() {
  finalize();
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push(e);
  applyState(e.after, e.afterOrder);
}
export function resetHistory() {
  open = null;
  undoStack.length = 0;
  redoStack.length = 0;
}

export function pruneSelection() {
  const ids = new Set(S.items.map((i) => i.id));
  for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
  if (S.editing && !ids.has(S.editing)) S.editing = null;
}

// ---------------------------------------------------------------- render + sync scheduling
let renderFn = () => {};
let raf = 0;
export const setRenderer = (fn: () => void) => { renderFn = fn; };
export function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderFn(); });
}

let syncFn = () => {};
export const setSyncScheduler = (fn: () => void) => { syncFn = fn; };
/** Something on the board changed locally: redraw and sync. */
export function changed() {
  requestRender();
  syncFn();
}
/** Item sizes were re-measured during render: just sync. */
export const scheduleSave = () => syncFn();

// ---------------------------------------------------------------- per-viewer preferences
const prefKey = 'bb-prefs';
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefKey) ?? '{}');
    if (p.pen) S.pen = { ...S.pen, ...p.pen };
    if (Number.isFinite(p.eraser?.size)) S.eraser.size = Math.max(1, Math.round(p.eraser.size));
    S.eraser.mode = p.eraser?.mode === 'whole' ? 'whole' : 'partial';
    if (p.last) S.last = { ...S.last, ...p.last };
  } catch { /* ignore */ }
}
let prefTimer = 0;
export function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = window.setTimeout(() => {
    try { localStorage.setItem(prefKey, JSON.stringify({ pen: S.pen, eraser: S.eraser, last: S.last })); } catch { /* ignore */ }
  }, 300);
}
