// The shared browser: a small window over the board where one person looks something up and everyone else
// watches the same page, live.
//
// How it works: each person's window holds its own copy of the page in a sandboxed frame, loaded through
// /api/browse (see server/browse.ts). The driver's copy reports what they do (scroll, point, click, type, follow
// a link) and the other copies replay it, so nothing is streamed as video. Watchers lay the page out at the
// driver's size and scale it to whatever size their own window is, which keeps everyone's layout the same:
// moving, resizing or going full screen only changes your own view.
import { icon } from './icons';
import { account, browserDo, canEdit, events, sendBrowserEvent, session } from './net';
import { cleanBrowserEvent, type BrowserEvent, type BrowserState } from './protocol';
import { ensureBoard } from './boards';
import { ensureScreenName } from './account';
import { toast } from './ui';

const el = document.createElement('section');
el.id = 'browse';
el.className = 'panel';
el.hidden = true;
el.setAttribute('role', 'dialog');
el.setAttribute('aria-label', 'Shared browser');
el.innerHTML = `
  <header class="bw-bar">
    <i class="bw-move" aria-hidden="true">${icon('grip', 16)}</i>
    <button class="cbtn" data-bw="back" aria-label="Back" data-tip="Back">${icon('chevronLeft', 18)}</button>
    <button class="cbtn" data-bw="fwd" aria-label="Forward" data-tip="Forward">${icon('chevronRight', 18)}</button>
    <button class="cbtn" data-bw="reload" aria-label="Reload" data-tip="Reload">${icon('reload', 17)}</button>
    <form class="bw-address">
      ${icon('globe', 15)}
      <input name="q" type="text" inputmode="url" enterkeyhint="go" spellcheck="false" autocomplete="off" autocapitalize="off"
        placeholder="Search or type an address" aria-label="Address" />
    </form>
    <span class="bw-who" hidden></span>
    <button class="bw-take" data-bw="take" hidden>Take control</button>
    <button class="cbtn" data-bw="full" aria-label="Full screen"></button>
    <button class="cbtn" data-bw="close" aria-label="Close"></button>
  </header>
  <div class="bw-stage">
    <div class="bw-page"></div>
    <div class="bw-shield" hidden></div>
    <div class="bw-start">
      ${icon('globe', 34)}
      <b>Browse together</b>
      <p>Search or type an address. Everyone on this board sees the page and follows along as you scroll, click and type.</p>
    </div>
    <i class="bw-loading" hidden></i>
    <div class="bw-note" role="status" hidden><span></span><button type="button"></button></div>
  </div>
  ${['e', 'w', 's', 'se', 'sw'].map((g) => `<i class="bw-grip" data-grip="${g}"></i>`).join('')}`;

const pill = document.createElement('button');
pill.id = 'browse-pill';
pill.className = 'panel';
pill.hidden = true;

const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
const bar = q('.bw-bar');
const stage = q('.bw-stage');
const page = q('.bw-page');
const shield = q('.bw-shield');
const start = q('.bw-start');
const loadingBar = q('.bw-loading');
const noteEl = q('.bw-note');
const address = q<HTMLInputElement>('.bw-address input');
const who = q('.bw-who');
const btn = (name: string) => q<HTMLButtonElement>(`[data-bw="${name}"]`);

// ---------------------------------------------------------------- who is who

const me = () => session.you?.id ?? null;
const amDriver = () => !!session.browser && !!me() && session.browser.driver === me();
function driver(): { name: string; color: string } | null {
  const id = session.browser?.driver;
  if (!id) return null;
  const p = id === me() ? session.you : session.peers.get(id);
  return p ? { name: p.name, color: p.color } : null;
}
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

// ---------------------------------------------------------------- the window: where it is, per viewer

interface Geo { x: number; y: number; w: number; h: number }
const GEO_KEY = 'bb-browse-window';
const MIN_W = 320, MIN_H = 240;
let open = false;
let full = false;
let geo = loadGeo();

