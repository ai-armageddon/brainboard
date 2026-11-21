// Pen strokes while they're being drawn. Ours stream out in small batches; other people's are drawn
// as the points arrive, so everyone watches a stroke appear instead of seeing it pop in at the end.
// Nothing here is saved: the finished stroke arrives as a normal item (same id) and replaces the preview.
import { events, sendInk, session } from './net';
import { getItem } from './state';
import { strokePath } from './geometry';
import type { Ink } from './protocol';
import type { ColorKey } from './types';

const round = (v: number) => Math.round(v * 100) / 100;
const pathOf = (p: number[]) => strokePath(p.length === 2 ? [...p, p[0] + 0.01, p[1]] : p);

// ---------------------------------------------------------------- outgoing

let out: { id: string; color: ColorKey; size: number; pts: number[]; sent: number } | null = null;
let flushTimer = 0;

function flush(end?: 'done' | 'cancel') {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!out) return;
  const add = out.pts.slice(out.sent).map(round);
  out.sent = out.pts.length;
  // Alone on the board: nobody to show it to.
  if (!session.peers.size) return;
  if (!add.length && !end) return;
  sendInk({ id: out.id, color: out.color, size: round(out.size), add, ...(end ? { end } : {}) });
}

/** Start streaming a stroke. `pts` is the live array the pen keeps appending to. */
export function inkStart(id: string, color: ColorKey, size: number, pts: number[]) {
  out = { id, color, size, pts, sent: 0 };
  flush();
}

/** The stroke grew: send the new points soon (batched ~25 times a second). */
export function inkMove() {
  if (out && !flushTimer) flushTimer = window.setTimeout(() => flush(), 40);
}

export function inkEnd(end: 'done' | 'cancel') {
  flush(end);
  out = null;
}

// ---------------------------------------------------------------- incoming

const SVG = 'http://www.w3.org/2000/svg';
const remote = new Map<string, { id: string; from: string; path: SVGPathElement; pts: number[]; timer: number }>();

function drop(key: string) {
  const r = remote.get(key);
  if (!r) return;
  clearTimeout(r.timer);
  r.path.remove();
  remote.delete(key);
}

function onInk(from: string, ink: Ink) {
  const key = `${from}:${ink.id}`;
  let r = remote.get(key);
  if (ink.end === 'cancel') return drop(key);
  if (!r) {
    if (getItem(ink.id)) return; // the finished stroke beat its last preview batch here
    const path = document.createElementNS(SVG, 'path');
    path.classList.add('ink');
    path.style.stroke = `var(--s-${ink.color})`;
    path.style.strokeWidth = `${ink.size}px`;
    document.getElementById('live')!.append(path);
    r = { id: ink.id, from, path, pts: [], timer: 0 };
    remote.set(key, r);
  }
  for (const v of ink.add) r.pts.push(v);
  if (r.pts.length >= 2) r.path.setAttribute('d', pathOf(r.pts));
  // Safety net: if the finished stroke never shows up (they lost connection), let the preview go.
  clearTimeout(r.timer);
  r.timer = window.setTimeout(() => drop(key), ink.end === 'done' ? 4000 : 8000);
}

export function initInk() {
  events.addEventListener('ink', (e) => {
    const { from, ink } = (e as CustomEvent<{ from: string; ink: Ink }>).detail;
    onInk(from, ink);
  });
  // The real stroke has arrived: swap the preview out in the same frame it's first drawn.
  events.addEventListener('remote-ops', () => {
    const done = [...remote].filter(([, r]) => getItem(r.id)).map(([k]) => k);
    if (done.length) requestAnimationFrame(() => done.forEach(drop));
  });
  // Someone left mid-stroke, or we switched boards.
  events.addEventListener('peers', () => {
    for (const [k, r] of remote) if (!session.peers.has(r.from)) drop(k);
  });
  events.addEventListener('welcome', () => { for (const k of [...remote.keys()]) drop(k); });
}
