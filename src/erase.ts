import Clipper from 'clipper-lib';
import type { Pt, StrokeItem } from './types';
import { distToSeg } from './geometry';

// Clipper operates on integers. Work in item-local coordinates to retain precision on distant boards.
const SCALE = 1024;
const point = (x: number, y: number): Clipper.IntPoint => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });

function roundedOutline(line: Clipper.Path, radius: number): Clipper.Paths {
  const result: Clipper.Paths = [];
  const offset = new Clipper.ClipperOffset(2, SCALE * Math.min(0.04, radius / 32));
  offset.AddPath(line, Clipper.JoinType.jtRound, Clipper.EndType.etOpenRound);
  offset.Execute(result, radius * SCALE);
  return result;
}

// Follow the same midpoint quadratics as strokePath, including its straight last segment.
function strokeOutline(stroke: StrokeItem): Clipper.Paths {
  if (stroke.outline) return stroke.outline.map(ring => {
    const path: Clipper.Path = [];
    for (let i = 0; i < ring.length; i += 2) path.push(point(ring[i], ring[i + 1]));
    return path;
  });
  const coords = stroke.points;
  if (coords.length < 2) return [];
  let x = coords[0], y = coords[1];
  const line = [point(x, y)];
  for (let i = 2; i + 3 < coords.length; i += 2) {
    const cx = coords[i], cy = coords[i + 1];
    const ex = (cx + coords[i + 2]) / 2, ey = (cy + coords[i + 3]) / 2;
    const bend = Math.hypot(x - 2 * cx + ex, y - 2 * cy + ey);
    const steps = distToSeg(cx, cy, x, y, ex, ey) < 0.04 ? 1 : Math.min(512, Math.ceil(Math.sqrt(bend / 0.16)));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, u = 1 - t;
      line.push(point(u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey));
    }
    x = ex; y = ey;
  }
  line.push(point(coords[coords.length - 2], coords[coords.length - 1]));
  return roundedOutline(line, stroke.size / 2);
}

/** Subtract one swept brush segment. Same object on a miss, null when no ink survives. */
export function eraseStroke(stroke: StrokeItem, from: Pt, to: Pt, radius: number, whole: boolean): StrokeItem | null {
  const pad = radius + (stroke.outline ? 0 : stroke.size / 2);
  if (Math.max(from.x, to.x) < stroke.x - pad || Math.min(from.x, to.x) > stroke.x + stroke.w + pad ||
      Math.max(from.y, to.y) < stroke.y - pad || Math.min(from.y, to.y) > stroke.y + stroke.h + pad) return stroke;

  const ink = strokeOutline(stroke);
  const brush = roundedOutline([point(from.x - stroke.x, from.y - stroke.y), point(to.x - stroke.x, to.y - stroke.y)], radius);
  const clip = new Clipper.Clipper();
  clip.AddPaths(ink, Clipper.PolyType.ptSubject, true);
  clip.AddPaths(brush, Clipper.PolyType.ptClip, true);
  const result: Clipper.Paths = [];
  if (!clip.Execute(whole ? Clipper.ClipType.ctIntersection : Clipper.ClipType.ctDifference, result,
    Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero)) return stroke;
  if (whole) return result.length ? null : stroke;
  if (!result.length) return null;
  if (Clipper.JS.AreaOfPolygons(result) >= Clipper.JS.AreaOfPolygons(ink)) return stroke;

  const box = Clipper.JS.BoundsOfPaths(result);
  const outline = result.map(ring => ring.flatMap(p => [(p.X - box.left) / SCALE, (p.Y - box.top) / SCALE]));
  return { ...stroke, x: stroke.x + box.left / SCALE, y: stroke.y + box.top / SCALE,
    w: (box.right - box.left) / SCALE, h: (box.bottom - box.top) / SCALE, points: [], outline };
}