function loadGeo(): Geo {
  try {
    const g = JSON.parse(localStorage.getItem(GEO_KEY) ?? 'null') as Geo | null;
    if (g && [g.x, g.y, g.w, g.h].every(Number.isFinite)) return g;
  } catch { /* ignore */ }
  const w = Math.min(980, innerWidth - 24), h = Math.min(660, innerHeight - 150);
  return { x: (innerWidth - w) / 2, y: Math.max(12, Math.min(68, innerHeight - h - 12)), w, h };
}
const saveGeo = () => { try { localStorage.setItem(GEO_KEY, JSON.stringify(geo)); } catch { /* ignore */ } };

function clampGeo() {
  geo.w = Math.round(Math.max(Math.min(MIN_W, innerWidth), Math.min(geo.w, innerWidth)));
  geo.h = Math.round(Math.max(Math.min(MIN_H, innerHeight), Math.min(geo.h, innerHeight)));
  // Never let the bar leave the screen: it is the only way to drag the window back.
  geo.x = Math.round(Math.max(80 - geo.w, Math.min(geo.x, innerWidth - 80)));
  geo.y = Math.round(Math.max(0, Math.min(geo.y, innerHeight - 44)));
}

/** A watcher's window takes the shape of the driver's page, so the page fills it without bars. */
function fitToDriver() {
  const s = session.browser;
  if (!s || amDriver() || full) return;
  // What the window adds around the page: its border, and the bar on top.
  const cw = el.offsetWidth - stage.clientWidth, ch = el.offsetHeight - stage.clientHeight;
  const maxH = innerHeight - 24;
  let w = Math.min(geo.w, innerWidth - 16) - cw;
  let h = (w * s.h) / s.w;
  if (h + ch > maxH) { h = maxH - ch; w = (h * s.w) / s.h; }
  geo.w = w + cw;
  geo.h = h + ch;
}

let sizeTimer = 0;
function layout() {
  if (!open) return;
  el.classList.toggle('full', full);
  if (full) el.style.cssText = '';
  else {
    clampGeo();
    el.style.cssText = `left:${geo.x}px;top:${geo.y}px;width:${geo.w}px;height:${geo.h}px`;
  }
  const s = session.browser;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!s || amDriver()) {
    // My page is the real size; everyone else scales to it.
    page.style.cssText = '';
    clearTimeout(sizeTimer);
    if (s && sw && sh && (sw !== s.w || sh !== s.h)) sizeTimer = window.setTimeout(() => { if (amDriver()) browserDo({ a: 'size', w: sw, h: sh }); }, 120);
  } else {
    const k = Math.min(sw / s.w, sh / s.h) || 1;
    page.style.cssText = `width:${s.w}px;height:${s.h}px;transform:translate(${(sw - s.w * k) / 2}px,${(sh - s.h * k) / 2}px) scale(${k})`;
  }
}

function show() {
  if (open) return;
  open = true;
  el.hidden = false;
  layout();
}
function hide() {
  if (!open) return;
  open = false;
  el.hidden = true;
  full = false;
  unload();
}

// ---------------------------------------------------------------- the page

/** The newest page, and the one before it, which stays on screen until the new one has something to show. */
let frame: HTMLIFrameElement | null = null;
let stale: HTMLIFrameElement | null = null;
/** which load is in `frame` */
let loaded = '';
let lastScroll: BrowserState['scroll'];
let pageTitle = '';
let revealTimer = 0;
const loadId = (s: BrowserState) => `${s.key}|${s.n}`;

function reveal() {
  clearTimeout(revealTimer);
  stale?.remove();
  stale = null;
}
function unload() {
  reveal();
  frame?.remove();
  frame = null;
  loaded = '';
  pageTitle = '';
  loadingBar.hidden = true;
  note(null);
}

