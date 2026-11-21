import { icon } from './icons';
import { S, canRedo, canUndo, checkpoint, redo, requestRender, undo } from './state';
import { hooks, selBounds, viewport } from './render';
import { COLORS, SHAPES, type ColorKey, type Item, type ShapeKind, type Tool } from './types';
import {
  addImages, bumpFont, canEditText, clearBoard, deleteSelection, duplicateSelection, exportBoard,
  importBoard, reorder, setColor, setShape, setTool, setZoom, startEditing, viewCenter, zoomBy, zoomToFit,
} from './actions';
import { clamp } from './geometry';
import { account, api, events, saveProfile, session, type BoardMeta } from './net';
import { openBoard, saveCamera, showBoardInUrl } from './boards';
import { paintLogos } from './brand';
import { userMovedCamera } from './collab';
import { isVimMode, setVimMode } from './vim';
import { startTour } from './tour';
import { openAuth, signOut } from './account';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ctx = $('ctxbar');
const penbar = $('penbar');
const menu = $('menu');
const shortcuts = $('shortcuts');
const hint = $('hint');
const zoomLabel = $('zoom-label');
const fileImages = $<HTMLInputElement>('file-images');
const fileBoard = $<HTMLInputElement>('file-board');

// ---------------------------------------------------------------- toasts

let toastTimer = 0;
export function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------- tools

export function updateToolUI() {
  document.querySelectorAll<HTMLElement>('#toolbar [data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === S.tool);
  });
  penbar.hidden = S.tool !== 'pen';
  if (!penbar.hidden) buildPenbar();
}

function buildPenbar() {
  const sizes = [2, 4, 8, 16];
  penbar.innerHTML =
    `<div class="swatches">${COLORS.map((c) => swatch(c, c === S.pen.color)).join('')}</div>` +
    `<span class="sep"></span>` +
    sizes.map((s) => `<button class="size ${s === S.pen.size ? 'on' : ''}" data-size="${s}" aria-label="Pen size ${s}"><i style="width:${Math.max(3, s)}px;height:${Math.max(3, s)}px"></i></button>`).join('');
}

export const openImagePicker = () => fileImages.click();

// ---------------------------------------------------------------- context bar

const swatch = (c: ColorKey, on: boolean) =>
  `<button class="sw ${on ? 'on' : ''}" data-color="${c}" style="--f:var(--f-${c});--s:var(--s-${c})" aria-label="${c}" data-tip="${c[0].toUpperCase() + c.slice(1)}"></button>`;
const btn = (act: string, ic: string, tip: string, extra = '') =>
  `<button class="cbtn ${extra}" data-act="${act}" data-tip="${tip}" aria-label="${tip}">${icon(ic, 18)}</button>`;
const SEP = '<span class="sep"></span>';

let ctxSig = '';

function buildCtx(sel: Item[]) {
  const parts: string[] = [];
  const colorable = sel.filter((i) => 'color' in i) as (Item & { color: ColorKey })[];
  if (colorable.length) {
    const cur = colorable.every((i) => i.color === colorable[0].color) ? colorable[0].color : null;
    parts.push(`<div class="swatches">${COLORS.map((c) => swatch(c, c === cur)).join('')}</div>`);
  }
  if (sel.every((i) => i.type === 'shape')) {
    const kinds = new Set(sel.map((i) => (i.type === 'shape' ? i.shape : '')));
    const names: Record<ShapeKind, string> = { ellipse: 'Bubble', pill: 'Pill', rect: 'Box', diamond: 'Decision' };
    parts.push(SHAPES.map((k) => `<button class="cbtn ${kinds.size === 1 && kinds.has(k) ? 'on' : ''}" data-shape="${k}" data-tip="${names[k]}" aria-label="${names[k]}">${icon(k, 18)}</button>`).join(''));
  }
  if (sel.some((i) => 'fs' in i)) {
    parts.push(btn('font-down', 'sizeDown', 'Smaller text') + btn('font-up', 'sizeUp', 'Larger text'));
  }
  const tail: string[] = [];
  if (sel.length === 1 && canEditText(sel[0])) tail.push(btn('edit', 'type', sel[0].type === 'edge' ? 'Label · Enter' : 'Edit text · Enter'));
  if (sel.some((i) => i.type !== 'edge')) {
    tail.push(btn('duplicate', 'copy', 'Duplicate · ⌘D'), btn('front', 'front', 'Bring to front · ]'), btn('back', 'back', 'Send to back · ['));
  }
  tail.push(btn('delete', 'trash', 'Delete · ⌫', 'danger'));
  parts.push(tail.join(''));
  ctx.innerHTML = parts.join(SEP);
}

