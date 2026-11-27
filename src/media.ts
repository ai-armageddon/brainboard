// Media holds the screenshots and recordings you choose to keep. Browse them, rename them, put a shot on the board,
// copy it, or save it anywhere: "Save as…" asks where (Chrome, Edge, Opera); other browsers save to Downloads.
import { session, canEdit } from './net';
import { addImages, viewCenter } from './actions';
import { icon } from './icons';
import { toast } from './ui';
import { keyLabel } from './keys';
import type { Box } from './types';

export type Backdrop = 'none' | 'aurora' | 'sunset' | 'ocean' | 'mist' | 'night';
export interface MediaItem {
  id: string;
  kind: 'screenshot' | 'recording';
  /** recordings: the file type, and the length in seconds */
  ext?: 'mp4' | 'webm';
  duration?: number;
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

const isVideo = (it: MediaItem) => it.kind === 'recording';
const extOf = (it: MediaItem) => (isVideo(it) ? it.ext ?? 'webm' : 'png');
/** The item's file (a PNG, or a recording's video), or with `thumb` its small still. */
export const mediaUrl = (it: MediaItem, o: { thumb?: boolean; download?: boolean } = {}) =>
  `/api/media/${encodeURIComponent(it.id)}.${o.thumb ? 'png' : extOf(it)}${o.thumb ? '?thumb' : o.download ? '?download' : ''}`;

/** Events: "added" (a new shot or recording) so open galleries and the camera roll refresh. */
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

/** A single white exposure flash, over the area that was captured. */
export function flashCapture(frame: Box) {
  const flash = document.createElement('div');
  flash.className = 'shot-flash';
  flash.setAttribute('aria-hidden', 'true');
  flash.style.cssText = `left:${frame.x}px;top:${frame.y}px;width:${frame.w}px;height:${frame.h}px`;
  document.body.append(flash);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fade = flash.animate([{ opacity: reduced ? 0.12 : 0.45 }, { opacity: 0 }], {
    duration: reduced ? 80 : 160, easing: 'ease-out', fill: 'forwards',
  });
  fade.finished.then(() => flash.remove(), () => flash.remove());
}

export function dismissCaptureCard() {
  document.querySelectorAll<HTMLButtonElement>('.shot-card [data-act="dismiss"]').forEach(b => b.click());
}

export async function takeScreenshot(body: {
  frame: { x: number; y: number; w: number; h: number }; scale: number; theme: 'light' | 'dark'; grid: boolean; zoom: number; backdrop: Backdrop; name: string;
}): Promise<{ item: MediaItem; blob: Blob }> {
  const board = { id: session.boardId!, name: session.boardName };
  const url = `/api/boards/${encodeURIComponent(board.id)}/screenshot`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(session.invite ? { 'x-invite': session.invite } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  const blob = await res.blob();
  return { blob, item: {
    kind: 'screenshot', id: '', name: body.name, board, theme: body.theme, backdrop: body.backdrop,
    w: Number(res.headers.get('x-image-width')), h: Number(res.headers.get('x-image-height')),
    created: new Date().toISOString(), bytes: blob.size,
  } };
}

async function screenshotThumbnail(blob: Blob, item: MediaItem) {
  if (Math.max(item.w, item.h) <= 560) return null;
  const image = await createImageBitmap(blob);
  try {
    const scale = 560 / Math.max(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally { image.close(); }
}

async function keepCapture(meta: MediaItem, blob: Blob, poster: Blob | null): Promise<MediaItem> {
  const q = new URLSearchParams({
    name: meta.name, w: String(meta.w), h: String(meta.h), duration: String(Math.round((meta.duration ?? 0) * 10) / 10),
    theme: meta.theme, backdrop: meta.backdrop, ...(meta.board ? { board: meta.board.id } : {}),
  });
  const invite: Record<string, string> = session.invite ? { 'x-invite': session.invite } : {};
  const res = await fetch(`/api/media?${q}`, {
    method: 'POST', headers: { 'content-type': isVideo(meta) ? `video/${extOf(meta)}` : 'image/png', ...invite }, body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  const item = await res.json() as MediaItem;
  if (!isVideo(meta)) poster = await screenshotThumbnail(blob, meta).catch(() => null);
  if (poster) await fetch(`/api/media/${item.id}/poster`, { method: 'PUT', headers: { 'content-type': 'image/png', ...invite }, body: poster }).catch(() => {});
  cache = [item, ...(cache ?? []).filter((i) => i.id !== item.id)];
  mediaEvents.dispatchEvent(new CustomEvent('added', { detail: item }));
  return item;
}

/** Both capture cards keep their local file available during an upload and after a failed save. */
export function bindCaptureSave(
  card: HTMLElement, capture: MediaItem, blob: Blob, poster: Blob | null,
  camera: (kind?: 'photo' | 'video') => void, saveByDefault: boolean, onSaved: (item: MediaItem) => void,
) {
  const button = card.querySelector<HTMLButtonElement>('[data-act="library"]')!;
  const label = button.querySelector('span')!;
  const title = card.querySelector<HTMLElement>('.shot-card-body b')!;
  let saved: MediaItem | undefined;
  let saving = false;
  let autoSaveTimer = 0;
  const keep = async () => {
    if (saving || saved) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = 0;
    saving = true;
    button.disabled = true;
    label.textContent = 'Save to Media';
    title.textContent = 'Saving to Media…';
    try {
      saved = await keepCapture(capture, blob, poster);
      label.textContent = 'Open in Media';
      title.textContent = 'Saved to Media';
      onSaved(saved);
    } catch (err) {
      title.textContent = 'Couldn’t save to Media';
      toast((err as Error).message);
    } finally {
      saving = false;
      button.disabled = false;
    }
  };
  button.disabled = false;
  button.addEventListener('click', () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = 0;
      label.textContent = 'Save to Media';
      title.textContent = isVideo(capture) ? 'Recording ready' : 'Screenshot ready';
      return;
    }
    if (!saved) { void keep(); return; }
    card.querySelector<HTMLButtonElement>('[data-act="dismiss"]')!.click();
    openMedia(saved.id, camera);
  });
  if (saveByDefault) {
    title.textContent = 'Saving to Media shortly';
    label.textContent = 'Don’t save';
    autoSaveTimer = window.setTimeout(keep, 6000);
    // Dismissing the preview accepts its default. Only the opt-out cancels the Media save.
    card.querySelector('[data-act="dismiss"]')!.addEventListener('click', () => {
      if (autoSaveTimer) void keep();
    }, { once: true });
    if (!card.isConnected) void keep();
  }
}

// ---------------------------------------------------------------- actions on one item

const fileName = (it: MediaItem) => `${it.name.replace(/[\\/:*?"<>|]+/g, '').trim() || (isVideo(it) ? 'Recording' : 'Screenshot')}.${extOf(it)}`;
const fetchBlob = async (it: MediaItem) => {
  const res = await fetch(mediaUrl(it));
  if (!res.ok) throw new Error(isVideo(it) ? 'Could not load the recording' : 'Could not load the image');
  return res.blob();
};
const fileType = (it: MediaItem) => {
  const ext = extOf(it);
  return { description: ext === 'png' ? 'PNG image' : ext === 'mp4' ? 'MP4 video' : 'WebM video', accept: { [ext === 'png' ? 'image/png' : `video/${ext}`]: [`.${ext}`] } };
};

type Picker = (o: { suggestedName: string; startIn?: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
export const canChooseFolder = !!picker;

/**
 * Ask where to save it (desktop, anywhere) when the browser can; otherwise it goes to Downloads.
 * A recording that was just made can be handed over as `have`, to save it without fetching it back.
 */
export async function saveMedia(it: MediaItem, have?: Blob): Promise<boolean> {
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({ suggestedName: fileName(it), startIn: 'desktop', types: [fileType(it)] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      return download(it, have);
    }
    try {
      const w = await handle.createWritable();
      await w.write(have ?? await fetchBlob(it));
      await w.close();
      toast(`Saved ${handle.name}`);
      return true;
    } catch {
      toast('Couldn’t save the file');
      return false;
    }
  }
  return download(it, have);
}

function download(it: MediaItem, have?: Blob) {
  const a = document.createElement('a');
  const local = have ? URL.createObjectURL(have) : '';
  a.href = local || mediaUrl(it, { download: true });
  a.download = fileName(it);
  document.body.append(a);
  a.click();
  a.remove();
  if (local) setTimeout(() => URL.revokeObjectURL(local), 60_000);
  toast('Saved to your Downloads folder');
  return true;
}

export async function copyMedia(it: MediaItem, have?: Blob) {
  if (isVideo(it)) return toast('Recordings can’t be copied. Save it instead');
  try {
    // A promise keeps Safari's user-gesture window open while the image loads.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': have ?? fetchBlob(it) })]);
    toast('Image copied');
  } catch {
    toast('Your browser wouldn’t copy the image. Try Save instead');
  }
}

export async function placeMedia(it: MediaItem) {
  if (!canEdit() || (!session.boardId && !session.draft)) return toast('You can only view this board');
  if (isVideo(it)) return toast('Recordings can’t be put on a board yet');
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
/** A recording's length: 0:07, 12:40, 1:02:03. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const p = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}
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

/** Open the Media gallery, optionally straight onto one item. `onNew` opens the camera, for a photo or a video. */
export function openMedia(focus?: string, onNew?: (kind?: 'photo' | 'video') => void) {
  if (sheet) { if (focus) sheet.dispatchEvent(new CustomEvent('focus-item', { detail: focus })); return; }
  let items: MediaItem[] = cache ?? [];
  let scope: 'all' | 'board' = 'all';
  let current: string | null = focus ?? null;
  const deleting = new Set<string>();
  let disarmTimer = 0;

  const el = document.createElement('div');
  sheet = el;
  el.className = 'auth-backdrop media-backdrop';
  el.innerHTML = `<div class="auth-card media-card" role="dialog" aria-modal="true" aria-labelledby="media-title">
    <button class="auth-x" data-close aria-label="Close">${icon('close', 16)}</button>
    <div class="media-head">
      <div>
        <div class="auth-eyebrow">Media</div>
        <h2 id="media-title">Shots &amp; recordings <span class="media-count"></span></h2>
      </div>
      <div class="media-tools">
        <div class="xseg media-scope" role="radiogroup" aria-label="Show">
          <button role="radio" data-scope="all">All</button><button role="radio" data-scope="board">This board</button>
        </div>
        <button class="media-new quiet" data-new="video"><i class="rec-dot"></i><span>Record</span>${keyLabel('<kbd>⌥R</kbd>')}</button>
        <button class="media-new" data-new="photo">${icon('camera', 17)}<span>New screenshot</span></button>
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
  if (!onNew) el.querySelectorAll<HTMLElement>('[data-new]').forEach((b) => { b.hidden = true; });

  const shown = () => (scope === 'board' && session.boardId ? items.filter((i) => i.board?.id === session.boardId) : items);

  function renderGrid() {
    el.querySelectorAll<HTMLElement>('[data-scope]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scope === scope)));
    const list = shown();
    el.querySelector('.media-count')!.textContent = items.length ? String(list.length) : '';
    if (!list.length) {
      grid.innerHTML = `<div class="media-empty">
        <div class="media-empty-art" aria-hidden="true"><i></i><i></i><i></i>${icon('camera', 30)}</div>
        <b>${items.length ? 'Nothing captured on this board yet' : 'Nothing captured yet'}</b>
        <span>Screenshots and recordings are saved here by default. Choose “Don’t save” in the preview to skip a capture.</span>
        ${onNew ? `<button class="auth-passkey media-empty-go" data-new="photo">${icon('camera', 18)}<span>Take a screenshot</span></button>` : ''}
      </div>`;
      return;
    }
    let html = '', last = '';
    for (const it of list) {
      const g = group(it.created);
      if (g !== last) { html += `${last ? '</div>' : ''}<h3 class="media-group">${esc(g)}</h3><div class="media-tiles">`; last = g; }
      html += `<button class="mtile${isVideo(it) ? ' video' : ''}" data-id="${it.id}" style="--ar:${it.w}/${it.h}" aria-label="${esc(it.name)}${isVideo(it) ? ', recording' : ''}">
        <span class="mtile-img"><img loading="lazy" decoding="async" alt="" src="${mediaUrl(it, { thumb: true })}">${isVideo(it) ? `<i class="mtile-play"></i><em class="mtile-len">${clock(it.duration ?? 0)}</em>` : ''}</span>
        <span class="mtile-meta"><b>${esc(it.name)}</b><em>${it.board && scope === 'all' ? `${esc(it.board.name)} · ` : ''}${time(it.created)}</em></span>
      </button>`;
    }
    grid.innerHTML = html + '</div>';
    for (const img of grid.querySelectorAll('img')) {
      img.addEventListener('load', () => img.classList.add('in'), { once: true });
      // A recording whose still never arrived just shows its play button.
      img.addEventListener('error', () => img.remove(), { once: true });
    }
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
        ${isVideo(it)
    ? `<video controls playsinline preload="metadata" poster="${mediaUrl(it, { thumb: true })}" src="${mediaUrl(it)}" aria-label="${esc(it.name)}"></video>`
    : `<img alt="${esc(it.name)}" src="${mediaUrl(it)}">`}
        <button class="md-nav prev" data-go="${prev?.id ?? ''}" ${prev ? '' : 'disabled'} aria-label="Previous">${icon('chevronLeft', 20)}</button>
        <button class="md-nav next" data-go="${next?.id ?? ''}" ${next ? '' : 'disabled'} aria-label="Next">${icon('chevronRight', 20)}</button>
      </div>
      <div class="md-side">
        <button class="md-back" data-back>${icon('chevronLeft', 16)}<span>All media</span></button>
        <label class="auth-field"><span>Name</span><span class="xname"><input name="name" spellcheck="false" maxlength="100"><i>.${extOf(it)}</i></span></label>
        <dl class="md-facts">
          ${isVideo(it) ? `<dt>Length</dt><dd>${clock(it.duration ?? 0)}</dd>` : ''}
          <dt>Size</dt><dd>${dims(it)} px · ${size(it.bytes)}</dd>
          <dt>Look</dt><dd><i class="md-swatch" data-look="${it.backdrop}"></i>${BACKDROP_NAMES[it.backdrop]} · ${it.theme === 'dark' ? 'Dark' : 'Light'}</dd>
          ${it.board ? `<dt>Board</dt><dd>${esc(it.board.name)}</dd>` : ''}
          <dt>${isVideo(it) ? 'Recorded' : 'Taken'}</dt><dd>${when(it.created)}</dd>
        </dl>
        <button class="auth-passkey md-save" data-act="save">${icon('download', 18)}<span>${canChooseFolder ? 'Save as…' : 'Download'}</span></button>
        <p class="xfine">${canChooseFolder ? 'Choose any folder, like your Desktop.' : 'Saves to your Downloads folder. To pick a folder each time, turn on “Ask where to save each file” in your browser’s settings.'}</p>
        ${isVideo(it) ? '' : `<div class="md-row">
          <button class="auth-submit" data-act="copy">${icon('copy', 16)}<span>Copy</span></button>
          ${canEdit() && (session.boardId || session.draft) ? `<button class="auth-submit" data-act="place">${icon('place', 16)}<span>Put on board</span></button>` : ''}
        </div>`}
        <button class="md-delete" data-act="delete" aria-label="${deleting.has(it.id) ? 'Deleting' : 'Delete'}" ${deleting.has(it.id) ? 'disabled' : ''}>
          ${icon('trash', 16)}<span class="md-delete-label" aria-hidden="true"><span class="idle">${deleting.has(it.id) ? 'Deleting…' : 'Delete'}</span><span class="confirm">Confirm delete</span></span>
        </button>
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
    clearTimeout(disarmTimer);
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
    const fresh = t.closest<HTMLElement>('[data-new]');
    if (fresh) { close(); onNew?.(fresh.dataset.new === 'video' ? 'video' : 'photo'); return; }
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
      const button = t.closest<HTMLButtonElement>('button')!;
      if (deleting.has(it.id)) return;
      clearTimeout(disarmTimer);
      if (!button.classList.contains('armed')) {
        const confirmMs = 3500;
        button.style.setProperty('--confirm-time', `${confirmMs}ms`);
        button.classList.add('armed');
        button.setAttribute('aria-label', 'Confirm delete');
        disarmTimer = window.setTimeout(() => {
          button.classList.remove('armed');
          if (!button.disabled) button.setAttribute('aria-label', 'Delete');
        }, confirmMs);
        return;
      }
      deleting.add(it.id);
      button.disabled = true;
      button.classList.remove('armed');
      button.querySelector('.idle')!.textContent = 'Deleting…';
      button.setAttribute('aria-label', 'Deleting');
      const list = shown();
      const i = list.findIndex((x) => x.id === it.id);
      try {
        await req('DELETE', `/api/media/${it.id}`);
        if (button.isConnected && current === it.id && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          await detail.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(3px)' }], { duration: 160, easing: 'ease-out' }).finished.catch(() => {});
        }
        items = items.filter((x) => x.id !== it.id);
        cache = cache?.filter((x) => x.id !== it.id) ?? null;
        const removedCurrent = current === it.id;
        if (removedCurrent) current = (list[i + 1] ?? list[i - 1])?.id ?? null;
        toast(`${isVideo(it) ? 'Recording' : 'Screenshot'} moved to the trash`);
        if (sheet === el && (removedCurrent || !current)) show();
      } catch {
        deleting.delete(it.id);
        if (sheet === el && current === it.id && !button.isConnected) renderDetail();
        button.disabled = false;
        button.querySelector('.idle')!.textContent = 'Delete';
        button.setAttribute('aria-label', 'Delete');
        toast('Couldn’t delete it');
      } finally { deleting.delete(it.id); }
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
