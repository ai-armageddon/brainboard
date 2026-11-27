// The camera button turns the screen into a viewfinder: frame the whole screen,
// drag out an area, use the selection or a saved view, pick a look, and press the shutter. The shot is
// rendered sharp on the server; a little print of it lands in the corner with Save and Copy.
// Switch it to Video (⌥R opens it that way) and the same frame records the board instead: see record.ts.
import { S } from './state';
import { hooks, viewport, world, selBounds } from './render';
import { session } from './net';
import { goToView } from './views';
import { icon } from './icons';
import { toast } from './ui';
import { keyLabel } from './keys';
import {
  BACKDROP_NAMES, bindCaptureSave, copyMedia, dismissCaptureCard, latestMedia, listMedia, mediaEvents, mediaUrl, openMedia, saveMedia, takeScreenshot,
  type Backdrop, type MediaItem,
} from './media';
import { canRecord, recordingActive, recordingName, startRecording, stopRecording } from './record';
import type { Box } from './types';

type Mode = 'screen' | 'region' | 'selection' | 'view';
const MODES: [Mode, string, string][] = [
  ['screen', 'Screen', 'Everything on screen'],
  ['region', 'Area', 'Drag to frame an area'],
  ['selection', 'Selection', 'What you’ve selected'],
  ['view', 'View', 'A saved view'],
];
const LOOKS: Backdrop[] = ['none', 'aurora', 'sunset', 'ocean', 'mist', 'night'];
export type Kind = 'photo' | 'video';

interface Prefs {
  backdrop: Backdrop; grid: boolean; quality: 1 | 2 | 3; sound: boolean;
  /** video: frames a second, audio sources, and whether the toolbars are in the picture */
  fps: 30 | 60; tabAudio: boolean; mic: boolean; chrome: boolean;
}
const PREFS = 'bb-shot';
const prefs: Prefs = (() => {
  const d: Prefs = { backdrop: 'aurora', grid: true, quality: 2, sound: true, fps: 60, tabAudio: false, mic: false, chrome: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs> }; } catch { return d; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* ignore */ } };

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let root: HTMLDivElement | null = null;
let active = false;
let kind: Kind = 'photo';
let mode: Mode = 'screen';
/** The framed area in board coordinates (screen mode recomputes it from the camera). */
let frame: Box | null = null;
let viewId: string | null = null;

const $ = <T extends HTMLElement>(sel: string) => root!.querySelector<T>(sel)!;

// ---------------------------------------------------------------- geometry

const toScreen = (b: Box) => ({ x: b.x * S.cam.z + S.cam.x, y: b.y * S.cam.z + S.cam.y, w: b.w * S.cam.z, h: b.h * S.cam.z });
const toWorld = (r: Box) => ({ x: (r.x - S.cam.x) / S.cam.z, y: (r.y - S.cam.y) / S.cam.z, w: r.w / S.cam.z, h: r.h / S.cam.z });
const screenBox = () => toWorld({ x: 0, y: 0, w: innerWidth, h: innerHeight });

function selectionBox(): Box | null {
  if (!S.selected.size || !selBounds) return null;
  const b = selBounds;
  const pad = Math.max(24, Math.max(b.w, b.h) * 0.06);
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

const currentFrame = (): Box | null => (mode === 'screen' ? screenBox() : frame);

/** Output pixels per board unit: on-screen size at the chosen sharpness, or "fits the screen" for views and selections. */
function scaleFor(b: Box) {
  if (mode === 'screen' || mode === 'region') return S.cam.z * prefs.quality;
  const fit = Math.min(innerWidth / b.w, innerHeight / b.h) * 0.94;
  return Math.min(Math.max(fit, 0.1), 4) * prefs.quality;
}

const theme = (): 'light' | 'dark' => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
};

function shotName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${session.boardName || 'Brainboard'} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- the viewfinder