function updateCtxBar() {
  const sel = S.items.filter((i) => S.selected.has(i.id));
  if (!sel.length || !selBounds) {
    ctx.classList.remove('show');
    ctxSig = '';
    return;
  }
  const sig = sel.map((i) => `${i.id}:${'color' in i ? i.color : ''}:${i.type === 'shape' ? i.shape : ''}`).join('|');
  if (sig !== ctxSig) {
    ctxSig = sig;
    buildCtx(sel);
  }
  ctx.classList.add('show');
  positionCtxBar();
}

function positionCtxBar() {
  if (!ctx.classList.contains('show') || !selBounds) return;
  const { x, y, z } = S.cam;
  const b = selBounds;
  const L = b.x * z + x, T = b.y * z + y, R = (b.x + b.w) * z + x, B = (b.y + b.h) * z + y;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  const left = clamp((L + R) / 2 - w / 2, 12, Math.max(12, innerWidth - w - 12));
  let top = T - h - 18;
  if (top < 64) top = B + 18;
  top = clamp(top, 64, Math.max(64, innerHeight - h - 84));
  ctx.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
}

// ---------------------------------------------------------------- menu, theme, shortcuts

export type Theme = 'auto' | 'light' | 'dark';
export function getTheme(): Theme {
  try { return (localStorage.getItem('bb-theme') as Theme) || 'auto'; } catch { return 'auto'; }
}
export function applyTheme(t: Theme) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  $('theme-label').textContent = t[0].toUpperCase() + t.slice(1);
  try { localStorage.setItem('bb-theme', t); } catch { /* ignore */ }
}

export function closePopovers() {
  menu.hidden = true;
  $('menu-btn').classList.remove('open');
}

export function toggleShortcuts(force?: boolean) {
  shortcuts.hidden = force === undefined ? !shortcuts.hidden : !force;
}

// ---------------------------------------------------------------- build

