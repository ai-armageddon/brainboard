import type { Camera, ColorKey, Item, Tool } from './types';
import { kvGet, kvSet } from './db';

export const S = {
  items: [] as Item[],
  cam: { x: 0, y: 0, z: 1 } as Camera,
  selected: new Set<string>(),
  tool: 'select' as Tool,
  editing: null as string | null,
  space: false,
  pen: { color: 'ink' as ColorKey, size: 3 },
  last: { note: 'yellow', shape: 'ink', text: 'ink', edge: 'gray' } as Record<'note' | 'shape' | 'text' | 'edge', ColorKey>,
};

export const getItem = (id: string | null | undefined) => (id ? S.items.find((i) => i.id === id) : undefined);

// ---------- history (snapshot based; images live in IndexedDB so snapshots stay small)
const undoStack: string[] = [];
const redoStack: string[] = [];

export function checkpoint() {
  undoStack.push(JSON.stringify(S.items));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function restore(json: string) {
  S.items = JSON.parse(json);
  const ids = new Set(S.items.map((i) => i.id));
  for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
  if (S.editing && !ids.has(S.editing)) S.editing = null;
  changed();
}
export function undo() {
  const s = undoStack.pop();
  if (s === undefined) return;
  redoStack.push(JSON.stringify(S.items));
  restore(s);
}
export function redo() {
  const s = redoStack.pop();
  if (s === undefined) return;
  undoStack.push(JSON.stringify(S.items));
  restore(s);
}

// ---------- render scheduling
let renderFn = () => {};
let raf = 0;
export const setRenderer = (fn: () => void) => { renderFn = fn; };
export function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderFn(); });
}
export function changed() {
  requestRender();
  scheduleSave();
}

// ---------- persistence
let saveTimer = 0;
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 350);
}
export async function saveNow() {
  clearTimeout(saveTimer);
  try {
    await kvSet('board', { v: 1, items: S.items, cam: S.cam, pen: S.pen, last: S.last });
  } catch (err) {
    console.error('brainboard: save failed', err);
  }
}
export async function load(): Promise<boolean> {
  try {
    const d = await kvGet<{ items: Item[]; cam?: Camera; pen?: typeof S.pen; last?: typeof S.last }>('board');
    if (d?.items) {
      S.items = d.items;
      if (d.cam) S.cam = d.cam;
      if (d.pen) S.pen = d.pen;
      if (d.last) S.last = { ...S.last, ...d.last };
      return true;
    }
  } catch (err) {
    console.error('brainboard: load failed', err);
  }
  return false;
}