function build() {
  root = document.createElement('div');
  root.id = 'shot';
  root.className = 'shot';
  root.hidden = true;
  root.innerHTML = `
    <div class="shot-catch"></div>
    <div class="shot-frame" aria-hidden="true">
      <i class="shot-c tl"></i><i class="shot-c tr"></i><i class="shot-c bl"></i><i class="shot-c br"></i>
      <i class="shot-thirds"></i><i class="shot-focus"></i>
      <span class="shot-size"></span>
      <i class="shot-h" data-h="nw"></i><i class="shot-h" data-h="ne"></i><i class="shot-h" data-h="sw"></i><i class="shot-h" data-h="se"></i>
    </div>
    <div class="shot-hint" role="status" aria-live="polite"></div>
    <div class="shot-dock panel" role="toolbar" aria-label="Screenshot">
      <button class="shot-roll" data-act="roll" aria-label="Open Media" data-tip="Media"><span class="shot-roll-img"></span></button>
      <div class="shot-kind" role="radiogroup" aria-label="Photo or video">
        <button role="radio" data-kind="photo" data-tip="Screenshot">${icon('camera', 16)}<span>Photo</span></button>
        <button role="radio" data-kind="video" data-tip="Record the board · V"><i class="rec-dot"></i><span>Video</span></button>
      </div>
      <div class="shot-modes" role="radiogroup" aria-label="Capture">
        ${MODES.map(([m, label, tip], i) => `<button role="radio" data-mode="${m}" data-tip="${tip} · ${i + 1}">${label}${m === 'view' ? icon('chevron', 13) : ''}</button>`).join('')}
      </div>
      <button class="shot-shutter" data-act="shoot" aria-keyshortcuts="Enter"><i aria-hidden="true"></i><span>Take screenshot</span></button>
      <div class="shot-looks" role="radiogroup" aria-label="Look">
        ${LOOKS.map((l) => `<button role="radio" class="shot-look" data-look="${l}" aria-label="${BACKDROP_NAMES[l]}" data-tip="${BACKDROP_NAMES[l]}"></button>`).join('')}
      </div>
      <span class="sep"></span>
      <button class="cbtn" data-act="grid" data-tip="Canvas dots · G">${icon('dots', 18)}</button>
      <button class="cbtn shot-q photo-only" data-act="quality" data-tip="Sharpness · Q"></button>
      <button class="cbtn photo-only" data-act="sound" data-tip="Shutter sound"></button>
      <button class="cbtn shot-q video-only" data-act="fps" data-tip="Frames a second · F"></button>
      <div class="shot-audio video-only" role="group" aria-label="Recording audio">
        <label class="shot-keep"><input type="checkbox" data-audio="tabAudio"> Tab audio</label>
        <label class="shot-keep"><input type="checkbox" data-audio="mic"> Microphone</label>
      </div>
      <button class="cbtn video-only" data-act="chrome" data-tip="Toolbars in the video · T">${icon('eye', 18)}</button>
      <label class="shot-keep"><input type="checkbox" data-keep-media /> Save to Media</label>
      <button class="cbtn" data-act="close" data-tip="Cancel · Esc" aria-label="Cancel">${icon('close', 18)}</button>
    </div>
    <div class="shot-views panel" role="menu" hidden></div>`;
  document.body.append(root);

  const dock = $('.shot-dock');
  dock.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.mode) return pickMode(b.dataset.mode as Mode, b);
    if (b.dataset.kind) return pickKind(b.dataset.kind as Kind);
    if (b.dataset.look) { prefs.backdrop = b.dataset.look as Backdrop; savePrefs(); return paint(); }
    switch (b.dataset.act) {
      case 'shoot': return void shoot();
      case 'close': return close();
      case 'roll': close(); return openMedia(undefined, openScreenshot);
      case 'grid': prefs.grid = !prefs.grid; savePrefs(); return paint();
      case 'quality': prefs.quality = prefs.quality === 3 ? 1 : (prefs.quality + 1) as 2 | 3; savePrefs(); return paint();
      case 'sound': prefs.sound = !prefs.sound; savePrefs(); if (prefs.sound) shutterSound(); return paint();
      case 'fps': prefs.fps = prefs.fps === 60 ? 30 : 60; savePrefs(); return paint();
      case 'chrome': prefs.chrome = !prefs.chrome; savePrefs(); return paint();
    }
  });
  dock.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    const source = input.dataset.audio;
    if (source !== 'tabAudio' && source !== 'mic') return;
    prefs[source] = input.checked;
    savePrefs();
  });
  $('.shot-views').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-view]');
    if (!b) return;
    const v = session.views.find((x) => x.id === b.dataset.view);
    $('.shot-views').hidden = true;
    if (!v) return;
    mode = 'view';
    viewId = v.id;
    frame = { x: v.x, y: v.y, w: v.w, h: v.h };
    easeFrame();
    goToView(v);
    paint();
  });

  // Drag out an area anywhere; drag inside it to move it; drag a corner to resize it.
  const catcher = $('.shot-catch');
  const frameEl = $('.shot-frame');
  let drag: { kind: 'new' | 'move' | 'resize'; sx: number; sy: number; start: Box; corner?: string; moved: boolean } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    $('.shot-views').hidden = true;
    const h = (e.target as Element).closest<HTMLElement>('.shot-h');
    const r = frame && mode !== 'screen' ? toScreen(frame) : null;
    const inside = r && e.clientX > r.x && e.clientX < r.x + r.w && e.clientY > r.y && e.clientY < r.y + r.h;
    drag = {
      kind: h ? 'resize' : inside ? 'move' : 'new', sx: e.clientX, sy: e.clientY,
      start: r ?? { x: e.clientX, y: e.clientY, w: 0, h: 0 }, corner: h?.dataset.h, moved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    let r: Box;
    if (drag.kind === 'new') {
      let w = dx, h = dy;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      r = { x: Math.min(drag.sx, drag.sx + w), y: Math.min(drag.sy, drag.sy + h), w: Math.abs(w), h: Math.abs(h) };
    } else if (drag.kind === 'move') {
      r = { ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy };
    } else {
      const s = drag.start, c = drag.corner!;
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (c.includes('w')) x0 += dx; else x1 += dx;
      if (c.includes('n')) y0 += dy; else y1 += dy;
      r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    mode = 'region';
    viewId = null;
    frame = toWorld(r);
    paint();
  };
  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    if (frame && (frame.w * S.cam.z < 8 || frame.h * S.cam.z < 8)) { frame = null; mode = 'screen'; paint(); return; }
    // A fresh drag shoots straight away, like a camera; holding ⌥ keeps the frame to adjust first.
    // A video frame always waits for the record button.
    if (kind === 'photo' && d.kind === 'new' && !e.altKey) void shoot();
  };
  for (const el of [catcher, frameEl]) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', () => { drag = null; });
  }
  frameEl.addEventListener('dblclick', () => void shoot());
  // Scroll and pinch still move the board underneath, to compose the shot.
  root.addEventListener('wheel', (e) => {
    if ((e.target as Element).closest('.shot-dock, .shot-views')) return;
    e.preventDefault();
    viewport.dispatchEvent(new WheelEvent('wheel', e));
  }, { passive: false });

  mediaEvents.addEventListener('added', paintRoll);
}