export function buildUI() {
  // Ctrl-drag pans on Windows and Linux; ⌘-drag on Mac.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    document.querySelectorAll('.pan-key').forEach((k) => { k.textContent = 'Ctrl'; });
    document.querySelectorAll<HTMLElement>('[data-tip*="⌘-drag"]').forEach((b) => { b.dataset.tip = b.dataset.tip!.replace('⌘-drag', 'Ctrl-drag'); });
  }
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon!));
  });

  $('toolbar').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool as Tool);
    else if (b.id === 'img-btn') openImagePicker();
  });

  penbar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.color) S.pen.color = b.dataset.color as ColorKey;
    if (b.dataset.size) S.pen.size = Number(b.dataset.size);
    buildPenbar();
  });

  ctx.addEventListener('pointerdown', (e) => e.preventDefault()); // keep text focus while styling
  ctx.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.color) return setColor(b.dataset.color as ColorKey);
    if (b.dataset.shape) return setShape(b.dataset.shape as ShapeKind);
    switch (b.dataset.act) {
      case 'font-down': return bumpFont(1 / 1.2);
      case 'font-up': return bumpFont(1.2);
      case 'edit': return startEditing([...S.selected][0]);
      case 'duplicate': checkpoint(); return duplicateSelection(16 / S.cam.z);
      case 'front': return reorder(true);
      case 'back': return reorder(false);
      case 'delete': return deleteSelection();
    }
  });

  $('undo-btn').addEventListener('click', undo);
  $('redo-btn').addEventListener('click', redo);
  $('zoom-in').addEventListener('click', () => { if (userMovedCamera()) zoomBy(1.25); });
  $('zoom-out').addEventListener('click', () => { if (userMovedCamera()) zoomBy(0.8); });
  $('zoom-fit').addEventListener('click', () => { if (userMovedCamera()) zoomToFit(); });
  zoomLabel.addEventListener('click', () => { if (userMovedCamera()) setZoom(1); });

  $('menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('menu-btn').classList.toggle('open', !menu.hidden);
    if (!menu.hidden && !session.invite) void refreshBoardList();
  });
  menu.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    const act = b.dataset.action;
    if (act !== 'theme' && act !== 'vim') closePopovers();
    switch (act) {
      case 'fit': if (userMovedCamera()) zoomToFit(); break;
      case 'export': void exportBoard(); break;
      case 'import': fileBoard.click(); break;
      case 'theme': {
        const order: Theme[] = ['auto', 'light', 'dark'];
        applyTheme(order[(order.indexOf(getTheme()) + 1) % 3]);
        break;
      }
      case 'shortcuts': toggleShortcuts(true); break;
      case 'vim': setVimMode(!isVimMode()); break;
      case 'tour': startTour(); break;
      case 'account': if (account.user) void signOut(); else openAuth('signin'); break;
      case 'clear': clearBoard(); break;
      case 'new-board': void newBoard(); break;
      case 'rename': startRename(); break;
      case 'delete-board': void deleteCurrentBoard(); break;
    }
  });
  window.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!menu.hidden && !t.closest('#menu, #menu-btn')) closePopovers();
  });

  shortcuts.addEventListener('click', (e) => {
    if (e.target === shortcuts || (e.target as Element).closest('.close')) toggleShortcuts(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !shortcuts.hidden) toggleShortcuts(false);
  });

  fileImages.addEventListener('change', () => {
    const files = [...(fileImages.files ?? [])];
    fileImages.value = '';
    void addImages(files, viewCenter());
  });
  fileBoard.addEventListener('change', () => {
    const f = fileBoard.files?.[0];
    fileBoard.value = '';
    if (f) void importBoard(f);
  });

  applyTheme(getTheme());

  hooks.afterRender = () => {
    updateCtxBar();
    hint.classList.toggle('show', S.items.length === 0);
    ($('undo-btn') as HTMLButtonElement).disabled = !canUndo();
    ($('redo-btn') as HTMLButtonElement).disabled = !canRedo();
  };
  hooks.afterCamera = () => {
    saveCamera();
    positionCtxBar();
    zoomLabel.textContent = `${Math.round(S.cam.z * 100)}%`;
  };
  viewport.dataset.tool = S.tool;

  $('board-list').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-board]');
    if (!b) return;
    closePopovers();
    openBoard(b.dataset.board!);
  });
  $('board-name').addEventListener('dblclick', (e) => { e.stopPropagation(); if (!session.invite) startRename(); });
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyN' && !session.invite && !S.editing) { e.preventDefault(); void newBoard(); }
  });

  const syncTitle = () => {
    const name = session.boardName || 'brainboard';
    if (!renaming) $('board-name').textContent = name;
    document.title = session.boardName ? `${session.boardName} · Brainboard` : 'Brainboard';
  };
  const syncStatus = () => {
    const dot = $('status-dot');
    dot.dataset.status = session.status;
    dot.title = session.status === 'live' ? 'Live · changes save automatically' : session.status === 'connecting' ? 'Connecting…' : 'Offline · reconnecting';
  };
  events.addEventListener('welcome', syncTitle);
  events.addEventListener('meta', syncTitle);
  events.addEventListener('status', syncStatus);
  events.addEventListener('notice', (e) => toast(String((e as CustomEvent).detail)));
  events.addEventListener('fatal', (e) => showOverlay('fatal', undefined, String((e as CustomEvent).detail)));
  syncStatus();
  requestRender();
}

// ---------------------------------------------------------------- boards

let boardCache: BoardMeta[] = [];
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function relTime(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

async function refreshBoardList() {
  try { boardCache = await api.boards(); } catch { return; }
  $('board-list').innerHTML = boardCache.map((b) => `
    <button class="board-row ${b.id === session.boardId ? 'current' : ''}" data-board="${b.id}">
      <span class="board-row-name">${escapeHtml(b.name)}</span>
      <span class="board-row-meta">${b.live ? `<i class="live-dot"></i>${b.live} live · ` : ''}${relTime(b.updated)}</span>
    </button>`).join('');
}

export async function newBoard() {
  closePopovers();
  try {
    const b = await api.createBoard('Untitled board');
    openBoard(b.id);
    setTimeout(startRename, 150);
  } catch (err) {
    toast(`Couldn’t create a board: ${(err as Error).message}`);
  }
}

let renaming = false;
function startRename() {
  if (!session.boardId || session.invite) return;
  closePopovers();
  const el = $('board-name');
  const id = session.boardId;
  const before = session.boardName;
  renaming = true;
  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(r);
  const done = async (save: boolean) => {
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    el.classList.remove('editing');
    renaming = false;
    const name = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!save || !name || name === before) { el.textContent = before; return; }
    session.boardName = name;
    document.title = `${name} · Brainboard`;
    showBoardInUrl();
    try { await api.renameBoard(id, name); } catch { toast('Rename failed'); }
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); void done(false); el.blur(); }
  };
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', () => { if (renaming) void done(true); }, { once: true });
}

