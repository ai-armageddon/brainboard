// Beauty mode for the pen. What it does to a stroke:
//   1. Smoothing: the line is evened out over a few screen pixels of its length, live while you draw and again when
//      you lift, so hand and trackpad wobble disappear. Handwriting reads much cleaner.
//   2. Tapering: freehand ink becomes a filled outline that thins at its ends and on fast moves, like a real pen.
//   3. Shapes: an obvious line, circle, ellipse, triangle or box comes out clean. A rougher attempt at one is tidied
//      instead: pulled most of the way toward the real shape while keeping the hand-drawn ink. Holding still at the end
//      of a stroke always snaps it clean, and also straightens zigzags and arrows.
import Clipper from 'clipper-lib';
import { distToSeg } from './geometry';

/** Where the next steadied point goes. `amount` 0 = raw pointer, closer to 1 = smoother but laggier. */
export function steady(lx: number, ly: number, x: number, y: number, amount = 0.3) {
  return { x: lx + (x - lx) * (1 - amount), y: ly + (y - ly) * (1 - amount) };
}

type P = { x: number; y: number };
const toPts = (f: number[]) => { const o: P[] = []; for (let i = 0; i + 1 < f.length; i += 2) o.push({ x: f[i], y: f[i + 1] }); return o; };
const flat = (ps: P[]) => ps.flatMap((p) => [p.x, p.y]);
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
function lengthOf(ps: P[]) { let l = 0; for (let i = 1; i < ps.length; i++) l += dist(ps[i - 1], ps[i]); return l; }
function boundsOf(ps: P[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ps) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Points every `step` along the path (and its last point). */
function resample(ps: P[], step: number): P[] {
  if (ps.length < 2 || step <= 0) return ps.slice();
  const out = [ps[0]];
  let carry = 0;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1], b = ps[i];
    const seg = dist(a, b);
    let t = step - carry;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = ps[ps.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push(last);
  return out;
}

// ---------------------------------------------------------------- smoothing

/**
 * Even out a freehand line: resample it finely, then Gaussian-smooth along its length. The window narrows toward the
 * ends, so the stroke still starts and finishes exactly where the pen did. Works in screen pixels via the zoom `z`.
 */
export function smoothLine(points: number[], size: number, z: number): number[] {
  const ps = toPts(points);
  if (ps.length < 3) return points.slice();
  const step = 1 / z;
  const rs = resample(ps, step);
  if (rs.length < 5) return flat(rs);
  // ~3 px of smoothing for fine writing, a little more for thick markers.
  const sigma = Math.max(3, Math.min(7, size * z * 0.6));
  const half = Math.ceil(sigma * 2.5);
  const w = Array.from({ length: half + 1 }, (_, j) => Math.exp(-(j * j) / (2 * sigma * sigma)));
  const out: P[] = [];
  for (let i = 0; i < rs.length; i++) {
    const k = Math.min(half, i, rs.length - 1 - i);
    let sx = 0, sy = 0, sw = 0;
    for (let j = -k; j <= k; j++) {
      const wt = w[Math.abs(j)];
      sx += rs[i + j].x * wt; sy += rs[i + j].y * wt; sw += wt;
    }
    out.push({ x: sx / sw, y: sy / sw });
  }
  // Keep about one point every 1.5 px: plenty for smooth curves, no bloat.
  const kept = [out[0]];
  for (let i = 1; i < out.length - 1; i++) if (dist(kept[kept.length - 1], out[i]) * z >= 1.5) kept.push(out[i]);
  kept.push(out[out.length - 1]);
  return flat(kept);
}

// ---------------------------------------------------------------- shapes

/** Ramer–Douglas–Peucker: the few points that keep a path's shape within `eps`. */
function simplify(ps: P[], eps: number): P[] {
  if (ps.length < 3) return ps.slice();
  const keep = new Uint8Array(ps.length);
  keep[0] = keep[ps.length - 1] = 1;
  const stack: [number, number][] = [[0, ps.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, best = eps;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(ps[i].x, ps[i].y, ps[a].x, ps[a].y, ps[b].x, ps[b].y);
      if (d > best) { best = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return ps.filter((_, i) => keep[i]);
}

/** Nearest point on a polyline. */
function onPolyline(p: P, poly: P[]): P {
  let best = poly[0], bd = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
const meanDistTo = (ps: P[], poly: P[]) => ps.reduce((s, p) => s + dist(p, onPolyline(p, poly)), 0) / ps.length;

/** Snap an angle to the nearest multiple of `step` when it's within `tol` radians. */
function snapAngle(a: number, step = Math.PI / 4, tol = (7 * Math.PI) / 180) {
  const s = Math.round(a / step) * step;
  return Math.abs(a - s) < tol ? s : a;
}

/** Repeat each corner so the midpoint curves in strokePath draw sharp corners and straight sides. */
const sharp = (ps: P[]) => flat(ps.flatMap((p) => [p, p]));

/** Move each point `t` of the way toward where `target` says it belongs. */
const pull = (ps: P[], target: (p: P) => P, t: number) => ps.map((p) => { const q = target(p); return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }; });

interface Ellipse { cx: number; cy: number; a: number; b: number; th: number; err: number; worst: number; sweep: number }

/** Best-fit ellipse, any tilt: main axis from the points' spread, size from their extent along each axis. */
function fitEllipse(ps: P[]): Ellipse | null {
  const L = lengthOf(ps);
  const rs = resample(ps, L / 160);
  let mx = 0, my = 0;
  for (const p of rs) { mx += p.x; my += p.y; }
  mx /= rs.length; my /= rs.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of rs) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  th = snapAngle(th, Math.PI / 2, (8 * Math.PI) / 180);
  const c = Math.cos(th), s = Math.sin(th);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of rs) {
    const u = (p.x - mx) * c + (p.y - my) * s, v = -(p.x - mx) * s + (p.y - my) * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  if (a <= 0 || b <= 0) return null;
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const cx = mx + uc * c - vc * s, cy = my + uc * s + vc * c;
  let err = 0, worst = 0, sweep = 0, prev: number | null = null;
  for (const p of rs) {
    const u = (p.x - cx) * c + (p.y - cy) * s, v = -(p.x - cx) * s + (p.y - cy) * c;
    const e = Math.abs(Math.hypot(u / a, v / b) - 1);
    err += e; worst = Math.max(worst, e);
    const ang = Math.atan2(v / b, u / a);
    if (prev !== null) { let d = ang - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; sweep += d; }
    prev = ang;
  }
  return { cx, cy, a, b, th, err: err / rs.length, worst, sweep: Math.abs(sweep) };
}

function ellipsePoint(e: Ellipse, t: number): P {
  const c = Math.cos(e.th), s = Math.sin(e.th), u = e.a * Math.cos(t), v = e.b * Math.sin(t);
  return { x: e.cx + u * c - v * s, y: e.cy + u * s + v * c };
}
function ontoEllipse(e: Ellipse, p: P): P {
  const c = Math.cos(e.th), s = Math.sin(e.th);
  const u = (p.x - e.cx) * c + (p.y - e.cy) * s, v = -(p.x - e.cx) * s + (p.y - e.cy) * c;
  return ellipsePoint(e, Math.atan2(v / e.b, u / e.a));
}

/** Rotated rectangle around the points, along the direction of `ring`'s sides (squared up to the axes when close). */
function fitRect(ps: P[], ring: P[]): P[] {
  // Average side direction, folded into one quarter turn.
  let sx = 0, sy = 0;
  for (let i = 1; i < ring.length; i++) {
    const ang = Math.atan2(ring[i].y - ring[i - 1].y, ring[i].x - ring[i - 1].x) * 4;
    const len = dist(ring[i - 1], ring[i]);
    sx += Math.cos(ang) * len; sy += Math.sin(ang) * len;
  }
  const th = snapAngle(Math.atan2(sy, sx) / 4, Math.PI / 2, (9 * Math.PI) / 180);
  const c = Math.cos(th), s = Math.sin(th);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ps) {
    const u = p.x * c + p.y * s, v = -p.x * s + p.y * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  // Nearly square: make it square.
  const w = u1 - u0, h = v1 - v0;
  if (Math.abs(w - h) / Math.max(w, h) < 0.1) { const m = (w + h) / 2, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2; u0 = cu - m / 2; u1 = cu + m / 2; v0 = cv - m / 2; v1 = cv + m / 2; }
  const at = (u: number, v: number) => ({ x: u * c - v * s, y: u * s + v * c });
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}

function cornerAngles(ring: P[]) {
  const n = ring.length - 1, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], q = ring[i], r = ring[(i + 1) % n];
    const a1 = Math.atan2(p.y - q.y, p.x - q.x), a2 = Math.atan2(r.y - q.y, r.x - q.x);
    let d = Math.abs(a1 - a2); if (d > Math.PI) d = 2 * Math.PI - d;
    out.push(d);
  }
  return out;
}

const angleOn = (e: Ellipse, p: P) => {
  const c = Math.cos(e.th), s = Math.sin(e.th);
  return Math.atan2((-(p.x - e.cx) * s + (p.y - e.cy) * c) / e.b, ((p.x - e.cx) * c + (p.y - e.cy) * s) / e.a);
};

/**
 * Pull a hand-drawn loop most of the way onto an ellipse and join it up neatly: anything past one full turn is
 * dropped, both ends ease fully onto the curve, and a gap is closed along the curve rather than with a jump.
 */
function tidyLoop(ps: P[], e: Ellipse, t: number): P[] {
  // Keep one turn.
  const kept = [ps[0]];
  let sweep = 0, prev = angleOn(e, ps[0]);
  for (let i = 1; i < ps.length; i++) {
    const ang = angleOn(e, ps[i]);
    let d = ang - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    sweep += d; prev = ang;
    if (Math.abs(sweep) > 2 * Math.PI) break;
    kept.push(ps[i]);
  }
  const n = kept.length, ease = Math.max(2, Math.round(n * 0.12));
  const out = kept.map((p, i) => {
    const edge = Math.min(i, n - 1 - i) / ease;
    const k = edge >= 1 ? t : t + (1 - t) * (1 - edge) ** 2;
    const q = ontoEllipse(e, p);
    return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
  });
  // Close any remaining gap along the curve, the way the pen was going.
  const dir = Math.sign(sweep) || 1;
  const from = angleOn(e, out[n - 1]);
  const to = angleOn(e, out[0]);
  let gap = (to - from) * dir;
  while (gap < 0) gap += 2 * Math.PI;
  if (gap < Math.PI) {
    const steps = Math.ceil(gap / 0.08);
    for (let i = 1; i <= steps; i++) out.push(ellipsePoint(e, from + (dir * gap * i) / steps));
  }
  return out;
}

export type ShapeName = 'line' | 'circle' | 'ellipse' | 'triangle' | 'square' | 'rectangle' | 'shape' | 'lines';
/** `clean`: replace with the exact shape. Otherwise the points are the user's stroke, tidied toward the shape. */
export interface ShapeFix { points: number[]; name: ShapeName; clean: boolean }

/** Start a closed outline at the corner nearest the pen's first point, ending back there. */
function closedFrom(corners: P[], start: P): P[] {
  const k = corners.reduce((best, p, i) => (dist(p, start) < dist(corners[best], start) ? i : best), 0);
  return [...corners.slice(k), ...corners.slice(0, k), corners[k]];
}

/**
 * What a stroke looks like it's meant to be. Obvious shapes come back clean; rougher attempts come back tidied;
 * anything else (writing, doodles) is null. `z` is the zoom, so thresholds are in screen pixels.
 * `force` (the user held still at the end) always gives a clean shape when there's any reasonable fit.
 */
export function recognize(points: number[], z: number, force = false): ShapeFix | null {
  const ps = toPts(points);
  if (ps.length < 3) return null;
  const L = lengthOf(ps);
  const bb = boundsOf(ps);
  const D = Math.hypot(bb.w, bb.h);
  if (D * z < (force ? 14 : 28)) return null;
  const a = ps[0], b = ps[ps.length - 1];
  const chord = dist(a, b);
  const tidyBy = 0.7;

  // A straight line.
  let dev = 0;
  for (const p of ps) dev = Math.max(dev, distToSeg(p.x, p.y, a.x, a.y, b.x, b.y));
  if (chord > 0.8 * L && chord * z > 36) {
    const ang = snapAngle(Math.atan2(b.y - a.y, b.x - a.x));
    const end = { x: a.x + Math.cos(ang) * chord, y: a.y + Math.sin(ang) * chord };
    if (dev < Math.max(2.5 / z, 0.05 * chord) * (force ? 1.8 : 1)) return { points: flat([a, end]), name: 'line', clean: true };
    if (dev < 0.1 * chord) return { points: flat(pull(ps, (p) => onPolyline(p, [a, b]), tidyBy)), name: 'line', clean: false };
  }

  // Closed shapes: the pen goes (about) once round — a little short of closing, or overshooting, is fine.
  const ell = L > 1.8 * D ? fitEllipse(ps) : null;
  if (!ell || ell.sweep < (force ? 4.6 : 5.1) || ell.sweep > 2 * Math.PI * 1.45) {
    if (force) {
      const poly = simplify(ps, 0.06 * D);
      if (poly.length >= 3 && poly.length <= 5 && meanDistTo(ps, poly) / D < 0.03) return { points: sharp(poly), name: 'lines', clean: true };
    }
    return null;
  }
  // Nearly round counts as a circle (a bit more readily when only tidying, since lumps skew the fit).
  const ratio = ell.b / ell.a;
  const roundAt = (limit: number) => {
    if (ratio <= limit) return { e: ell, name: 'ellipse' as ShapeName };
    const r = (ell.a + ell.b) / 2;
    return { e: { ...ell, a: r, b: r }, name: 'circle' as ShapeName };
  };
  const { e: cleanEll, name: ellName } = roundAt(force ? 0.75 : 0.8);

  const ring = simplify([...ps, a], 0.07 * D);
  if (dist(ring[0], ring[ring.length - 1]) < 0.2 * D) ring[ring.length - 1] = ring[0];
  const corners = ring.length - 1;
  const pErr = corners === 3 || corners === 4 ? meanDistTo(ps, ring) / D : Infinity;

  const cleanEllipse = () => {
    const n = 96, out: P[] = [];
    const c = Math.cos(ell.th), s = Math.sin(ell.th);
    const t0 = Math.atan2((-(a.x - ell.cx) * s + (a.y - ell.cy) * c) / cleanEll.b, ((a.x - ell.cx) * c + (a.y - ell.cy) * s) / cleanEll.a);
    // Go round the same way the pen did.
    const dir = Math.sign(ps.reduce((acc, p, i) => (i ? acc + (ps[i - 1].x * p.y - p.x * ps[i - 1].y) : 0), 0)) || 1;
    for (let i = 0; i <= n; i++) out.push(ellipsePoint(cleanEll, t0 + (dir * i * 2 * Math.PI) / n));
    return { points: flat(out), name: ellName, clean: true } as ShapeFix;
  };

  // Round shapes win when they fit well; boxes and triangles have corners an ellipse can't follow.
  if (ell.err < (force ? 0.1 : 0.065) && ell.err < pErr * 2.2) return cleanEllipse();

  if (pErr < (force ? 0.05 : 0.055)) {
    const angles = cornerAngles(ring);
    const square = corners === 4 && angles.every((t) => Math.abs(t - Math.PI / 2) < (16 * Math.PI) / 180);
    const shape = square ? fitRect(ps, ring) : ring.slice(0, -1);
    const name: ShapeName = corners === 3 ? 'triangle' : square ? (Math.abs(dist(shape[0], shape[1]) - dist(shape[1], shape[2])) < 1e-6 ? 'square' : 'rectangle') : 'shape';
    const outline = closedFrom(shape, a);
    if (force || pErr < 0.025) return { points: sharp(outline), name, clean: true };
    // A rough box or triangle: straighten its sides most of the way and close it up.
    const tidy = pull(ps, (p) => onPolyline(p, outline), tidyBy);
    if (chord < 0.2 * D) tidy.push(tidy[0]);
    return { points: flat(tidy), name, clean: false };
  }

  // A wobbly circle or ellipse: round it out most of the way, and close the gap.
  if (ell.err < 0.14 && ell.worst < 0.4) {
    const { e, name } = roundAt(0.7);
    return { points: flat(tidyLoop(ps, e, 0.75)), name, clean: false };
  }
  return null;
}

// ---------------------------------------------------------------- tapered ink

const SCALE = 1024;

/** Outline of the convex hull of two circles: one tapered segment of the stroke. */
function capsule(a: P, ra: number, b: P, rb: number, z: number): Clipper.Path {
  const d = dist(a, b);
  const arc = (c: P, r: number, from: number, to: number, out: Clipper.Path) => {
    const n = Math.max(3, Math.min(20, Math.ceil((Math.abs(to - from) * Math.max(r * z, 1)) / 3)));
    for (let i = 0; i <= n; i++) {
      const t = from + ((to - from) * i) / n;
      out.push({ X: Math.round((c.x + r * Math.cos(t)) * SCALE), Y: Math.round((c.y + r * Math.sin(t)) * SCALE) });
    }
  };
  const out: Clipper.Path = [];
  if (d <= Math.abs(ra - rb) + 1e-6) {
    const [c, r] = ra >= rb ? [a, ra] : [b, rb];
    arc(c, r, 0, 2 * Math.PI, out);
    return out;
  }
  const th = Math.atan2(b.y - a.y, b.x - a.x);
  const al = Math.acos((ra - rb) / d);
  arc(b, rb, th - al, th + al, out);
  arc(a, ra, th + al, th + 2 * Math.PI - al, out);
  return out;
}

/**
 * Turn a freehand centerline into a filled, pen-like outline: thinner where the hand moved fast and at both ends.
 * Returns rings in the same coordinates as the input, or null for dots and tiny marks (they stay round).
 */
export function taper(points: number[], size: number, z: number): number[][] | null {
  // Work relative to the first point: Clipper rounds to integers, so big board coordinates would lose detail.
  const ox = points[0], oy = points[1];
  const ps = toPts(points.map((v, i) => v - (i % 2 ? oy : ox)));
  const L = lengthOf(ps);
  if (ps.length < 4 || L < size * 2) return null;

  // Thinner on fast moves: points are spaced further apart on screen when the hand moves quickly.
  const r0 = (size / 2) * 1.08;
  let speed = 0;
  let pts = ps.map((p, i) => {
    const gap = i ? dist(ps[i - 1], p) * z : 0;
    speed = i ? speed * 0.7 + gap * 0.3 : gap;
    return { x: p.x, y: p.y, r: r0 * (1 - 0.45 * Math.min(1, Math.max(0, (speed - 3) / 20))) };
  });

  // Two rounds of Chaikin smoothing (position and width together), keeping the ends in place.
  for (let k = 0; k < 2; k++) {
    const next = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      next.push(
        { x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25, r: p.r * 0.75 + q.r * 0.25 },
        { x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75, r: p.r * 0.25 + q.r * 0.75 },
      );
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }

  // Taper both ends, like a pen landing and lifting.
  const taperLen = Math.min(L * 0.28, Math.max(size * 3, 10 / z));
  const ease = (t: number) => t * (2 - t);
  let s = 0;
  const along = pts.map((p, i) => (s += i ? dist(pts[i - 1], p) : 0));
  const total = along[along.length - 1];
  for (let i = 0; i < pts.length; i++) {
    const f = ease(Math.min(1, along[i] / taperLen)) * ease(Math.min(1, (total - along[i]) / (taperLen * 1.3)));
    pts[i].r *= 0.32 + 0.68 * f;
  }

  // Drop points that are almost on top of each other; they add vertices without changing the look.
  const kept: typeof pts = [];
  for (const p of pts) if (!kept.length || dist(kept[kept.length - 1], p) * z > 0.6) kept.push(p);
  if (kept[kept.length - 1] !== pts[pts.length - 1]) kept.push(pts[pts.length - 1]);

  const parts: Clipper.Paths = [];
  for (let i = 1; i < kept.length; i++) parts.push(capsule(kept[i - 1], kept[i - 1].r, kept[i], kept[i].r, z));
  const clip = new Clipper.Clipper();
  clip.AddPaths(parts, Clipper.PolyType.ptSubject, true);
  const result: Clipper.Paths = [];
  clip.Execute(Clipper.ClipType.ctUnion, result, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
  const clean = Clipper.Clipper.CleanPolygons(result, 0.05 * SCALE / z);
  const rings = clean.filter((r) => r.length >= 3).map((r) => r.flatMap((p) => [p.X / SCALE + ox, p.Y / SCALE + oy]));
  return rings.length ? rings : null;
}