function load(s: BrowserState) {
  if (!session.boardId) return;
  loaded = loadId(s);
  stale?.remove();
  stale = frame;
  const f = document.createElement('iframe');
  f.className = 'bw-frame';
  // No same-origin: the page gets no access to Brainboard, and can't navigate or pop out of its frame.
  f.setAttribute('sandbox', 'allow-scripts allow-forms');
  f.referrerPolicy = 'no-referrer';
  f.title = 'Web page';
  f.src = `/api/browse?${new URLSearchParams({ b: session.boardId, k: s.key, n: String(s.n), u: s.url })}`;
  f.addEventListener('load', () => {
    if (f !== frame) return;
    reveal();
    loadingBar.hidden = true;
    // Every page we serve says hello as it starts. Silence means the frame went somewhere on its own.
    window.setTimeout(() => {
      if (f === frame && f.dataset.fresh !== '1') strayed(f);
      delete f.dataset.fresh;
    }, 400);
  });
  page.prepend(f);
  frame = f;
  pageTitle = '';
  loadingBar.hidden = false;
  note(null);
  clearTimeout(revealTimer);
  revealTimer = window.setTimeout(reveal, 6000);
}

function strayed(f: HTMLIFrameElement) {
  delete f.dataset.hello;
  if (amDriver()) note('This page opened outside the shared browser, so nobody else can see it.', 'Go back', () => browserDo({ a: 'reload' }));
  else note('This page wandered off on your side.', 'Reload', () => { loaded = ''; sync(); });
}

function note(text: string | null, action = '', run?: () => void) {
  noteEl.hidden = !text;
  noteEl.querySelector('span')!.textContent = text ?? '';
  const b = noteEl.querySelector('button')!;
  b.textContent = action;
  b.hidden = !action;
  b.onclick = run ? () => { note(null); run(); } : null;
}

const tell = (f: HTMLIFrameElement, m: Record<string, unknown>) => f.contentWindow?.postMessage({ bb: 1, ...m }, '*');
/** Tell the page whether to report (I'm driving) or to mirror the driver. */
function sendRole() {
  if (!frame || frame.dataset.hello !== '1') return;
  tell(frame, { t: 'role', drive: amDriver(), who: driver(), scroll: amDriver() ? undefined : lastScroll });
}

// Everything a page says is treated as untrusted: it can ask to go to an address or report activity, nothing else.
window.addEventListener('message', (ev) => {
  const f = frame;
  const s = session.browser;
  const m = ev.data as { bb?: unknown; t?: unknown; url?: unknown; title?: unknown; e?: unknown } | null;
  if (!f || !s || ev.source !== f.contentWindow || !m || m.bb !== 1 || loaded !== loadId(s)) return;
  const url = typeof m.url === 'string' && m.url.length <= 2000 && !m.url.startsWith(`${location.origin}/api/`) ? m.url : null;
  switch (m.t) {
    case 'hello':
      f.dataset.hello = f.dataset.fresh = '1';
      sendRole();
      if (amDriver() && url && url !== s.url) browserDo({ a: 'loc', url, n: s.n });
      return;
    case 'ready': reveal(); return;
    case 'title': pageTitle = typeof m.title === 'string' ? m.title.slice(0, 200) : ''; render(); return;
    case 'nav': if (amDriver() && url) browserDo({ a: 'nav', q: url }); return;
    case 'loc': if (amDriver() && url) browserDo({ a: 'loc', url, n: s.n }); return;
    case 'ev': {
      const e = amDriver() ? cleanBrowserEvent(m.e) : null;
      if (!e) return;
      if (e.k === 'scroll') lastScroll = e;
      sendBrowserEvent(s.n, e);
      return;
    }
    case 'note': if (amDriver()) toast('This page tried to send a form the shared browser can’t submit'); return;
  }
});

// ---------------------------------------------------------------- controls

