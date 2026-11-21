import { S, setRenderer, scheduleSave } from './state';
import type { Box, Item, NodeItem } from './types';
import { edgeGeom, shapePath, strokePath, unionBox } from './geometry';
import { drawText } from './format';
import { imageUrl } from './net';

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T;
export const viewport = q<HTMLDivElement>('#viewport');
export const world = q<HTMLDivElement>('#world');
export const marquee = q<HTMLDivElement>('#marquee');
const itemsLayer = q<HTMLDivElement>('#items');
const edgesSvg = q<SVGSVGElement>('#edges');
const labelsLayer = q<HTMLDivElement>('#labels');
const selbox = q<HTMLDivElement>('#selbox');
export const live = {
  stroke: q<SVGPathElement>('#live .live-stroke'),
  edge: q<SVGPathElement>('#live .live-edge'),
  arrow: q<SVGPathElement>('#live .live-arrow'),
};

/** UI hooks so render doesn't import the UI module. */
export const hooks = { afterRender: () => {}, afterCamera: () => {} };
/** World-space bounds of the current selection (for the context toolbar). */
export let selBounds: Box | null = null;

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

type NodeEl = HTMLDivElement & { _k?: unknown; _txt?: HTMLDivElement };
const els = new Map<string, NodeEl>();
interface EdgeEls { g: SVGGElement; hit: SVGPathElement; line: SVGPathElement; arrow: SVGPathElement; label: HTMLDivElement; txt: HTMLDivElement }
const edgeEls = new Map<string, EdgeEls>();

export const textElOf = (id: string): HTMLDivElement | null =>
  els.get(id)?._txt ?? edgeEls.get(id)?.txt ?? null;
export const nodeElOf = (id: string) => els.get(id);

function makeTxt(): HTMLDivElement {
  const t = document.createElement('div');
  t.className = 'txt';
  t.spellcheck = false;
  return t;
}

function createNodeEl(it: NodeItem): NodeEl {
  const el = document.createElement('div') as NodeEl;
  el.className = `item ${it.type}`;
  el.dataset.id = it.id;
  el.dataset.type = it.type;
  if (it.type === 'image') {
    const img = document.createElement('img');
    img.draggable = false;
    img.alt = '';
    el.append(img);
  } else if (it.type === 'stroke') {
    const svg = svgEl('svg');
    svg.append(svgEl('path', { class: 'hit' }), svgEl('path', { class: 'ink' }));
    el.append(svg);
  } else {
    if (it.type === 'shape') {
      const svg = svgEl('svg', { class: 'bg' });
      svg.append(svgEl('path'));
      el.append(svg);
    }
    el._txt = makeTxt();
    el.append(el._txt);
  }
  if (it.type !== 'stroke') {
    for (const side of ['n', 'e', 's', 'w']) {
      const p = document.createElement('div');
      p.className = 'port';
      p.dataset.side = side;
      el.append(p);
    }
  }
  return el;
}

function updateNodeEl(el: NodeEl, it: NodeItem, z: number) {
  const st = el.style;
  st.transform = `translate(${it.x}px,${it.y}px)`;
  st.zIndex = String(z);
  const sel = S.selected.has(it.id);
  el.classList.toggle('selected', sel);
  el.classList.toggle('solo', sel && S.selected.size === 1);
  if ('color' in it) {
    st.setProperty('--f', `var(--f-${it.color})`);
    st.setProperty('--s', `var(--s-${it.color})`);
  }
  if ('fs' in it) st.fontSize = `${it.fs}px`;

  switch (it.type) {
    case 'note':
      st.width = `${it.w}px`;
      st.minHeight = `${it.h}px`;
      break;
    case 'shape': {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      el.dataset.shape = it.shape;
      const sw = it.fs / 8;
      const key = `${it.shape}|${it.w}|${it.h}|${sw}`;
      if (el._k !== key) {
        el._k = key;
        const path = el.firstElementChild!.firstElementChild as SVGPathElement;
        path.setAttribute('d', shapePath(it.shape, it.w, it.h, sw / 2));
        path.style.strokeWidth = `${sw}px`;
      }
      break;
    }
    case 'image': {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const img = el.firstElementChild as HTMLImageElement;
      const u = imageUrl(it.blob);
      if (img.getAttribute('src') !== u) img.src = u;
      break;
    }
    case 'stroke': {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const svg = el.firstElementChild as SVGSVGElement;
      const hit = svg.firstElementChild as SVGPathElement;
      const ink = svg.lastElementChild as SVGPathElement;
      if (el._k !== it.points) {
        el._k = it.points;
        const d = strokePath(it.points);
        hit.setAttribute('d', d);
        ink.setAttribute('d', d);
      }
      ink.style.strokeWidth = `${it.size}px`;
      hit.style.strokeWidth = `calc(${it.size}px + 14px * var(--iz))`;
      break;
    }
  }

  if (el._txt && 'text' in it) {
    const editing = S.editing === it.id;
    el.classList.toggle('editing', editing);
    if (!editing) drawText(el._txt, it.text, it.runs);
  }
}

