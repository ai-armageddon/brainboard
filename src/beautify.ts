// Beauty mode for the pen. Three things make ink look better:
//   1. Steadying: each new point only goes part of the way to the pointer, so hand tremor is smoothed out as you draw.
//   2. Tapering: a finished freehand stroke becomes a filled outline that thins at its ends and on fast moves,
//      like a real pen. Writing reads much better.
//   3. Snapping: a stroke that is clearly a line, circle, ellipse, triangle or box becomes a clean one.
//      Holding still at the end of a stroke snaps it with looser rules, and also straightens zigzags and arrows.
import Clipper from 'clipper-lib';
import { distToSeg } from './geometry';

/** Where the next steadied point goes. `amount` 0 = raw pointer, closer to 1 = smoother but laggier. */
export function steady(lx: number, ly: number, x: number, y: number, amount = 0.45) {
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

function meanDistToPolyline(ps: P[], poly: P[]) {
  let sum = 0;
  for (const p of ps) {
    let m = Infinity;
    for (let i = 1; i < poly.length; i++) m = Math.min(m, distToSeg(p.x, p.y, poly[i - 1].x, poly[i - 1].y, poly[i].x, poly[i].y));
    sum += m;
  }
  return sum / ps.length;
}

/** Snap an angle to the nearest 45° when it's within `tol` radians. */
function snapAngle(a: number, tol = (7 * Math.PI) / 180) {
  const step = Math.PI / 4;
  const s = Math.round(a / step) * step;
  return Math.abs(a - s) < tol ? s : a;
}

/** Repeat each corner so the midpoint curves in strokePath draw sharp corners and straight sides. */
const sharp = (ps: P[]) => flat(ps.flatMap((p) => [p, p]));

export type ShapeName = 'line' | 'circle' | 'ellipse' | 'triangle' | 'square' | 'rectangle' | 'shape' | 'lines';

/**
 * A clean version of a stroke, or null when it doesn't look like a simple shape.
 * `z` is the zoom, so thresholds work in screen pixels. `force` (the user held still) loosens the rules.
 */
export function recognize(points: number[], z: number, force = false): { points: number[]; name: ShapeName } | null {
  const ps = toPts(points);
  if (ps.length < 3) return null;
  const L = lengthOf(ps);
  const bb = boundsOf(ps);
  const D = Math.hypot(bb.w, bb.h);
  if (D * z < (force ? 14 : 44)) return null;
  const loose = force ? 1.8 : 1;
  const a = ps[0], b = ps[ps.length - 1];
  const chord = dist(a, b);

  // A straight line.
  let dev = 0;
  for (const p of ps) dev = Math.max(dev, distToSeg(p.x, p.y, a.x, a.y, b.x, b.y));
  if (chord > 0.85 * L && dev < Math.max(2.5 / z, 0.045 * chord) * loose) {
    const ang = snapAngle(Math.atan2(b.y - a.y, b.x - a.x));
    return { points: [a.x, a.y, a.x + Math.cos(ang) * chord, a.y + Math.sin(ang) * chord], name: 'line' };
  }

  // Closed shapes: the stroke ends near where it started and goes most of the way round.
  const closed = chord < (force ? 0.3 : 0.22) * D && L > 1.8 * D;
  if (closed && bb.w > 0 && bb.h > 0) {
    const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    const rx = bb.w / 2, ry = bb.h / 2;
    let eErr = 0;
    for (const p of ps) eErr += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    eErr /= ps.length;

    const ring = simplify([...ps, a], 0.07 * D);
    if (dist(ring[0], ring[ring.length - 1]) < 0.15 * D) ring[ring.length - 1] = ring[0];
    const corners = ring.length - 1;
    const pErr = corners >= 3 ? meanDistToPolyline(ps, ring) / D : Infinity;

    if (eErr < 0.075 * loose && eErr * 0.45 < pErr) {
      const round = Math.abs(rx - ry) / Math.max(rx, ry) < 0.12;
      const Rx = round ? (rx + ry) / 2 : rx, Ry = round ? (rx + ry) / 2 : ry;
      const n = 72, out: P[] = [];
      // Start where the user started, going the same way round.
      const t0 = Math.atan2((a.y - cy) / Ry, (a.x - cx) / Rx);
      const dir = Math.sign(cross(ps)) || 1;
      for (let i = 0; i <= n; i++) {
        const t = t0 + (dir * i * 2 * Math.PI) / n;
        out.push({ x: cx + Rx * Math.cos(t), y: cy + Ry * Math.sin(t) });
      }
      return { points: flat(out), name: round ? 'circle' : 'ellipse' };
    }
    if ((corners === 3 || corners === 4) && pErr < 0.03 * loose) {
      if (corners === 4 && ring.slice(1).every((p, i) => axisAligned(ring[i], p))) {
        let { x0, y0, w, h } = bb;
        let name: ShapeName = 'rectangle';
        if (Math.abs(w - h) / Math.max(w, h) < 0.1) { w = h = (w + h) / 2; name = 'square'; }
        const box = [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }];
        // Start at the corner nearest where the user began.
        const k = box.reduce((best, p, i) => (dist(p, a) < dist(box[best], a) ? i : best), 0);
        const order = [0, 1, 2, 3, 4].map((i) => box[(k + i) % 4]);
        return { points: sharp(order), name };
      }
      return { points: sharp(ring), name: corners === 3 ? 'triangle' : 'shape' };
    }
    return null;
  }

  // Held still: straighten an open zigzag, arrow or corner into a few straight strokes.
  if (force) {
    const poly = simplify(ps, 0.06 * D);
    if (poly.length >= 3 && poly.length <= 5 && meanDistToPolyline(ps, poly) / D < 0.03) return { points: sharp(poly), name: 'lines' };
  }
  return null;
}

/** Signed area: which way round a closed stroke goes. */
function cross(ps: P[]) { let s = 0; for (let i = 1; i < ps.length; i++) s += ps[i - 1].x * ps[i].y - ps[i].x * ps[i - 1].y; return s; }
function axisAligned(p: P, q: P) {
  const ang = Math.abs(Math.atan2(q.y - p.y, q.x - p.x)) % (Math.PI / 2);
  return Math.min(ang, Math.PI / 2 - ang) < (12 * Math.PI) / 180;
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
    return { x: p.x, y: p.y, r: r0 * (1 - 0.38 * Math.min(1, Math.max(0, (speed - 3) / 22))) };
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