/** Glide the frame to its next place (mode changes), but follow drags and pans instantly. */
let easeTimer = 0;
function easeFrame() {
  root!.classList.add('ease');
  clearTimeout(easeTimer);
  easeTimer = window.setTimeout(() => root?.classList.remove('ease'), 360);
}

function pickKind(k: Kind) {
  if (k === 'video' && !canRecord) return hint('Recording needs Chrome, Edge or another Chromium browser on a computer', true);
  if (k === 'photo' && !session.boardId) return hint(S.items.length ? 'One moment: the board is still saving' : 'Add something to the board first, then take a screenshot', true);
  if (kind !== k) $<HTMLInputElement>('[data-keep-media]').checked = false;
  kind = k;
  paint();
}

function pickMode(m: Mode, btn?: HTMLElement) {
  $('.shot-views').hidden = true;
  if (m !== 'view') easeFrame();
  if (m === 'selection') {
    const b = selectionBox();
    if (!b) return hint('Select something on the board first, then come back', true);
    frame = b;
  } else if (m === 'view') {
    if (!session.views.length) return hint('No saved views on this board yet', true);
    const menu = $('.shot-views');
    menu.innerHTML = `<div class="shot-views-title">Saved views</div>` + session.views.map((v) =>
      `<button role="menuitem" data-view="${esc(v.id)}" aria-checked="${v.id === viewId}">${icon('views', 16)}<span>${esc(v.name)}</span></button>`).join('');
    menu.hidden = false;
    if (btn) {
      const r = btn.getBoundingClientRect();
      menu.style.left = `${Math.round(Math.min(innerWidth - 250, Math.max(12, r.left + r.width / 2 - 120)))}px`;
      menu.style.bottom = `${Math.round(innerHeight - r.top + 10)}px`;
    }
    return;
  } else if (m === 'region') {
    if (mode !== 'region' || !frame) {
      // Start from a centred 16:10 frame you can then move and resize, or just drag a new one.
      const w = Math.min(innerWidth * 0.6, 960), h = Math.min(innerHeight * 0.55, w / 1.6);
      frame = toWorld({ x: (innerWidth - w) / 2, y: (innerHeight - h) / 2 - 30, w, h });
    }
  } else frame = null;
  mode = m;
  viewId = null;
  paint();
}