function createEdgeEls(id: string): EdgeEls {
  const g = svgEl('g', { class: 'edge' });
  g.dataset.id = id;
  const hit = svgEl('path', { class: 'hit' });
  const line = svgEl('path', { class: 'line' });
  const arrow = svgEl('path', { class: 'arrow' });
  g.append(hit, line, arrow);
  edgesSvg.append(g);
  const label = document.createElement('div');
  label.className = 'edge-label';
  label.dataset.id = id;
  const txt = makeTxt();
  label.append(txt);
  labelsLayer.append(label);
  return { g, hit, line, arrow, label, txt };
}

const edgeMids = new Map<string, { x: number; y: number }>();

function renderEdges(map: Map<string, Item>) {
  const seen = new Set<string>();
  edgeMids.clear();
  for (const it of S.items) {
    if (it.type !== 'edge') continue;
    const a = map.get(it.from), b = map.get(it.to);
    if (!a || !b || a.type === 'edge' || b.type === 'edge') continue;
    seen.add(it.id);
    let e = edgeEls.get(it.id);
    if (!e) { e = createEdgeEls(it.id); edgeEls.set(it.id, e); }
    const g = edgeGeom(a, b, it.sw);
    edgeMids.set(it.id, g.mid);
    e.hit.setAttribute('d', g.d);
    e.line.setAttribute('d', g.d);
    e.arrow.setAttribute('d', g.arrow);
    e.line.style.strokeWidth = `${it.sw}px`;
    const color = `var(--s-${it.color})`;
    e.g.style.setProperty('--s', color);
    e.label.style.setProperty('--s', color);
    const sel = S.selected.has(it.id);
    e.g.classList.toggle('selected', sel);
    e.label.classList.toggle('selected', sel);
    const editing = S.editing === it.id;
    const show = editing || it.label.length > 0;
    e.label.style.display = show ? '' : 'none';
    e.label.classList.toggle('editing', editing);
    if (show) {
      e.label.style.transform = `translate(${g.mid.x}px,${g.mid.y}px) translate(-50%,-50%)`;
      e.label.style.fontSize = `${it.fs}px`;
      if (!editing) drawText(e.txt, it.label, it.runs);
    }
  }
  for (const [id, e] of edgeEls) {
    if (!seen.has(id)) { e.g.remove(); e.label.remove(); edgeEls.delete(id); }
  }
}

function renderSelection(map: Map<string, Item>) {
  const nodes: NodeItem[] = [];
  const mids: Box[] = [];
  for (const id of S.selected) {
    const it = map.get(id);
    if (!it) continue;
    if (it.type === 'edge') {
      const m = edgeMids.get(id);
      if (m) mids.push({ x: m.x, y: m.y, w: 0, h: 0 });
    } else nodes.push(it);
  }
  if (nodes.length) {
    const b = unionBox(nodes);
    selBounds = b;
    selbox.style.display = 'block';
    selbox.style.transform = `translate(${b.x}px,${b.y}px)`;
    selbox.style.width = `${b.w}px`;
    selbox.style.height = `${b.h}px`;
    selbox.classList.toggle('multi', nodes.length > 1);
    selbox.classList.toggle('no-handles', S.editing !== null);
  } else {
    selbox.style.display = 'none';
    selBounds = mids.length ? unionBox(mids) : null;
  }
}

export function render() {
  const map = new Map<string, Item>();
  for (const it of S.items) map.set(it.id, it);

  const seen = new Set<string>();
  S.items.forEach((it, i) => {
    if (it.type === 'edge') return;
    seen.add(it.id);
    let el = els.get(it.id);
    if (!el || el.dataset.type !== it.type) {
      el?.remove();
      el = createNodeEl(it);
      els.set(it.id, el);
      itemsLayer.append(el);
    }
    updateNodeEl(el, it, i + 1);
  });
  for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }

  // Notes grow with their content; text items size to their content.
  let resized = false;
  for (const it of S.items) {
    if (it.type !== 'note' && it.type !== 'text') continue;
    const el = els.get(it.id)!;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (it.type === 'text' && w && Math.abs(w - it.w) > 0.5) { it.w = w; resized = true; }
    if (h && Math.abs(h - it.h) > 0.5) { it.h = h; resized = true; }
  }
  if (resized) scheduleSave();

  renderEdges(map);
  renderSelection(map);
  hooks.afterRender();
}
setRenderer(render);

export function applyCamera() {
  const { x, y, z } = S.cam;
  world.style.transform = `translate(${x}px,${y}px) scale(${z})`;
  world.style.setProperty('--iz', String(1 / z));
  let g = 24 * z;
  while (g < 14) g *= 4;
  while (g > 56) g /= 4;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  hooks.afterCamera();
}
