// Media: every screenshot you take lands here. Browse them, rename them, put one on the board, copy it,
// or save it anywhere: "Save as…" asks where (Chrome, Edge, Opera); other browsers save to Downloads.
import { session, canEdit } from './net';
import { addImages, viewCenter } from './actions';
import { icon } from './icons';
import { toast } from './ui';
import { keyLabel } from './keys';

export type Backdrop = 'none' | 'aurora' | 'sunset' | 'ocean' | 'mist' | 'night';
export interface MediaItem {
  id: string;
  kind: 'screenshot';
  name: string;
  board: { id: string; name: string } | null;
  w: number;
  h: number;
  bytes: number;
  backdrop: Backdrop;
  theme: 'light' | 'dark';
  created: string;
}

export const BACKDROP_NAMES: Record<Backdrop, string> = {
  none: 'Clean', aurora: 'Aurora', sunset: 'Sunset', ocean: 'Ocean', mist: 'Mist', night: 'Night',
};

export const mediaUrl = (id: string, o: { thumb?: boolean; download?: boolean } = {}) =>
  `/api/media/${encodeURIComponent(id)}.png${o.thumb ? '?thumb' : o.download ? '?download' : ''}`;

/** Events: "added" (a new shot) so open galleries and the camera roll refresh. */
export const mediaEvents = new EventTarget();
let cache: MediaItem[] | null = null;

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session.invite ? { 'x-invite': session.invite } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function listMedia(): Promise<MediaItem[]> {
  cache = await req<MediaItem[]>('GET', '/api/media');
  return cache;
}
export const latestMedia = () => cache?.[0] ?? null;

export async function takeScreenshot(body: {
  frame: { x: number; y: number; w: number; h: number }; scale: number; theme: 'light' | 'dark'; grid: boolean; zoom: number; backdrop: Backdrop; name: string;
}): Promise<MediaItem> {
  const item = await req<MediaItem>('POST', `/api/boards/${encodeURIComponent(session.boardId!)}/screenshot`, body);
  cache = [item, ...(cache ?? []).filter((i) => i.id !== item.id)];
  mediaEvents.dispatchEvent(new CustomEvent('added', { detail: item }));
  return item;
}

// ---------------------------------------------------------------- actions on one item

const fileName = (it: MediaItem) => `${it.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Screenshot'}.png`;
const fetchBlob = async (it: MediaItem) => {
  const res = await fetch(mediaUrl(it.id));
  if (!res.ok) throw new Error('Could not load the image');
  return res.blob();
};

