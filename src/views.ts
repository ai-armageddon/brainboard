// Views: named areas of a board that everyone can jump between, and where people are right now.
// The nav sits next to the board name: ‹ [view ▾] ›. When you aren't following anyone it also shows
// who's working in other views, so you can see where the action is and hop over.
import { S } from './state';
import { animateCam, uid } from './actions';
import { hooks } from './render';
import { canEdit, changeView, events, session } from './net';
import { ensureBoard } from './boards';
import { follow, followingId, isFollowLocked } from './collab';
import { icon } from './icons';
import { toast } from './ui';
import type { BoardView, PeerInfo } from './protocol';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

type Rect = { x: number; y: number; w: number; h: number };

const myRect = (): Rect => {
  const { x, y, z } = S.cam;
  return { x: -x / z, y: -y / z, w: innerWidth / z, h: innerHeight / z };
};

/** The view a screen is "in": the smallest view containing the centre of what they see. */
function viewAt(r: Rect | undefined): BoardView | null {
  if (!r) return null;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let best: BoardView | null = null;
  for (const v of session.views) {
    if (cx < v.x || cx > v.x + v.w || cy < v.y || cy > v.y + v.h) continue;
    if (!best || v.w * v.h < best.w * best.h) best = v;
  }
  return best;
}

/** Recently moving, typing or editing: worth a pulse. */
const lastActive = new Map<string, number>();
const ACTIVE_MS = 8000;
const isActive = (id: string) => Date.now() - (lastActive.get(id) ?? 0) < ACTIVE_MS;

function peopleIn(): { by: Map<string, PeerInfo[]>; elsewhere: PeerInfo[] } {
  const by = new Map<string, PeerInfo[]>();
  const elsewhere: PeerInfo[] = [];
  for (const p of session.peers.values()) {
    const v = viewAt(p.p?.view);
    if (v) (by.get(v.id) ?? by.set(v.id, []).get(v.id)!).push(p);
    else if (p.p?.view) elsewhere.push(p);
  }
  return { by, elsewhere };
}

const face = (p: PeerInfo, act = '') =>
  `<span class="vn-face ${isActive(p.id) ? 'active' : ''}" style="--c:${p.color}" ${act ? `data-goto="${p.id}" role="button" tabindex="0"` : ''} title="${esc(p.name)}${isActive(p.id) ? ' · active now' : ''}">${esc(initials(p.name))}</span>`;

// ---------------------------------------------------------------- moving the camera

function cameraFor(r: Rect) {
  const pad = 0.94;
  const z = Math.min(4, Math.max(0.05, Math.min((innerWidth / r.w) * pad, (innerHeight / r.h) * pad)));
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return { x: innerWidth / 2 - cx * z, y: innerHeight / 2 - cy * z, z };
}

/** Stop following (unless the presenter locked it) so the jump sticks. */
function freeCamera(): boolean {
  if (!followingId()) return true;
  if (isFollowLocked()) { toast('The presenter has locked the view'); return false; }
  follow(null);
  return true;
}

export function goToView(v: BoardView) {
  if (!freeCamera()) return;
  animateCam(cameraFor(v), 420);
}

function goToPerson(id: string) {
  const p = session.peers.get(id);
  if (!p?.p?.view || !freeCamera()) return;
  animateCam(cameraFor(p.p.view), 420);
  toast(`Jumped to ${p.name}`);
}

/** Step through views in order: from the one you're in, or the nearest one. */
export function stepView(delta: 1 | -1) {
  const list = session.views;
  if (!list.length) return toast('No views yet. Open the views menu to add one');
  const here = viewAt(myRect());
  let i = here ? list.indexOf(here) : -1;
  i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
  goToView(list[i]);
}

// ---------------------------------------------------------------- editing