let deleteArmed = 0;
async function deleteCurrentBoard() {
  const id = session.boardId;
  if (!id) return;
  const btn = menu.querySelector<HTMLElement>('[data-action="delete-board"]')!;
  if (Date.now() - deleteArmed > 4000) {
    deleteArmed = Date.now();
    menu.hidden = false;
    btn.textContent = 'Click again to delete';
    setTimeout(() => { btn.textContent = 'Delete board'; }, 4000);
    return;
  }
  deleteArmed = 0;
  btn.textContent = 'Delete board';
  closePopovers();
  try {
    await api.deleteBoard(id);
    const rest = (await api.boards()).filter((b) => b.id !== id);
    openBoard(rest[0]?.id ?? (await api.createBoard('My board')).id);
    toast('Board moved to ~/.brainboard/trash');
  } catch (err) {
    toast(`Couldn’t delete: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- full-screen states

export function showOverlay(
  kind: 'offline' | 'invalid' | 'join' | 'fatal', onJoin?: () => void, msg?: string,
  invite?: { role: string; name?: string | null; from?: string | null; board?: string | null },
) {
  const el = $('overlay');
  el.hidden = false;
  document.body.classList.add('loaded');
  requestAnimationFrame(() => paintLogos(el));
  const logo = '<span class="logo big" aria-hidden="true"></span>';
  if (kind === 'join') {
    const p = session.profile;
    // Signed-in name, then the name this browser used before, then the name the owner gave the link.
    const name = account.user?.name || p.name || invite?.name || '';
    const what = invite?.role === 'viewer' ? 'to view' : 'to edit';
    el.innerHTML = `
      <form class="panel sheet join">
        ${logo}
        <h2>${invite?.board ? `Join “${escapeHtml(invite.board)}”` : 'You’re invited to a board'}</h2>
        <p class="muted">${invite?.from ? `${escapeHtml(invite.from)} invited you ${what}.` : `You’re invited ${what}.`} ${name ? 'Is this you? Change your name if not.' : 'Pick a name so others know who’s here.'}</p>
        <label class="field"><span>Your name</span><input name="name" maxlength="40" autocomplete="nickname" placeholder="e.g. Sam" value="${escapeHtml(name)}" required /></label>
        <div class="colors">${['#f2555a', '#f5871f', '#e0b400', '#2fb36d', '#14a3c7', '#4f6bff', '#9b5cf0', '#e0559c'].map((c) => `<label class="color-pick"><input type="radio" name="color" value="${c}" ${c === p.color ? 'checked' : ''}/><i style="background:${c}"></i></label>`).join('')}</div>
        <button class="primary" type="submit">Join board</button>
      </form>`;
    const form = el.querySelector('form')!;
    const input = form.elements.namedItem('name') as HTMLInputElement;
    input.focus();
    input.select(); // prefilled: Enter to join, or just type to replace it
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      saveProfile(String(fd.get('name') ?? ''), String(fd.get('color') ?? p.color));
      el.hidden = true;
      onJoin?.();
    });
    return;
  }
  const copy = {
    offline: ['Can’t reach your brainboard server', 'Start it from the project folder with <code>npm run dev</code>, then reload this page.'],
    invalid: ['This invite link doesn’t work', 'It may have been revoked, or the board was deleted. Ask the owner for a new link.'],
    fatal: [msg ?? 'Disconnected', session.invite ? 'Ask the owner for a new link if you need access again.' : 'Reload to pick another board.'],
  }[kind];
  el.innerHTML = `<div class="panel sheet notice">${logo}<h2>${copy[0]}</h2><p class="muted">${copy[1]}</p><button class="primary" onclick="location.reload()">Reload</button></div>`;
}
