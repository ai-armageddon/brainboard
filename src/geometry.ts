import type { Box, Pt, ShapeKind } from './types';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function unionBox(bs: Box[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const contains = (o: Box, i: Box) =>
  i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;

export const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Smooth freehand path through midpoints (quadratic Béziers). */
export function strokePath(p: number[]): string {
  const n = p.length;
  if (n < 2) return '';
  if (n <= 4) return `M${r2(p[0])} ${r2(p[1])}L${r2(p[n - 2])} ${r2(p[n - 1])}`;
  let d = `M${r2(p[0])} ${r2(p[1])}`;
  for (let i = 2; i < n - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    d += `Q${r2(p[i])} ${r2(p[i + 1])} ${r2(mx)} ${r2(my)}`;
  }
  return d + `L${r2(p[n - 2])} ${r2(p[n - 1])}`;
}

function roundRect(w: number, h: number, r: number, i: number) {
  r = Math.max(0, Math.min(r, (w - 2 * i) / 2, (h - 2 * i) / 2));
  return `M${i + r} ${i}H${w - i - r}A${r} ${r} 0 0 1 ${w - i} ${i + r}V${h - i - r}A${r} ${r} 0 0 1 ${w - i - r} ${h - i}H${i + r}A${r} ${r} 0 0 1 ${i} ${h - i - r}V${i + r}A${r} ${r} 0 0 1 ${i + r} ${i}Z`;
}

export function shapePath(kind: ShapeKind, w: number, h: number, inset: number): string {
  const i = inset;
  switch (kind) {
    case 'ellipse': {
      const rx = Math.max(0, w / 2 - i), ry = Math.max(0, h / 2 - i);
      return `M${i} ${h / 2}A${rx} ${ry} 0 1 0 ${w - i} ${h / 2}A${rx} ${ry} 0 1 0 ${i} ${h / 2}Z`;
    }
    case 'pill':
      return roundRect(w, h, Math.min(w, h) / 2, i);
    case 'rect':
      return roundRect(w, h, Math.min(14, w / 5, h / 4) + i, i);
    case 'diamond':
      return `M${w / 2} ${i}L${w - i} ${h / 2}L${w / 2} ${h - i}L${i} ${h / 2}Z`;
  }
}

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/** A soft S-curve between the facing sides of two boxes, plus an arrowhead. */
export function edgeGeom(a: Box, b: Box, sw: number) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const horiz = Math.abs(dx) / ((a.w + b.w) / 2 || 1) >= Math.abs(dy) / ((a.h + b.h) / 2 || 1);
  let p0: Pt, p3: Pt, c1: Pt, c2: Pt, u: Pt;
  if (horiz) {
    const s = dx >= 0 ? 1 : -1;
    p0 = { x: ac.x + (s * a.w) / 2, y: ac.y };
    p3 = { x: bc.x - (s * b.w) / 2, y: bc.y };
    const k = Math.max(Math.abs(p3.x - p0.x) / 2, sw * 12);
    c1 = { x: p0.x + s * k, y: p0.y };
    c2 = { x: p3.x - s * k, y: p3.y };
    u = { x: s, y: 0 };
  } else {
    const s = dy >= 0 ? 1 : -1;
    p0 = { x: ac.x, y: ac.y + (s * a.h) / 2 };
    p3 = { x: bc.x, y: bc.y - (s * b.h) / 2 };
    const k = Math.max(Math.abs(p3.y - p0.y) / 2, sw * 12);
    c1 = { x: p0.x, y: p0.y + s * k };
    c2 = { x: p3.x, y: p3.y - s * k };
    u = { x: 0, y: s };
  }
  const gap = sw * 1.5, L = sw * 5, W = sw * 3.2;
  const tip = { x: p3.x - u.x * gap, y: p3.y - u.y * gap };
  const base = { x: tip.x - u.x * L, y: tip.y - u.y * L };
  const nx = -u.y, ny = u.x;
  const arrow = `M${r2(tip.x)} ${r2(tip.y)}L${r2(base.x + nx * W)} ${r2(base.y + ny * W)}L${r2(base.x - nx * W)} ${r2(base.y - ny * W)}Z`;
  const end = { x: base.x + u.x * L * 0.3, y: base.y + u.y * L * 0.3 };
  const c2b = { x: c2.x - u.x * (gap + L * 0.7), y: c2.y - u.y * (gap + L * 0.7) };
  const d = `M${r2(p0.x)} ${r2(p0.y)}C${r2(c1.x)} ${r2(c1.y)} ${r2(c2b.x)} ${r2(c2b.y)} ${r2(end.x)} ${r2(end.y)}`;
  const mid = { x: bez(p0.x, c1.x, c2.x, p3.x, 0.5), y: bez(p0.y, c1.y, c2.y, p3.y, 0.5) };
  return { d, arrow, mid };
}