let hintTimer = 0;
function hint(msg?: string, warn = false) {
  const el = $('.shot-hint');
  clearTimeout(hintTimer);
  el.classList.toggle('warn', warn);
  if (msg) {
    el.textContent = msg;
    hintTimer = window.setTimeout(() => hint(), 2600);
    return;
  }
  el.innerHTML = keyLabel(kind === 'video'
    ? (mode === 'screen'
      ? 'Drag to frame an area · <kbd>Enter</kbd> record screen · <kbd>Esc</kbd> cancel'
      : 'Drag to adjust the frame · <kbd>Enter</kbd> start recording · <kbd>Esc</kbd> cancel')
    : mode === 'screen'
      ? 'Drag to take an area screenshot (hold <kbd>⌥</kbd> to adjust) · <kbd>Enter</kbd> capture screen · <kbd>Esc</kbd> cancel'
      : 'Drag to adjust the frame · <kbd>Enter</kbd> take screenshot · <kbd>Esc</kbd> cancel');
}

function paint() {
  if (!root) return;
  root.dataset.mode = mode;
  root.dataset.kind = kind;
  const b = currentFrame();
  const fr = $('.shot-frame');
  if (b) {
    const r = mode === 'screen' ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : toScreen(b);
    fr.style.transform = `translate(${r.x}px,${r.y}px)`;
    fr.style.width = `${r.w}px`;
    fr.style.height = `${r.h}px`;
    if (kind === 'video') {
      // A video is as sharp as the screen it's filmed from.
      const v = videoRect() ?? r, d = devicePixelRatio || 1;
      $('.shot-size').textContent = `${Math.round(v.w * d).toLocaleString()} × ${Math.round(v.h * d).toLocaleString()} · ${prefs.fps} fps`;
    } else {
      const k = scaleFor(b);
      $('.shot-size').textContent = `${Math.round(b.w * k).toLocaleString()} × ${Math.round(b.h * k).toLocaleString()}`;
    }
    fr.classList.toggle('low', r.y + r.h > innerHeight - 120);
  }
  root.querySelectorAll<HTMLElement>('[data-mode]').forEach((x) => {
    x.setAttribute('aria-checked', String(x.dataset.mode === mode));
    if (x.dataset.mode === 'selection') x.classList.toggle('off', !selectionBox());
    if (x.dataset.mode === 'view') x.classList.toggle('off', !session.views.length);
  });
  root.querySelectorAll<HTMLElement>('[data-kind]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.kind === kind)));
  root.querySelectorAll<HTMLElement>('[data-look]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.look === prefs.backdrop)));
  const shutter = $('.shot-shutter');
  shutter.querySelector('span')!.textContent = kind === 'video' ? 'Start recording' : 'Take screenshot';
  const fps = root.querySelector<HTMLElement>('[data-act="fps"]')!;
  fps.innerHTML = `<b>${prefs.fps}</b>`;
  fps.setAttribute('aria-label', `${prefs.fps} frames a second`);
  $<HTMLInputElement>('[data-audio="tabAudio"]').checked = prefs.tabAudio;
  $<HTMLInputElement>('[data-audio="mic"]').checked = prefs.mic;
  const chrome = root.querySelector<HTMLElement>('[data-act="chrome"]')!;
  chrome.setAttribute('aria-pressed', String(prefs.chrome));
  chrome.setAttribute('aria-label', prefs.chrome ? 'Toolbars in the video' : 'Only the board in the video');
  root.dataset.look = prefs.backdrop;
  const grid = root.querySelector<HTMLElement>('[data-act="grid"]')!;
  grid.setAttribute('aria-pressed', String(prefs.grid));
  grid.setAttribute('aria-label', `Canvas dots ${prefs.grid ? 'on' : 'off'}`);
  const q = root.querySelector<HTMLElement>('[data-act="quality"]')!;
  q.innerHTML = `<b>${prefs.quality}×</b>`;
  q.setAttribute('aria-label', `Sharpness ${prefs.quality}×`);
  const snd = root.querySelector<HTMLElement>('[data-act="sound"]')!;
  snd.innerHTML = icon(prefs.sound ? 'sound' : 'soundOff', 18);
  snd.setAttribute('aria-label', prefs.sound ? 'Shutter sound on' : 'Shutter sound off');
  if (!$('.shot-hint').classList.contains('warn')) hint();
}

function paintRoll() {
  if (!root) return;
  const it = latestMedia();
  const el = $('.shot-roll-img');
  el.innerHTML = it ? `<img alt="" src="${mediaUrl(it, { thumb: true })}">` : icon('media', 18);
  el.querySelector('img')?.addEventListener('error', () => { el.innerHTML = icon('media', 18); }, { once: true });
}

// ---------------------------------------------------------------- open & close

/** Open the camera: for a screenshot, or (`video`) to record the board. */
export function openScreenshot(want: Kind = 'photo') {
  if (recordingActive()) return toast(keyLabel('Already recording: press ⌥R to stop'));
  if (active) { if (want !== kind) pickKind(want); return; }
  if (document.querySelector('.auth-backdrop')) return; // another dialog is open
  if (want === 'video' && !canRecord) return toast('Recording needs Chrome, Edge or another Chromium browser on a computer');
  // A screenshot is drawn from the saved board, so it needs one. A video films the screen: an empty board is fine.
  if (want === 'photo' && !session.boardId) return toast(S.items.length ? 'One moment: the board is still saving' : 'Add something to the board first, then take a screenshot');
  if (!root) build();
  active = true;
  $<HTMLInputElement>('[data-keep-media]').checked = false;
  kind = want;
  viewId = null;
  const sel = selectionBox();
  // Something selected: start framed on it. Otherwise the whole screen.
  if (sel) { mode = 'selection'; frame = sel; } else { mode = 'screen'; frame = null; }
  root!.hidden = false;
  document.body.classList.add('shooting');
  requestAnimationFrame(() => root?.classList.add('in'));
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', paint);
  paint();
  paintRoll();
  if (!latestMedia()) void listMedia().then(paintRoll).catch(() => {});
}

function close() {
  if (!active || !root) return;
  active = false;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', paint);
  document.body.classList.remove('shooting');
  root.classList.remove('in');
  $('.shot-views').hidden = true;
  const r = root;
  setTimeout(() => { if (!active) r.hidden = true; }, 220);
}

function onKey(e: KeyboardEvent) {
  if (!active) return;
  if (e.key === ' ' && (e.target as Element)?.matches?.('.shot-dock input[type=checkbox]')) { e.stopPropagation(); return; }
  if (e.metaKey || e.ctrlKey) return;
  e.stopImmediatePropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!$('.shot-views').hidden) $('.shot-views').hidden = true;
    else close();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void shoot(); return; }
  // ⌥R, which opened the camera for video, flips it between photo and video once it's up.
  if (e.altKey && e.code === 'KeyR') { e.preventDefault(); return pickKind(kind === 'video' ? 'photo' : 'video'); }
  const n = Number(e.key);
  if (n >= 1 && n <= 4) {
    e.preventDefault();
    const m = MODES[n - 1][0];
    return pickMode(m, root!.querySelector<HTMLElement>(`[data-mode="${m}"]`)!);
  }
  const k = e.key.toLowerCase();
  if (k === 'g') { prefs.grid = !prefs.grid; savePrefs(); paint(); }
  if (k === 'v') pickKind(kind === 'video' ? 'photo' : 'video');
  if (kind === 'video') {
    if (k === 'f') { prefs.fps = prefs.fps === 60 ? 30 : 60; savePrefs(); paint(); }
    if (k === 'm') { prefs.mic = !prefs.mic; savePrefs(); paint(); }
    if (k === 't') { prefs.chrome = !prefs.chrome; savePrefs(); paint(); }
  } else if (k === 'q') { prefs.quality = prefs.quality === 3 ? 1 : (prefs.quality + 1) as 2 | 3; savePrefs(); paint(); }
  if (k === 'b' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const i = LOOKS.indexOf(prefs.backdrop) + (e.key === 'ArrowLeft' ? -1 : 1);
    prefs.backdrop = LOOKS[(i + LOOKS.length) % LOOKS.length];
    savePrefs();
    paint();
  }
}

