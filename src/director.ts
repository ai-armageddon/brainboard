// Cinematic follow: a camera "director" for watching someone present.
//
// Instead of mirroring the presenter's viewport on every twitch, it works out what they're paying attention to
// and frames that, moving like a camera operator would:
//   1. the item they're typing in
//   2. what they just selected
//   3. where their cursor rests or circles slowly (pointing at something); fast sweeps are ignored
//   4. otherwise, the area they're looking at
// If the subject is already comfortably in frame the camera holds still. Otherwise it eases there, and long
// jumps become a fly-over (zoom out, travel, zoom back in).
import { S, getItem } from './state';
import { applyCamera } from './render';
import { MIN_Z, MAX_Z, isNode } from './actions';
import { clamp, unionBox } from './geometry';
import type { Box } from './types';
import type { PeerInfo } from './protocol';

export type FollowMode = 'cinematic' | 'exact';
const MODE_KEY = 'bb-follow-mode';

export function getFollowMode(): FollowMode {
  try { return localStorage.getItem(MODE_KEY) === 'exact' ? 'exact' : 'cinematic'; } catch { return 'cinematic'; }
}
export function setFollowMode(m: FollowMode) {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- what the presenter is doing

interface Sample { x: number; y: number; t: number }
let peer: PeerInfo | null = null;
let samples: Sample[] = [];
let selKey = '';
let selAt = 0;

/** Feed the latest presence of the person being followed. */
export function observe(p: PeerInfo) {
  peer = p;
  const now = performance.now();
  const c = p.p?.cursor;
  if (c) {
    const last = samples[samples.length - 1];
    if (!last || last.x !== c.x || last.y !== c.y) samples.push({ x: c.x, y: c.y, t: now });
    samples = samples.filter((s) => now - s.t < 1500);
    if (!samples.length) samples.push({ x: c.x, y: c.y, t: now });
  }
  const key = (p.p?.sel ?? []).join(',');
  if (key !== selKey) {
    selKey = key;
    if (key) selAt = now;
  }
  wake();
}

/** The bounds of these items (an edge counts as the two things it joins). */
export function boxOfIds(ids: string[]): Box | null {
  const boxes: Box[] = [];
  for (const id of ids) {
    const it = getItem(id);
    if (isNode(it)) boxes.push(it);
    else if (it?.type === 'edge') {
      const a = getItem(it.from), b = getItem(it.to);
      if (isNode(a) && isNode(b)) boxes.push(unionBox([a, b]));
    }
  }
  return boxes.length ? unionBox(boxes) : null;
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const pad = (b: Box, k: number) => ({ x: b.x - b.w * k, y: b.y - b.h * k, w: b.w * (1 + 2 * k), h: b.h * (1 + 2 * k) });
/** Zoom that fits a world box into this screen, leaving room for the toolbars. */
const fitZoom = (b: Box) => clamp(Math.min((innerWidth * 0.86) / Math.max(b.w, 1), (innerHeight * 0.78) / Math.max(b.h, 1)), MIN_Z, MAX_Z);

/** A resting or slowly circling cursor, in world coordinates. Null while it sweeps around or after a long idle. */
function dwell(view: Box): { x: number; y: number } | null {
  const now = performance.now();
  const last = samples[samples.length - 1];
  if (!last) return null;
  const still = now - last.t;
  if (still > 6000) return null; // idle for a while: not pointing at anything any more
  if (still > 700) return { x: last.x, y: last.y }; // came to rest on something
  // Circling slowly over one spot for a while also counts; a sweep across the screen doesn't.
  const recent = samples.filter((s) => now - s.t < 1200);
  if (recent.length < 4 || now - recent[0].t < 600) return null;
  const cx = recent.reduce((a, s) => a + s.x, 0) / recent.length;
  const cy = recent.reduce((a, s) => a + s.y, 0) / recent.length;
  const spread = Math.max(...recent.map((s) => Math.hypot(s.x - cx, s.y - cy)));
  return spread < Math.max(view.w, view.h) * 0.06 ? { x: cx, y: cy } : null;
}

interface Shot { cx: number; cy: number; z: number; must: Box }

/** The topmost item under (or just next to) a point. Empty space isn't a point of interest. */
function itemAt(pt: { x: number; y: number }, slack: number): Box | null {
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (!isNode(it)) continue;
    if (pt.x >= it.x - slack && pt.x <= it.x + it.w + slack && pt.y >= it.y - slack && pt.y <= it.y + it.h + slack) return it;
  }
  return null;
}

/** Where the camera should be, and the part of the board that has to stay in frame. */
function compose(): Shot | null {
  const v = peer?.p?.view;
  if (!v) return null;
  const zv = clamp(Math.min(innerWidth / v.w, innerHeight / v.h), MIN_Z, MAX_Z);
  const now = performance.now();

  // 1. typing, 2. a fresh selection: frame the subject, not much tighter than the presenter's own zoom
  const editing = peer!.p?.editing ? boxOfIds([peer!.p!.editing]) : null;
  const selected = !editing && selKey && now - selAt < 8000 ? boxOfIds(selKey.split(',')) : null;
  const subject = editing ?? selected;
  if (subject) {
    const framed = pad(subject, 0.35);
    const z = clamp(Math.min(fitZoom(framed), zv * 1.25), MIN_Z, MAX_Z);
    const c = center(subject);
    return { cx: c.x, cy: c.y, z, must: pad(subject, 0.08) };
  }

  // 3. pointing at something on the board: keep their framing, lean towards it, keep it in frame
  const vc = center(v);
  const d = dwell(v);
  const target = d && d.x >= v.x && d.x <= v.x + v.w && d.y >= v.y && d.y <= v.y + v.h ? itemAt(d, Math.max(v.w, v.h) * 0.03) : null;
  if (target) {
    const c = center(target);
    return { cx: vc.x + (c.x - vc.x) * 0.45, cy: vc.y + (c.y - vc.y) * 0.45, z: zv, must: pad(target, 0.05) };
  }

  // 4. what they're looking at: its middle must stay in view
  return { cx: vc.x, cy: vc.y, z: zv, must: { x: v.x + v.w * 0.2, y: v.y + v.h * 0.2, w: v.w * 0.6, h: v.h * 0.6 } };
}

// ---------------------------------------------------------------- the camera

let raf = 0;
let running = false;
let moving = false;
/** Frame the subject on the next tick even if it's already visible (when following starts). */
let force = false;
let last = 0;
const vel = { x: 0, y: 0, z: 0 };
let flight: { from: { cx: number; cy: number; lz: number }; to: Shot; t0: number; ms: number; hop: number } | null = null;

/** Unity-style critically damped spring. */
function smoothDamp(cur: number, target: number, v: number, smooth: number, dt: number): [number, number] {
  const omega = 2 / smooth;
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (v + omega * change) * dt;
  return [target + (change + temp) * e, (v - omega * temp) * e];
}

const camCenter = () => ({ x: (innerWidth / 2 - S.cam.x) / S.cam.z, y: (innerHeight / 2 - S.cam.y) / S.cam.z });

function setCam(cx: number, cy: number, z: number) {
  S.cam = { x: innerWidth / 2 - cx * z, y: innerHeight / 2 - cy * z, z };
  applyCamera();
}

function inFrame(b: Box) {
  const { x, y, z } = S.cam;
  const L = b.x * z + x, T = b.y * z + y, R = (b.x + b.w) * z + x, B = (b.y + b.h) * z + y;
  const mx = innerWidth * 0.08, my = innerHeight * 0.1;
  return L >= mx && T >= my && R <= innerWidth - mx && B <= innerHeight - my;
}

function tick(t: number) {
  raf = 0;
  if (!running) return;
  const dt = Math.min(0.05, (t - (last || t)) / 1000);
  last = t;
  const shot = compose();
  if (shot) {
    if (flight) fly(t);
    else step(shot, dt);
  }
  raf = requestAnimationFrame(tick);
}

function step(shot: Shot, dt: number) {
  const c = camCenter();
  const z = S.cam.z;
  const zoomOff = Math.abs(Math.log(shot.z / z));
  // Hold the frame while the subject is comfortably visible at roughly the right zoom.
  if (!moving) {
    if (!force && inFrame(shot.must) && zoomOff < Math.log(1.35)) return;
    force = false;
    moving = true;
    vel.x = vel.y = vel.z = 0;
    // Far away: a fly-over reads better than a long slide.
    const dist = Math.hypot(shot.cx - c.x, shot.cy - c.y) * z;
    if (dist > Math.hypot(innerWidth, innerHeight) * 1.6 && !reduceMotion()) {
      flight = {
        from: { cx: c.x, cy: c.y, lz: Math.log(z) }, to: shot, t0: performance.now(),
        ms: clamp(700 + dist / 6, 900, 1700), hop: clamp(Math.log(dist / innerWidth) * 0.6, 0.2, 1.4),
      };
      return;
    }
  }
  if (reduceMotion()) { setCam(shot.cx, shot.cy, shot.z); moving = false; return; }
  let cx, cy, lz;
  [cx, vel.x] = smoothDamp(c.x, shot.cx, vel.x, 0.75, dt);
  [cy, vel.y] = smoothDamp(c.y, shot.cy, vel.y, 0.75, dt);
  [lz, vel.z] = smoothDamp(Math.log(z), Math.log(shot.z), vel.z, 0.95, dt);
  setCam(cx, cy, Math.exp(lz));
  // Settled: rest until the subject drifts out of frame again.
  const near = Math.hypot(shot.cx - cx, shot.cy - cy) * S.cam.z < 3 && Math.abs(Math.log(shot.z) - lz) < 0.01;
  if (near) moving = false;
}

function fly(t: number) {
  const f = flight!;
  const p = clamp((t - f.t0) / f.ms, 0, 1);
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // ease in-out
  const lz = f.from.lz + (Math.log(f.to.z) - f.from.lz) * e - f.hop * Math.sin(Math.PI * e);
  setCam(f.from.cx + (f.to.cx - f.from.cx) * e, f.from.cy + (f.to.cy - f.from.cy) * e, Math.exp(lz));
  if (p >= 1) { flight = null; moving = false; }
}

function wake() {
  if (running && !raf) raf = requestAnimationFrame(tick);
}

export function startDirector(p: PeerInfo) {
  running = true;
  moving = false;
  force = true; // frame the subject straight away when you start following
  flight = null;
  samples = [];
  selKey = (p.p?.sel ?? []).join(',');
  selAt = 0;
  last = 0;
  observe(p);
}

export function stopDirector() {
  running = false;
  peer = null;
  flight = null;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

export const directorRunning = () => running;