function render() {
  const s = session.browser;
  const driving = amDriver();
  const d = driver();
  const edit = canEdit();
  document.getElementById('browse-btn')?.classList.toggle('on', !!s);

  pill.hidden = !(s && !open);
  if (!pill.hidden) pill.innerHTML = `${icon('globe', 16)}<span></span><b>Watch</b>`;
  if (!pill.hidden) pill.querySelector('span')!.textContent = `${d ? `${d.name} is browsing` : 'Browser open'} · ${hostOf(s!.url)}`;
  if (!open) return;

  start.hidden = !!s;
  shield.hidden = !s || driving;
  btn('back').disabled = !driving || !s!.back;
  btn('fwd').disabled = !driving || !s!.fwd;
  btn('reload').disabled = !driving;
  if (document.activeElement !== address) address.value = s?.url ?? '';
  address.readOnly = (!!s && !driving) || !edit;
  address.title = pageTitle;

  who.hidden = !s || driving;
  if (!who.hidden) {
    who.innerHTML = d ? '<i></i><span></span>' : '<span></span>';
    who.querySelector('span')!.textContent = d ? `${d.name} is driving` : 'Nobody is driving';
    if (d) who.querySelector<HTMLElement>('i')!.style.setProperty('--c', d.color);
  }
  btn('take').hidden = !s || driving || !edit;

  const fullBtn = btn('full');
  fullBtn.innerHTML = icon(full ? 'shrink' : 'fit', 17);
  fullBtn.dataset.tip = full ? 'Exit full screen · Esc' : 'Full screen · only for you';
  fullBtn.setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen');
  const closeBtn = btn('close');
  const ends = !!s && (driving || (edit && !s.driver));
  closeBtn.innerHTML = icon('close', 17);
  closeBtn.dataset.tip = !s ? 'Close' : ends ? 'Close for everyone' : 'Hide · only for you';
  closeBtn.setAttribute('aria-label', closeBtn.dataset.tip);
}

async function go(text: string) {
  const query = text.trim();
  if (!query) return;
  if (!canEdit()) return toast('Only people who can edit can browse here');
  if (!(await ensureBoard())) return toast('Couldn’t reach the server');
  if (!(await ensureScreenName('browse'))) return;
  if (session.browser && !amDriver()) return toast('Take control to browse yourself');
  browserDo({ a: 'nav', q: query, w: stage.clientWidth, h: stage.clientHeight });
}

/** Open the browser (the toolbar button and `:browse`). With text, go straight to that address or search. */
export async function openBrowser(text = '') {
  if (!account.browser) return toast('The shared browser is switched off on this server');
  if (!session.browser && !canEdit()) return toast('Only people who can edit can open the browser');
  show();
  sync();
  if (text.trim()) await go(text);
  else if (!session.browser || amDriver()) { address.focus(); address.select(); }
}

function close() {
  const s = session.browser;
  if (s && (amDriver() || (canEdit() && !s.driver))) {
    closedByMe = true;
    return browserDo({ a: 'close' });
  }
  // Someone else's page: put it away just for me. The pill brings it back.
  hide();
  render();
}

function setFull(on: boolean) {
  full = on;
  layout();
  render();
}

// ---------------------------------------------------------------- keeping up with the board

let prev: BrowserState | null = null;
let closedByMe = false;

function sync() {
  const s = session.browser;
  const was = prev;
  prev = s ? { ...s } : null;
  if (!s) {
    if (was) {
      lastScroll = undefined;
      if (open && !closedByMe) toast('The browser was closed');
      closedByMe = false;
      hide();
    }
    render();
    return;
  }
  const fresh = !was || was.key !== s.key;
  if (fresh) {
    lastScroll = s.scroll;
    if (!amDriver()) {
      if (!open) toast(`${driver()?.name ?? 'Someone'} opened a browser. You’re following along`);
      show();
      fitToDriver();
    }
    show();
  } else if (!amDriver() && (was.w !== s.w || was.h !== s.h)) fitToDriver();
  if (open && loaded !== loadId(s)) {
    lastScroll = s.scroll;
    load(s);
  }
  if (!fresh && was.driver !== s.driver) {
    toast(amDriver() ? 'You’re driving the browser now' : s.driver ? `${driver()?.name ?? 'Someone'} is driving the browser now` : 'Nobody is driving the browser. Take control to carry on');
    if (!amDriver() && open) fitToDriver();
  }
  layout();
  render();
  sendRole();
}