/** Keep the frame on its content as the board pans and zooms under it. */
export function initScreenshot() {
  const prev = hooks.afterCamera;
  hooks.afterCamera = () => { prev(); if (active) paint(); };
  document.getElementById('shot-btn')?.addEventListener('click', () => openScreenshot());
  // Handle the recording chord before note editors or canvas tools can swallow it.
  window.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || (e.code !== 'KeyS' && e.key.toLowerCase() !== 's')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (recordingActive()) { stopRecording(); return; }
    if ((!session.draft && !session.boardId) || document.querySelector('dialog[open], .auth-backdrop, #overlay:not([hidden]), #home:not([hidden]), #share:not([hidden]), #shortcuts:not([hidden])')) return;
    if (active && kind === 'photo' && canRecord) pickKind('video');
    record();
  }, true);
}

// ---------------------------------------------------------------- the shot

let shooting = false;

/** The frame as it sits on screen, cut to what's actually visible: a video can only film what the tab shows. */
function videoRect(): Box | null {
  const b = currentFrame();
  if (!b) return null;
  const r = mode === 'screen' ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : toScreen(b);
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(innerWidth, r.x + r.w) - x, h = Math.min(innerHeight, r.y + r.h) - y;
  return w >= 32 && h >= 32 ? { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } : null;
}