async function addView() {
  if (!canEdit()) return;
  if (!(await ensureBoard())) return;
  const used = new Set(session.views.map((v) => v.name));
  let n = session.views.length + 1;
  while (used.has(`View ${n}`)) n++;
  const v: BoardView = { id: uid(), name: `View ${n}`, ...round(myRect()) };
  changeView({ put: v });
  renamingId = v.id;
  render();
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

function reframe(v: BoardView) {
  changeView({ put: { ...v, ...round(myRect()) } });
  toast(`“${v.name}” now shows this area`);
}

let deleteArmed = '';
let deleteTimer = 0;
function remove(v: BoardView, btn: HTMLElement) {
  if (deleteArmed !== v.id) {
    deleteArmed = v.id;
    btn.classList.add('armed');
    btn.dataset.tip = 'Click again to delete';
    clearTimeout(deleteTimer);
    deleteTimer = window.setTimeout(() => { deleteArmed = ''; render(); }, 3000);
    return;
  }
  deleteArmed = '';
  changeView({ del: v.id });
  toast(`Deleted “${v.name}”`);
}

// ---------------------------------------------------------------- UI

let renamingId = '';
let preview: SVGRectElement | null = null;

function showPreview(v: BoardView | null) {
  if (!v) { preview?.remove(); preview = null; return; }
  if (!preview) {
    preview = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    preview.classList.add('view-preview');
    $('live').append(preview);
  }
  preview.setAttribute('x', String(v.x));
  preview.setAttribute('y', String(v.y));
  preview.setAttribute('width', String(v.w));
  preview.setAttribute('height', String(v.h));
  preview.style.strokeWidth = `${2 / S.cam.z}px`;
  preview.style.strokeDasharray = `${6 / S.cam.z} ${5 / S.cam.z}`;
}

function renderNav() {
  const nav = $('viewnav');
  const here = viewAt(myRect());
  const list = session.views;
  const watching = !!followingId();
  // Not following: show who's busy in *other* views (or outside any view).
  const away = watching ? [] : [...session.peers.values()].filter((p) => p.p?.view && viewAt(p.p.view)?.id !== here?.id);
  const awayTip = away.map((p) => `${p.name} · ${viewAt(p.p?.view)?.name ?? 'somewhere else'}`).join('\n');
  nav.classList.toggle('has-views', list.length > 0);
  nav.innerHTML =
    (list.length > 1 ? `<button class="cbtn vn-step" data-vn="prev" data-tip="Previous view · {" aria-label="Previous view">${icon('chevronLeft', 16)}</button>` : '') +
    `<button class="vn-current ${$('views-pop').hidden ? '' : 'open'}" data-vn="menu" aria-haspopup="menu" aria-expanded="${!$('views-pop').hidden}" ${awayTip ? `title="${esc(awayTip)}"` : ''}>` +
      `${list.length ? '' : icon('views', 16)}<span class="vn-name">${esc(here?.name ?? 'Views')}</span>` +
      (away.length ? `<span class="vn-faces">${away.slice(0, 3).map((p) => face(p)).join('')}${away.length > 3 ? `<span class="vn-more">+${away.length - 3}</span>` : ''}</span>` : '') +
      `<span class="vn-chev">${icon('chevron', 14)}</span></button>` +
    (list.length > 1 ? `<button class="cbtn vn-step" data-vn="next" data-tip="Next view · }" aria-label="Next view">${icon('chevronRight', 16)}</button>` : '');
}

function renderPop() {
  const pop = $('views-pop');
  if (pop.hidden) return;
  // Mid-rename: leave the field alone (presence updates arrive many times a second).
  if (renamingId && pop.querySelector('.vrow-input')) return;
  const here = viewAt(myRect());
  const { by, elsewhere } = peopleIn();
  const edit = canEdit();
  const rows = session.views.map((v, i) => {
    const people = by.get(v.id) ?? [];
    const naming = renamingId === v.id;
    return `<div class="vrow ${here?.id === v.id ? 'here' : ''}" data-view="${v.id}">
      <span class="vrow-key">${i < 9 ? i + 1 : ''}</span>
      ${naming
        ? `<input class="vrow-input" value="${esc(v.name)}" maxlength="60" aria-label="View name" />`
        : `<button class="vrow-go" data-act="go"><b>${esc(v.name)}</b>${here?.id === v.id ? '<em>You’re here</em>' : ''}</button>`}
      <span class="vrow-faces">${people.map((p) => face(p, 'goto')).join('')}</span>
      ${edit && !naming ? `<span class="vrow-acts">
        <button class="cbtn" data-act="rename" data-tip="Rename" aria-label="Rename">${icon('type', 15)}</button>
        <button class="cbtn" data-act="reframe" data-tip="Set to what you see now" aria-label="Set to what you see now">${icon('fit', 15)}</button>
        <button class="cbtn danger ${deleteArmed === v.id ? 'armed' : ''}" data-act="delete" data-tip="${deleteArmed === v.id ? 'Click again to delete' : 'Delete'}" aria-label="Delete view">${icon('trash', 15)}</button>
      </span>` : ''}
    </div>`;
  }).join('');
  pop.innerHTML = `
    <div class="vpop-head"><span class="pop-title">Views</span>${edit ? `<button class="vpop-add" data-act="add">${icon('plus', 15)}Add this view</button>` : ''}</div>
    ${session.views.length ? `<div class="vrows">${rows}</div>` : `<p class="vpop-empty">${edit ? 'Save spots on this board as views, so everyone can jump straight to them.' : 'No views on this board yet.'}</p>`}
    ${elsewhere.length ? `<div class="vrow elsewhere"><span class="vrow-key"></span><span class="vrow-go muted">Somewhere else</span><span class="vrow-faces">${elsewhere.map((p) => face(p, 'goto')).join('')}</span></div>` : ''}
    ${followingId() ? '<p class="vpop-note">You’re following someone. Picking a view stops following.</p>' : ''}
    <p class="vpop-keys"><kbd>{</kbd> <kbd>}</kbd> previous / next · <kbd>⌥</kbd>+<kbd>1</kbd>–<kbd>9</kbd> jump</p>`;
  const input = pop.querySelector<HTMLInputElement>('.vrow-input');
  if (input) {
    input.focus();
    input.select();
    const done = (save: boolean) => {
      const v = session.views.find((o) => o.id === renamingId);
      renamingId = '';
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (save && v && name && name !== v.name) changeView({ put: { ...v, name } });
      render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => { if (renamingId) done(true); });
  }
}

let raf = 0;
function render() {
  cancelAnimationFrame(raf);
  raf = 0;
  renderNav();
  renderPop();
}
const renderSoon = () => { raf ||= requestAnimationFrame(render); };

function togglePop(force?: boolean) {
  const pop = $('views-pop');
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  if (!open) { renamingId = ''; showPreview(null); }
  render();
}

export function initViews() {
  const nav = document.createElement('div');
  nav.id = 'viewnav';
  $('topbar').append(nav);
  const pop = document.createElement('div');
  pop.id = 'views-pop';
  pop.className = 'panel';
  pop.setAttribute('role', 'menu');
  pop.hidden = true;
  document.body.append(pop);

  nav.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-vn]')?.dataset.vn;
    if (act === 'prev') stepView(-1);
    if (act === 'next') stepView(1);
    if (act === 'menu') togglePop();
  });
  pop.addEventListener('click', (e) => {
    const t = e.target as Element;
    const who = t.closest<HTMLElement>('[data-goto]')?.dataset.goto;
    if (who) { goToPerson(who); return; }
    const act = t.closest<HTMLElement>('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'add') { void addView(); return; }
    const v = session.views.find((o) => o.id === act.closest<HTMLElement>('[data-view]')?.dataset.view);
    if (!v) return;
    if (act.dataset.act === 'go') goToView(v);
    if (act.dataset.act === 'rename') { renamingId = v.id; render(); }
    if (act.dataset.act === 'reframe') reframe(v);
    if (act.dataset.act === 'delete') remove(v, act);
  });
  pop.addEventListener('pointerover', (e) => {
    const id = (e.target as Element).closest<HTMLElement>('[data-view]')?.dataset.view;
    showPreview(session.views.find((v) => v.id === id) ?? null);
  });
  pop.addEventListener('pointerleave', () => showPreview(null));
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden) return;
    const t = e.target as Element;
    if (!pop.contains(t) && !nav.contains(t)) togglePop(false);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) { togglePop(false); return; }
    const t = e.target as HTMLElement;
    if (S.editing || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === '{' || e.key === '}') { e.preventDefault(); stepView(e.key === '}' ? 1 : -1); return; }
    // ⌥1–9: jump straight to a view
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
      const v = session.views[Number(e.code.slice(5)) - 1];
      if (v) { e.preventDefault(); goToView(v); }
    }
  });

  for (const ev of ['views', 'peers', 'welcome', 'follow', 'role', 'settings']) events.addEventListener(ev, renderSoon);
  events.addEventListener('presence', (e) => {
    const id = (e as CustomEvent<string>).detail;
    const p = session.peers.get(id);
    if (p?.p?.cursor || p?.p?.editing) lastActive.set(id, Date.now());
    renderSoon();
  });
  events.addEventListener('remote-ops', (e) => { lastActive.set(String((e as CustomEvent).detail), Date.now()); renderSoon(); });
  // Activity fades: refresh now and then so pulses stop when people go quiet.
  setInterval(renderSoon, 3000);
  const prevCam = hooks.afterCamera;
  hooks.afterCamera = () => { prevCam(); renderSoon(); };
  render();
}
