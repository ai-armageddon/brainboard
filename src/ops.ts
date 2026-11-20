// Pure helpers shared by the app and the server for item-level sync.
import type { Item } from './types';
import type { Op } from './protocol';

/** Ops that turn the state described by (known, knownOrder) into `items`. */
export function diffItems(
  known: Map<string, string>,
  knownOrder: string[],
  items: Item[],
  key: (it: Item) => string = (it) => JSON.stringify(it),
): Op[] {
  const ops: Op[] = [];
  const ids = new Set<string>();
  for (const it of items) {
    ids.add(it.id);
    if (known.get(it.id) !== key(it)) ops.push({ k: 'put', item: it });
  }
  for (const id of known.keys()) if (!ids.has(id)) ops.push({ k: 'del', id });
  if (!sameOrder(knownOrder, items)) ops.push({ k: 'order', ids: items.map((i) => i.id) });
  return ops;
}

export function sameOrder(order: string[], items: Item[]) {
  if (order.length !== items.length) return false;
  for (let i = 0; i < order.length; i++) if (order[i] !== items[i].id) return false;
  return true;
}

export function applyOps(items: Item[], ops: Op[]): Item[] {
  let out = items.slice();
  let index: Map<string, number> | null = null;
  for (const op of ops) {
    if (op.k === 'put') {
      index ??= new Map(out.map((it, i) => [it.id, i]));
      const i = index.get(op.item.id);
      if (i === undefined) { index.set(op.item.id, out.length); out.push(op.item); }
      else out[i] = op.item;
    } else if (op.k === 'del') {
      out = out.filter((x) => x.id !== op.id);
      index = null;
    } else {
      const pos = new Map(op.ids.map((id, i) => [id, i]));
      out.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
      index = null;
    }
  }
  return out;
}

const TYPES = new Set(['note', 'text', 'shape', 'image', 'stroke', 'edge']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Cheap structural check for items arriving from the network. */
export function validOp(op: unknown): op is Op {
  if (!op || typeof op !== 'object') return false;
  const o = op as Record<string, unknown>;
  if (o.k === 'del') return typeof o.id === 'string' && ID.test(o.id);
  if (o.k === 'order') return Array.isArray(o.ids) && o.ids.every((x) => typeof x === 'string');
  if (o.k === 'put') {
    const it = o.item as Record<string, unknown> | undefined;
    if (!it || typeof it.id !== 'string' || !ID.test(it.id) || !TYPES.has(String(it.type))) return false;
    if (it.type === 'edge') return typeof it.from === 'string' && typeof it.to === 'string';
    return ['x', 'y', 'w', 'h'].every((k) => typeof it[k] === 'number' && Number.isFinite(it[k] as number));
  }
  return false;
}