function record() {
  if (!canRecord) return toast('Recording needs Chrome, Edge or another Chromium browser on a computer');
  const rect = active ? videoRect() : { x: 0, y: 0, w: innerWidth, h: innerHeight };
  if (!rect) return hint('Bring what you want to record onto the screen first', true);
  const full = rect.w >= innerWidth - 1 && rect.h >= innerHeight - 1;
  const keepInMedia = active && $<HTMLInputElement>('[data-keep-media]').checked;
  close();
  void startRecording({
    rect, full, look: prefs.backdrop, fps: prefs.fps, tabAudio: prefs.tabAudio, mic: prefs.mic, chrome: prefs.chrome, grid: prefs.grid,
    name: recordingName(), board: session.boardId ? { id: session.boardId, name: session.boardName } : null, camera: openScreenshot, keepInMedia,
  });
}

async function shoot() {
  if (!active || shooting) return;
  if (kind === 'video') return record();
  const b = currentFrame();
  if (!b || b.w <= 0 || b.h <= 0) return;
  shooting = true;
  const r = mode === 'screen' ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : toScreen(b);
  const scale = scaleFor(b);
  const look = prefs.backdrop;
  const keepInMedia = $<HTMLInputElement>('[data-keep-media]').checked;
  const print = freeze(r);
  close();
  if (prefs.sound) shutterSound();
  flash(r);
  const card = showCard(look, r, keepInMedia);
  const capture = takeScreenshot({
    frame: b, scale, theme: theme(), grid: prefs.grid, zoom: S.cam.z, backdrop: look, name: shotName(),
  });
  try {
    const [, { item, blob }] = await Promise.all([develop(print, r, card), capture]);
    card.ready(item, blob);
  } catch (err) {
    card.failed((err as Error).message);
  } finally {
    shooting = false;
  }
}

