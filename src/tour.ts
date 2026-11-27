import { canEdit, isOwner, session } from './net';
import { keyLabel } from './keys';
import { releases } from './releases';
import { tourScene } from './tour-scenes';

interface Step {
  title: string;
  body: string;
  scene?: string;
  target?: string;
  fallback?: string;
}
type Track = 'basics' | 'latest';
const SEEN = 'bb-tour-done';
const STEP_MS = 8500;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function basics(): Step[] {
  const touch = matchMedia('(pointer: coarse)').matches;
  const list: Step[] = [];
  if (canEdit()) {
    list.push(
      { target: '[data-tool="text"]', scene: 'write', title: 'Start with a thought', body: touch ? 'Double-tap a blank spot to write. Use the sticky note tool when you want a colored card.' : 'Double-click a blank spot to write. Press <kbd>Esc</kbd> to finish, then drag the text into place.' },
      { target: '[data-tool="ellipse"]', scene: 'connect', title: 'Connect two ideas', body: touch ? 'Place two bubbles. Choose the connector tool and drag from one bubble to the other.' : 'Place a bubble, then press <kbd>Tab</kbd> to add a connected one. You can also drag a dot between existing shapes.' },
    );
  }
  list.push(
    { target: '[data-tool="hand"]', scene: 'pinch', title: 'Move around the board', body: touch ? 'Slide two fingers to pan. Spread them to zoom in, even while the pen is selected.' : 'Press <kbd>H</kbd> for the Hand tool and drag to pan. Pinch to zoom, or hold <kbd>⌘</kbd> while scrolling.' },
    { target: '#menu-btn', scene: 'search', title: 'Find a tool or a board', body: touch ? 'Open the board menu and tap Search. Enter a tool name, a board title, or a word from a note to find where you wrote it.' : 'Press <kbd>⌘K</kbd> and type a tool name, a board title, or a word from a note. Use the arrow keys to choose a result and <kbd>Enter</kbd> to open it.' },
    { target: '#viewnav', scene: 'views', title: 'Find your way back', body: canEdit() ? 'Open Views and choose Add this view to bookmark the area on screen. Its name comes from the content and you can rename it.' : 'Choose a saved view to jump there. When others are here, choose Follow and pick their name to follow their camera.' },
  );
  if (isOwner() && !session.invite) list.push({ target: '#share-btn', scene: 'invite', title: 'Invite someone in', body: 'Open Share and choose whether the invite lets someone edit or view. They can join with just a screen name.' });
  return list;
}

let card: HTMLDivElement | null = null;
let ring: HTMLDivElement | null = null;
let list: Step[] = [];
let track: Track = 'basics';
let idx = 0;
let playing = false;
let timer = 0, remaining = STEP_MS, startedAt = 0;
let returnFocus: HTMLElement | null = null;

export function tourSeen() {
  try { return localStorage.getItem(SEEN) === '1'; } catch { return true; }
}

export function startFirstTour() {
  if (!card && !tourSeen() && !document.querySelector('dialog[open]') &&
      !document.activeElement?.closest('input, textarea, [contenteditable="true"]')) startTour();
}

export function startTour(which: Track = 'basics') {
  endTour(false);
  track = which;
  const latest = releases[0];
  list = which === 'latest' ? latest.tour ?? latest.changes.map((body) => ({ title: latest.title, body })) : basics();
  idx = 0;
  playing = which === 'latest' && !reduceMotion.matches;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  card = document.createElement('div');
  card.id = 'tour';
  card.className = 'panel';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'tour-title');
  card.innerHTML = `
    <div class="tour-top"><span class="tour-count"></span><button class="tour-skip" data-tour="skip">Skip</button></div>
    <div class="tour-slide" aria-live="polite" aria-atomic="true"></div>
    <div class="tour-foot">
      <button class="tour-back tour-play" data-tour="play"></button>
      <button class="tour-back" data-tour="back">Back</button>
      <button class="tour-next" data-tour="next">Next</button>
    </div>`;
  ring = document.createElement('div');
  ring.id = 'tour-ring';
  document.body.append(ring, card);
  card.addEventListener('keydown', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-tour]')?.dataset.tour;
    if (act === 'next') go(1);
    else if (act === 'back') go(-1);
    else if (act === 'skip') endTour(true);
    else if (act === 'play') {
      if (idx === list.length - 1 && remaining === 0) { idx = 0; playing = true; show(); }
      else setPlaying(!playing);
    }
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  document.addEventListener('visibilitychange', pauseWhenHidden);
  show();
  card.querySelector<HTMLElement>('.tour-next')!.focus({ preventScroll: true });
}

