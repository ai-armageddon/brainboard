// "Action elsewhere" while someone presents.
//
// When a watcher stops following the presenter to look around on their own, keep an eye on what the presenter
// is doing. If they get busy somewhere the watcher can't see, glow the edge of the watcher's screen in the
// presenter's colour and offer a button that flies them back to the action.
import { S } from './state';
import { session } from './net';
import { boxOfIds } from './director';
import type { Box } from './types';
import type { PeerInfo } from './protocol';

/** How long after the presenter's last move the action still counts as "going on". */
const HOT_MS = 2500;

interface Deps {
  /** The id of the person this watcher is following, if any. */
  following: () => string | null;
  /** The presenter can lock followers to their view, so there's nothing to wander from. */
  locked: () => boolean;
  /** Start following the presenter again. */
  rejoin: (presenterId: string) => void;
}

let deps: Deps;
let btn: HTMLButtonElement;
let glow: HTMLElement;

// What the presenter last did, and where.
let focus: Box | null = null;
let activeAt = 0;
let prev: { cursor?: string; sel: string; editing: string | null; view?: string } | null = null;
let prevPeer = '';

/** The button stays up from the moment action happens off screen until the watcher can see it again. */
let shown = false;

const key = (o: object | null | undefined) => (o ? JSON.stringify(o) : undefined);
const around = (x: number, y: number, r: number): Box => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });

/** The presenter's presence changed: work out what they're doing and where. */
function noteActivity(p: PeerInfo) {
  const pr = p.p ?? {};
  const now = {
    cursor: key(pr.cursor),
    sel: (pr.sel ?? []).join(','),
    editing: pr.editing ?? null,
    view: key(pr.view),
  };
  const was = prevPeer === p.id ? prev : null;
  prev = now;
  prevPeer = p.id;
  if (!was) { focus = focusNow(p); return; } // first sight: know where they are, but it isn't "action" yet

  const r = pr.view ? Math.max(pr.view.w, pr.view.h) * 0.04 : 40;
  let f: Box | null = null;
  if (now.editing && now.editing !== was.editing) f = boxOfIds([now.editing]);
  else if (now.sel && now.sel !== was.sel) f = boxOfIds(now.sel.split(','));
  else if (now.cursor && now.cursor !== was.cursor && pr.cursor) f = now.editing ? boxOfIds([now.editing]) : around(pr.cursor.x, pr.cursor.y, r);
  else if (now.view !== was.view && pr.view && !pr.cursor) f = middle(pr.view);
  if (!f) return;
  focus = f;
  activeAt = performance.now();
}

/** Their edits (typing, dragging, adding) are action too, centred on what they're working on. */
function noteEdit(p: PeerInfo) {
  focus = focusNow(p) ?? focus;
  activeAt = performance.now();
}

function focusNow(p: PeerInfo): Box | null {
  const pr = p.p;
  if (!pr) return null;
  if (pr.editing) return boxOfIds([pr.editing]);
  if (pr.sel?.length) { const b = boxOfIds(pr.sel); if (b) return b; }
  if (pr.cursor) return around(pr.cursor.x, pr.cursor.y, pr.view ? Math.max(pr.view.w, pr.view.h) * 0.04 : 40);
  return pr.view ? middle(pr.view) : null;
}

const middle = (v: Box): Box => ({ x: v.x + v.w * 0.35, y: v.y + v.h * 0.35, w: v.w * 0.3, h: v.h * 0.3 });

/** Is any of this world box on the watcher's screen (ignoring a thin strip under the toolbars)? */
function visible(b: Box) {
  const { x, y, z } = S.cam;
  const L = b.x * z + x, T = b.y * z + y, R = (b.x + b.w) * z + x, B = (b.y + b.h) * z + y;
  const m = 24;
  return R > m && B > m && L < innerWidth - m && T < innerHeight - m;
}

function presenter(): PeerInfo | null {
  const id = session.presenter;
  if (!id || id === session.you?.id) return null;
  return session.peers.get(id) ?? null;
}

/** Re-decide whether to glow the edge and show the button. Cheap; called on every relevant change. */
export function updateCatchUp() {
  if (!btn) return;
  const p = presenter();
  const wandering = !!p && deps.following() !== p.id && !deps.locked();
  const away = wandering && !!focus && !visible(focus);
  const hot = away && performance.now() - activeAt < HOT_MS;

  if (!away) shown = false;
  else if (hot) shown = true;

  glow.classList.toggle('on', hot);
  if (p) {
    glow.style.setProperty('--c', p.color);
    btn.style.setProperty('--c', p.color);
    btn.classList.toggle('light', isLight(p.color));
  }
  btn.classList.toggle('hot', hot);
  if (shown && p) {
    btn.querySelector('b')!.textContent = `Back to ${p.name}`;
    btn.setAttribute('aria-label', `${p.name} is busy somewhere else. Jump back to the presentation`);
    pointArrow(focus!);
  }
  if (btn.hidden === shown) btn.hidden = !shown;
}

/** Turn the little arrow towards where the action is. */
function pointArrow(b: Box) {
  const { x, y, z } = S.cam;
  const dx = (b.x + b.w / 2) * z + x - innerWidth / 2;
  const dy = (b.y + b.h / 2) * z + y - innerHeight / 2;
  btn.style.setProperty('--angle', `${Math.atan2(dy, dx)}rad`);
}

function isLight(color: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62;
}

export function initCatchUp(d: Deps) {
  deps = d;
  btn = document.getElementById('catch-up') as HTMLButtonElement;
  glow = document.getElementById('elsewhere')!;
  btn.innerHTML = '<span class="arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span><b></b>';
  btn.addEventListener('click', () => {
    const p = presenter();
    shown = false;
    if (p) deps.rejoin(p.id);
    updateCatchUp();
  });
  // Idle action cools down, so the glow fades even when nothing else changes.
  setInterval(() => { if (shown || glow.classList.contains('on')) updateCatchUp(); }, 400);
}

/** The presenter's presence changed. */
export function catchUpPresence(p: PeerInfo) {
  if (p.id !== session.presenter) return;
  noteActivity(p);
  updateCatchUp();
}

/** Someone changed the board. */
export function catchUpOps(from: string) {
  const p = presenter();
  if (!p || from !== p.id) return;
  noteEdit(p);
  updateCatchUp();
}

/** Presenting started, stopped or changed hands. */
export function catchUpReset() {
  prev = null;
  prevPeer = '';
  activeAt = 0;
  shown = false;
  const p = presenter();
  focus = p ? focusNow(p) : null;
  updateCatchUp();
}