/** A frozen copy of exactly what's on screen inside the frame: it becomes the print that flies to the corner. */
function freeze(r: Box) {
  const print = document.createElement('div');
  print.className = 'shot-print';
  const cam = S.cam;
  print.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
  const paper = document.createElement('div');
  paper.className = 'shot-paper';
  paper.style.backgroundSize = viewport.style.backgroundSize;
  paper.style.backgroundPosition = `${cam.x - r.x}px ${cam.y - r.y}px`;
  if (!prefs.grid) paper.style.backgroundImage = 'none';
  const copy = world.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.querySelectorAll('#selbox, #live').forEach((x) => x.remove());
  copy.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
  copy.querySelectorAll('.selected, .peer-sel, .editing').forEach((x) => x.classList.remove('selected', 'peer-sel', 'editing'));
  copy.querySelectorAll('.port').forEach((x) => x.remove());
  copy.querySelectorAll('[contenteditable]').forEach((x) => x.removeAttribute('contenteditable'));
  copy.classList.add('shot-world');
  copy.style.transform = `translate(${cam.x - r.x}px,${cam.y - r.y}px) scale(${cam.z})`;
  paper.append(copy);
  print.append(paper);
  document.body.append(print);
  return print;
}

function flash(r: Box) {
  const f = document.createElement('div');
  f.className = 'shot-flash';
  f.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
  document.body.append(f);
  f.animate([{ opacity: 0.92 }, { opacity: 0 }], { duration: reducedMotion() ? 120 : 520, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished
    .finally(() => f.remove());
}

/** The print lifts off the board, then glides into the card in the corner. */
async function develop(print: HTMLElement, r: Box, card: ReturnType<typeof showCard>) {
  const slot = card.slot.getBoundingClientRect();
  const k = Math.min(slot.width / r.w, slot.height / r.h);
  const tx = slot.left + slot.width / 2 - (r.x + r.w / 2), ty = slot.top + slot.height / 2 - (r.y + r.h / 2);
  const fullScreen = r.w >= innerWidth - 2 && r.h >= innerHeight - 2;
  const lift = fullScreen ? 0.9 : 0.965;
  if (reducedMotion()) {
    await print.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
  } else {
    await print.animate([
      { transform: 'none', borderRadius: '0px', boxShadow: '0 0 0 0 rgba(0,0,0,0)', offset: 0 },
      { transform: `scale(${lift})`, borderRadius: '10px', boxShadow: '0 30px 80px -20px rgba(0,0,0,.55), 0 0 0 6px rgba(255,255,255,.92)', offset: 0.32 },
      { transform: `scale(${lift})`, borderRadius: '10px', boxShadow: '0 30px 80px -20px rgba(0,0,0,.55), 0 0 0 6px rgba(255,255,255,.92)', offset: 0.5 },
      { transform: `translate(${tx}px,${ty}px) scale(${k})`, borderRadius: `${4 / k}px`, boxShadow: `0 10px 30px -10px rgba(0,0,0,.5), 0 0 0 ${2 / k}px rgba(255,255,255,.95)`, offset: 1 },
    ], { duration: 1050, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' }).finished;
  }
  // Hand the frozen print over to the card, where the real image replaces it once it's rendered.
  print.getAnimations().forEach((a) => a.cancel());
  print.removeAttribute('style');
  print.classList.add('docked');
  print.style.cssText = `width:${r.w}px;height:${r.h}px;left:${(slot.width - r.w * k) / 2}px;top:${(slot.height - r.h * k) / 2}px;transform:scale(${k});`;
  card.slot.append(print);
  card.el.classList.add('landed');
}

// ---------------------------------------------------------------- the card in the corner

function showCard(look: Backdrop, r: Box, keepInMedia: boolean) {
  dismissCaptureCard();
  const el = document.createElement('div');
  el.className = 'shot-card panel';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <button class="shot-card-thumb" data-act="open" aria-label="Open in Media" disabled><span class="shot-slot"></span></button>
    <div class="shot-card-body">
      <b>Preparing screenshot…</b>
      <span class="shot-card-meta">${BACKDROP_NAMES[look]}</span>
      <div class="shot-card-acts">
        <button data-act="save" disabled>${icon('download', 15)}<span>Save locally</span></button>
        <button data-act="copy" disabled>${icon('copy', 15)}<span>Copy</span></button>
        <button data-act="library" disabled>${icon('media', 15)}<span>Save to Media</span></button>
      </div>
    </div>
    <button class="shot-card-x" data-act="dismiss" aria-label="Dismiss">${icon('close', 14)}</button>`;
  // The thumbnail takes the shot's shape, within reason.
  const tw = 132, th = Math.round(Math.min(Math.max(tw * r.h / r.w, 60), 132));
  el.style.setProperty('--tw', `${tw}px`);
  el.style.setProperty('--th', `${th}px`);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  let item: MediaItem | null = null;
  let localBlob: Blob | undefined;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 260);
    localBlob = undefined;
    item = null;
  };
  const arm = (ms: number) => { clearTimeout(timer); timer = window.setTimeout(dismiss, ms); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { if (item?.id) arm(4000); });
  el.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'dismiss') return dismiss();
    if (!item) return;
    if (act === 'save') void saveMedia(item, localBlob);
    else if (act === 'copy') void copyMedia(item, localBlob);
    else if (act === 'open' && item.id) { const id = item.id; dismiss(); openMedia(id, openScreenshot); }
  });

  return {
    el,
    slot: el.querySelector<HTMLElement>('.shot-slot')!,
    ready(it: MediaItem, blob: Blob) {
      if (!el.isConnected) return;
      item = it;
      localBlob = blob;
      el.querySelector('.shot-card-body b')!.textContent = 'Screenshot ready';
      el.querySelector('.shot-card-meta')!.textContent = `${it.w.toLocaleString()} × ${it.h.toLocaleString()} · ${BACKDROP_NAMES[it.backdrop]}`;
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-act="save"], [data-act="copy"]')) b.disabled = false;
      const keep = bindCaptureSave(el, it, blob, null, openScreenshot, saved => {
        item = saved;
        el.querySelector<HTMLButtonElement>('.shot-card-thumb')!.disabled = false;
        arm(7000);
      });
      if (keepInMedia) void keep();
      const img = new Image();
      img.alt = '';
      img.className = 'shot-real';
      const preview = URL.createObjectURL(blob);
      img.src = preview;
      img.decode().then(() => {
        el.querySelector('.shot-slot')!.append(img);
        // The framed shot is a little taller than the print: the thumbnail eases to its shape as it appears.
        el.style.setProperty('--th', `${Math.round(Math.min(Math.max(tw * it.h / it.w, 60), 132))}px`);
        requestAnimationFrame(() => { img.classList.add('in'); el.classList.add('real'); });
      }).catch(() => {}).finally(() => URL.revokeObjectURL(preview));
      el.classList.add('done');
    },
    failed(msg: string) {
      el.classList.add('error');
      el.querySelector('.shot-card-body b')!.textContent = 'Couldn’t take the screenshot';
      el.querySelector('.shot-card-meta')!.textContent = msg;
      arm(6000);
    },
  };
}

// ---------------------------------------------------------------- sound

let audio: AudioContext | null = null;

/** A soft mechanical shutter: two short filtered clicks, made on the fly (no audio files). */
function shutterSound() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    void ctx.resume();
    const click = (at: number, freq: number, gain: number, len: number) => {
      const n = Math.floor(ctx.sampleRate * len);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(ctx.currentTime + at);
    };
    click(0, 2600, 0.55, 0.045);
    click(0.012, 900, 0.35, 0.06);
    click(0.11, 3200, 0.35, 0.035);
    click(0.118, 1200, 0.25, 0.05);
  } catch { /* no audio: fine */ }
}

export const screenshotActive = () => active;