type Picker = (o: { suggestedName: string; startIn?: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
export const canChooseFolder = !!picker;

/** Ask where to save it (desktop, anywhere) when the browser can; otherwise it goes to Downloads. */
export async function saveMedia(it: MediaItem): Promise<boolean> {
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({ suggestedName: fileName(it), startIn: 'desktop', types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      return download(it);
    }
    try {
      const w = await handle.createWritable();
      await w.write(await fetchBlob(it));
      await w.close();
      toast(`Saved ${handle.name}`);
      return true;
    } catch {
      toast('Couldn’t save the file');
      return false;
    }
  }
  return download(it);
}

function download(it: MediaItem) {
  const a = document.createElement('a');
  a.href = mediaUrl(it.id, { download: true });
  a.download = fileName(it);
  document.body.append(a);
  a.click();
  a.remove();
  toast('Saved to your Downloads folder');
  return true;
}

export async function copyMedia(it: MediaItem) {
  try {
    // A promise keeps Safari's user-gesture window open while the image loads.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': fetchBlob(it) })]);
    toast('Image copied');
  } catch {
    toast('Your browser wouldn’t copy the image. Try Save instead');
  }
}

export async function placeMedia(it: MediaItem) {
  if (!canEdit() || (!session.boardId && !session.draft)) return toast('You can only view this board');
  try {
    const file = new File([await fetchBlob(it)], fileName(it), { type: 'image/png' });
    await addImages([file], viewCenter());
  } catch {
    toast('Couldn’t place the image');
  }
}

// ---------------------------------------------------------------- the gallery

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dims = (it: MediaItem) => `${it.w.toLocaleString()} × ${it.h.toLocaleString()}`;
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function group(iso: string) {
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  return d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

let sheet: HTMLDivElement | null = null;

/** Open the Media gallery, optionally straight onto one shot. */
export function openMedia(focus?: string, onNew?: () => void) {
  if (sheet) { if (focus) sheet.dispatchEvent(new CustomEvent('focus-item', { detail: focus })); return; }
  let items: MediaItem[] = cache ?? [];
  let scope: 'all' | 'board' = 'all';
  let current: string | null = focus ?? null;
  let deleteArmed = 0;

  const el = document.createElement('div');
  sheet = el;
  el.className = 'auth-backdrop media-backdrop';
  el.innerHTML = `<div class="auth-card media-card" role="dialog" aria-modal="true" aria-labelledby="media-title">
    <button class="auth-x" data-close aria-label="Close">${icon('close', 16)}</button>
    <div class="media-head">
      <div>
        <div class="auth-eyebrow">Media</div>
        <h2 id="media-title">Screenshots <span class="media-count"></span></h2>
      </div>
      <div class="media-tools">
        <div class="xseg media-scope" role="radiogroup" aria-label="Show">
          <button role="radio" data-scope="all">All</button><button role="radio" data-scope="board">This board</button>
        </div>
        <button class="media-new" data-new>${icon('camera', 17)}<span>New screenshot</span>${keyLabel('<kbd>⇧⌘S</kbd>')}</button>
      </div>
    </div>
    <div class="media-grid" aria-live="polite"></div>
    <div class="media-detail" hidden></div>
  </div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const card = el.querySelector<HTMLElement>('.media-card')!;
  const grid = el.querySelector<HTMLElement>('.media-grid')!;
  const detail = el.querySelector<HTMLElement>('.media-detail')!;
  if (!session.boardId) el.querySelector<HTMLElement>('.media-scope')!.hidden = true;
  if (!onNew) el.querySelector<HTMLElement>('[data-new]')!.hidden = true;

  const shown = () => (scope === 'board' && session.boardId ? items.filter((i) => i.board?.id === session.boardId) : items);

  function renderGrid() {
    el.querySelectorAll<HTMLElement>('[data-scope]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scope === scope)));
    const list = shown();
    el.querySelector('.media-count')!.textContent = items.length ? String(list.length) : '';
    if (!list.length) {
      grid.innerHTML = `<div class="media-empty">
        <div class="media-empty-art" aria-hidden="true"><i></i><i></i><i></i>${icon('camera', 30)}</div>
        <b>${items.length ? 'No screenshots of this board yet' : 'No screenshots yet'}</b>
        <span>Frame the whole screen, an area you drag, your selection or a saved view. Every shot is kept here.</span>
        ${onNew ? `<button class="auth-passkey media-empty-go" data-new>${icon('camera', 18)}<span>Take a screenshot</span></button>` : ''}
      </div>`;
      return;
    }
    let html = '', last = '';
    for (const it of list) {
      const g = group(it.created);
      if (g !== last) { html += `${last ? '</div>' : ''}<h3 class="media-group">${esc(g)}</h3><div class="media-tiles">`; last = g; }
      html += `<button class="mtile" data-id="${it.id}" style="--ar:${it.w}/${it.h}" aria-label="${esc(it.name)}">
        <span class="mtile-img"><img loading="lazy" decoding="async" alt="" src="${mediaUrl(it.id, { thumb: true })}"></span>
        <span class="mtile-meta"><b>${esc(it.name)}</b><em>${it.board && scope === 'all' ? `${esc(it.board.name)} · ` : ''}${time(it.created)}</em></span>
      </button>`;
    }
    grid.innerHTML = html + '</div>';
    for (const img of grid.querySelectorAll('img')) img.addEventListener('load', () => img.classList.add('in'), { once: true });
  }

  function renderDetail() {
    const list = shown();
    const i = list.findIndex((x) => x.id === current);
    const it = list[i] ?? items.find((x) => x.id === current);
    card.classList.toggle('detail', !!it);
    detail.hidden = !it;
    grid.hidden = !!it;
    if (!it) { current = null; return; }
    const prev = list[i - 1], next = list[i + 1];
    detail.innerHTML = `
      <div class="md-stage ${it.backdrop === 'none' ? 'plain' : ''}">
        <img alt="${esc(it.name)}" src="${mediaUrl(it.id)}">
        <button class="md-nav prev" data-go="${prev?.id ?? ''}" ${prev ? '' : 'disabled'} aria-label="Previous">${icon('chevronLeft', 20)}</button>
        <button class="md-nav next" data-go="${next?.id ?? ''}" ${next ? '' : 'disabled'} aria-label="Next">${icon('chevronRight', 20)}</button>
      </div>
      <div class="md-side">
        <button class="md-back" data-back>${icon('chevronLeft', 16)}<span>All screenshots</span></button>
        <label class="auth-field"><span>Name</span><span class="xname"><input name="name" spellcheck="false" maxlength="100"><i>.png</i></span></label>
        <dl class="md-facts">
          <dt>Size</dt><dd>${dims(it)} px · ${size(it.bytes)}</dd>
          <dt>Look</dt><dd><i class="md-swatch" data-look="${it.backdrop}"></i>${BACKDROP_NAMES[it.backdrop]} · ${it.theme === 'dark' ? 'Dark' : 'Light'}</dd>
          ${it.board ? `<dt>Board</dt><dd>${esc(it.board.name)}</dd>` : ''}
          <dt>Taken</dt><dd>${when(it.created)}</dd>
        </dl>
        <button class="auth-passkey md-save" data-act="save">${icon('download', 18)}<span>${canChooseFolder ? 'Save as…' : 'Download'}</span></button>
        <p class="xfine">${canChooseFolder ? 'Choose any folder, like your Desktop.' : 'Saves to your Downloads folder. To pick a folder each time, turn on “Ask where to save each file” in your browser’s settings.'}</p>
        <div class="md-row">
          <button class="auth-submit" data-act="copy">${icon('copy', 16)}<span>Copy</span></button>
          ${canEdit() && (session.boardId || session.draft) ? `<button class="auth-submit" data-act="place">${icon('place', 16)}<span>Put on board</span></button>` : ''}
        </div>
        <button class="md-delete" data-act="delete">${icon('trash', 15)}<span>Delete</span></button>
      </div>`;
    const input = detail.querySelector<HTMLInputElement>('input[name="name"]')!;
    input.value = it.name;
    const commit = async () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name || name === it.name) { input.value = it.name; return; }
      try {
        Object.assign(it, await req<MediaItem>('PATCH', `/api/media/${it.id}`, { name }));
        input.value = it.name;
      } catch { toast('Couldn’t rename it'); input.value = it.name; }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); input.value = it.name; input.blur(); }
    });
    input.addEventListener('blur', () => void commit());
    detail.querySelector<HTMLElement>('.md-save')!.focus({ preventScroll: true });
  }

  const show = () => (current ? renderDetail() : (card.classList.remove('detail'), detail.hidden = true, grid.hidden = false, renderGrid()));

  async function refresh() {
    try { items = await listMedia(); } catch { /* keep what we had */ }
    if (sheet === el) show();
  }

  const close = () => {
    if (sheet !== el) return;
    sheet = null;
    el.classList.remove('in');
    mediaEvents.removeEventListener('added', onAdded);
    window.removeEventListener('keydown', onKey, true);
    setTimeout(() => el.remove(), 200);
  };
  const onAdded = () => void refresh();
  mediaEvents.addEventListener('added', onAdded);

  el.addEventListener('focus-item', (e) => { current = String((e as CustomEvent).detail); void refresh(); });
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  el.addEventListener('click', async (e) => {
    const t = e.target as Element;
    if (t.closest('[data-close]')) return close();
    if (t.closest('[data-new]')) { close(); onNew?.(); return; }
    const scopeBtn = t.closest<HTMLElement>('[data-scope]');
    if (scopeBtn) { scope = scopeBtn.dataset.scope as 'all' | 'board'; return renderGrid(); }
    const tile = t.closest<HTMLElement>('.mtile');
    if (tile) { current = tile.dataset.id!; return renderDetail(); }
    if (t.closest('[data-back]')) { current = null; return show(); }
    const go = t.closest<HTMLElement>('[data-go]');
    if (go?.dataset.go) { current = go.dataset.go; return renderDetail(); }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const it = items.find((x) => x.id === current);
    if (!act || !it) return;
    if (act === 'save') await saveMedia(it);
    else if (act === 'copy') await copyMedia(it);
    else if (act === 'place') { close(); await placeMedia(it); }
    else if (act === 'delete') {
      const b = detail.querySelector<HTMLElement>('.md-delete span')!;
      if (Date.now() - deleteArmed > 3500) {
        deleteArmed = Date.now();
        b.textContent = 'Click again to delete';
        detail.querySelector('.md-delete')!.classList.add('armed');
        setTimeout(() => { if (b.isConnected) { b.textContent = 'Delete'; detail.querySelector('.md-delete')?.classList.remove('armed'); } }, 3500);
        return;
      }
      deleteArmed = 0;
      const list = shown();
      const i = list.findIndex((x) => x.id === it.id);
      try {
        await req('DELETE', `/api/media/${it.id}`);
        items = items.filter((x) => x.id !== it.id);
        cache = items;
        current = (list[i + 1] ?? list[i - 1])?.id ?? null;
        toast('Screenshot moved to the trash');
        show();
      } catch { toast('Couldn’t delete it'); }
    }
  });

  const onKey = (e: KeyboardEvent) => {
    if (sheet !== el) return;
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (current) { current = null; show(); } else close();
      return;
    }
    if (typing) return;
    if (current && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const list = shown();
      const i = list.findIndex((x) => x.id === current);
      const to = list[i + (e.key === 'ArrowRight' ? 1 : -1)];
      e.preventDefault();
      e.stopImmediatePropagation();
      if (to) { current = to.id; renderDetail(); }
      return;
    }
    // The board underneath shouldn't react to keys while the gallery is open.
    if (!e.metaKey && !e.ctrlKey) e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKey, true);

  show();
  void refresh();
}

export const mediaOpen = () => !!sheet;