function schedule() {
  clearTimeout(timer);
  if (!playing) return;
  startedAt = performance.now();
  timer = window.setTimeout(() => {
    if (idx < list.length - 1) go(1);
    else { playing = false; remaining = 0; updatePlayback(); }
  }, remaining);
}

function setPlaying(on: boolean) {
  if (playing) remaining = Math.max(0, remaining - (performance.now() - startedAt));
  playing = on;
  updatePlayback();
  schedule();
}

function pauseWhenHidden() {
  if (document.hidden && playing) setPlaying(false);
}

function updatePlayback() {
  if (!card) return;
  const play = card.querySelector<HTMLButtonElement>('[data-tour="play"]')!;
  play.hidden = track !== 'latest';
  play.textContent = playing ? 'Pause' : idx === list.length - 1 && remaining === 0 ? 'Replay' : 'Play';
  card.classList.toggle('paused', track === 'latest' && !playing);
  if (playing) card.classList.remove('still');
}

function go(d: number) {
  const next = idx + d;
  if (next >= list.length) return endTour(true);
  if (next < 0) return;
  idx = next;
  show();
}

function onKey(e: KeyboardEvent) {
  if (!card || (e.target as Element)?.closest?.('dialog[open], input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  if (e.key === 'Escape' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') endTour(true);
    else go(e.key === 'ArrowRight' ? 1 : -1);
  }
}

function show() {
  if (!card) return;
  const s = list[idx];
  const last = idx === list.length - 1;
  const label = track === 'latest' ? `New in v${releases[0].version}` : 'Quick tour';
  card.querySelector('.tour-count')!.textContent = `${label} · ${idx + 1}/${list.length}`;
  card.querySelector('.tour-slide')!.innerHTML = `${tourScene(s.scene)}<h4 id="tour-title">${s.title}</h4><p>${keyLabel(s.body)}</p>`;
  card.querySelector<HTMLButtonElement>('[data-tour="back"]')!.disabled = idx === 0;
  card.querySelector('.tour-next')!.textContent = last ? 'Done' : 'Next';
  remaining = STEP_MS;
  card.classList.toggle('still', track === 'latest' && !playing);
  updatePlayback();
  schedule();
  place();
}

function place() {
  if (!card || !ring) return;
  const s = list[idx];
  const r = [s.target, s.fallback].flatMap((selector) => selector ? [...document.querySelectorAll(selector)] : [])
    .map((el) => el.getBoundingClientRect()).find((box) => box.width > 0 && box.height > 0);
  const cw = card.offsetWidth, ch = card.offsetHeight, m = 14;
  if (!r) {
    ring.hidden = true;
    const tb = document.getElementById('toolbar')!.getBoundingClientRect();
    card.style.left = `${Math.round((innerWidth - cw) / 2)}px`;
    card.style.top = `${Math.round(Math.max(m, tb.top - ch - 18))}px`;
    card.dataset.arrow = '';
    return;
  }
  ring.hidden = false;
  const pad = 5;
  Object.assign(ring.style, {
    left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
  });
  const below = r.top + r.height / 2 < innerHeight / 2;
  const top = below ? r.bottom + 16 : r.top - ch - 16;
  const left = Math.min(Math.max(m, r.left + r.width / 2 - cw / 2), innerWidth - cw - m);
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(Math.min(Math.max(m, top), innerHeight - ch - m))}px`;
  card.dataset.arrow = below ? 'up' : 'down';
  card.style.setProperty('--ax', `${Math.round(Math.min(Math.max(16, r.left + r.width / 2 - left), cw - 16))}px`);
}

export function endTour(markSeen: boolean) {
  if (markSeen && track === 'basics') try { localStorage.setItem(SEEN, '1'); } catch { /* ignore */ }
  clearTimeout(timer);
  playing = false;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  document.removeEventListener('visibilitychange', pauseWhenHidden);
  const restore = card?.contains(document.activeElement);
  card?.remove();
  ring?.remove();
  card = ring = null;
  if (restore) {
    const target = returnFocus?.getClientRects().length ? returnFocus : document.getElementById('menu-btn');
    target?.focus({ preventScroll: true });
  }
  returnFocus = null;
}