// ---------------------------------------------------------------- moving and resizing (only ever your own view)

function dragging(e: PointerEvent, handle: HTMLElement, move: (dx: number, dy: number, from: Geo) => void) {
  if (full || e.button !== 0) return;
  e.preventDefault();
  const from = { ...geo }, x0 = e.clientX, y0 = e.clientY;
  handle.setPointerCapture(e.pointerId);
  el.classList.add('moving'); // the page must not swallow the pointer on its way past
  const onMove = (m: PointerEvent) => { move(m.clientX - x0, m.clientY - y0, from); layout(); };
  const end = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    el.classList.remove('moving');
    saveGeo();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

export function initBrowse() {
  document.body.append(el, pill);
  const launch = document.getElementById('browse-btn');
  launch?.insertAdjacentHTML('afterbegin', icon('globe', 18));
  if (launch) launch.hidden = !account.browser;
  events.addEventListener('account', () => { if (launch) launch.hidden = !account.browser; });
  launch?.addEventListener('click', () => {
    if (open && !session.browser) hide();
    else void openBrowser();
  });
  pill.addEventListener('click', () => void openBrowser());

  bar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-bw]');
    switch (b?.dataset.bw) {
      case 'back': case 'fwd': case 'reload': case 'take': browserDo({ a: b!.dataset.bw as 'back' | 'fwd' | 'reload' | 'take' }); break;
      case 'full': setFull(!full); break;
      case 'close': close(); break;
    }
  });
  q<HTMLFormElement>('.bw-address').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = address.value;
    address.blur();
    void go(text);
  });
  address.addEventListener('focus', () => { if (!address.readOnly) address.select(); });
  address.addEventListener('blur', render);
  address.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    address.blur();
  });
  shield.addEventListener('click', () => {
    const d = driver();
    toast(d ? `${d.name} is driving${canEdit() ? '. Take control to browse yourself' : ''}` : 'Nobody is driving the browser');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && full && !e.defaultPrevented) setFull(false);
  });

  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button, form')) return;
    dragging(e, bar, (dx, dy, from) => { geo.x = from.x + dx; geo.y = from.y + dy; });
  });
  bar.addEventListener('dblclick', (e) => { if (!(e.target as Element).closest('button, form')) setFull(!full); });
  for (const grip of el.querySelectorAll<HTMLElement>('.bw-grip')) {
    const g = grip.dataset.grip!;
    grip.addEventListener('pointerdown', (e) => dragging(e, grip, (dx, dy, from) => {
      if (g.includes('e')) geo.w = Math.max(MIN_W, from.w + dx);
      if (g.includes('s')) geo.h = Math.max(MIN_H, from.h + dy);
      if (g.includes('w')) {
        geo.w = Math.max(MIN_W, from.w - dx);
        geo.x = from.x + from.w - geo.w;
      }
    }));
  }
  new ResizeObserver(layout).observe(stage);
  window.addEventListener('resize', layout);

  events.addEventListener('browser', sync);
  events.addEventListener('peers', () => { render(); sendRole(); });
  events.addEventListener('role', render);
  events.addEventListener('bev', (ev) => {
    const { n, e } = (ev as CustomEvent<{ n: number; e: BrowserEvent }>).detail;
    const s = session.browser;
    if (!s || n !== s.n) return;
    if (e.k === 'scroll') lastScroll = e;
    if (!amDriver() && frame && frame.dataset.hello === '1' && loaded === loadId(s)) tell(frame, { t: 'ev', e });
  });
}
