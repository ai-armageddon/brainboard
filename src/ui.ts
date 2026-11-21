import { icon } from './icons';
import { initReleaseNotes } from './release-notes';
import { clearFontPreview, previewFont } from './font-preview';
import { S, canRedo, canUndo, checkpoint, getItem, isBrushTool, redo, requestRender, savePrefs, undo } from './state';
import { hooks, selBounds, viewport } from './render';
import { COLORS, CORNERS, FONTS, SHAPES, type CornerKey, type FontKey, type ColorKey, type Item, type ShapeKind, type Tool } from './types';
import {
  addImages, bumpFont, setCorners, canEditText, currentTextStyle, formatSelection, clearBoard, deleteSelection, duplicateSelection,
  importBoard, reorder, setColor, setShape, setTool, setZoom, startEditing, viewCenter, zoomBy, zoomToFit,
} from './actions';
import { clamp } from './geometry';
import { account, api, events, saveProfile, session, type BoardMeta } from './net';
import { ensureBoard, openBoard, openDraft, saveCamera, showBoardInUrl } from './boards';
import { boardCallBadge, openHome } from './home';
import { paintLogos } from './brand';
import { userMovedCamera } from './collab';
import { keyLabel, localizeKeys } from './keys';
import { uploadsPending } from './uploading';
import { ARRANGE, arrange, arrangeAvailable, type ArrangeKind } from './arrange';
import { isVimMode, setVimMode } from './vim';
import { startTour } from './tour';
import { openAuth, signOut } from './account';
import { openExport } from './export';

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
  penbar.hidden = !isBrushTool(S.tool);
  if (!isBrushTool(S.tool)) return;
  const tool = S.tool;
  penbar.dataset.tool = tool;
  if (tool === 'pen') $('beauty-btn').setAttribute('aria-pressed', String(S.pen.beauty));
  if (tool === 'eraser') {
    for (const button of penbar.querySelectorAll<HTMLElement>('[data-erase-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.eraseMode === S.eraser.mode));
    }
  }
  for (const b of penbar.querySelectorAll<HTMLButtonElement>('[data-step]')) {
    const action = b.dataset.step === '1' ? 'Increase' : 'Decrease';
    b.setAttribute('aria-label', `${action} ${tool} size`);
    b.title = `${action} ${tool} size · ${b.dataset.step === '1' ? '+' : '−'}`;
  }
  $('pen-size').setAttribute('aria-label', `${tool === 'pen' ? 'Pen' : 'Eraser'} size`);
  updateBrushSize();
}

let brushPreviewTimer = 0;

export function setBrushSize(size: number) {
  if (!isBrushTool(S.tool)) return;
  const brush = S[S.tool];
  const next = Math.max(1, Math.round(size));
  if (brush.size === next) return;
  brush.size = next;
  updateBrushSize();
  const cursor = $('brush-cursor');
  cursor.classList.add('sizing');
  clearTimeout(brushPreviewTimer);
  brushPreviewTimer = window.setTimeout(() => cursor.classList.remove('sizing'), 1000);
  savePrefs();
}

function updateBrushSize() {
  if (!isBrushTool(S.tool)) return;
  const size = S[S.tool].size;
  $('pen-size').textContent = `${size} px`;
  const cursor = $('brush-cursor');
  cursor.dataset.size = `${size} px`;
  cursor.style.setProperty('--diameter', `${size}px`);
  const scaleMax = 2 ** Math.ceil(Math.log2(Math.max(16, size)));
  penbar.style.setProperty('--size-percent', `${100 * size / scaleMax}%`);
  $('brush-scale-end').textContent = `${scaleMax} px`;
  penbar.querySelector<HTMLButtonElement>('[data-step="-1"]')!.disabled = size <= 1;
  for (const b of penbar.querySelectorAll<HTMLElement>('[data-size]')) {
    const on = Number(b.dataset.size) === size;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

export const openImagePicker = () => fileImages.click();

// ---------------------------------------------------------------- context bar

const swatch = (c: ColorKey, on: boolean) =>
  `<button class="sw ${on ? 'on' : ''}" data-color="${c}" style="--f:var(--f-${c});--s:var(--s-${c})" aria-label="${c}" data-tip="${c[0].toUpperCase() + c.slice(1)}"></button>`;
const btn = (act: string, ic: string, tip: string, extra = '') =>
  `<button class="cbtn ${extra}" data-act="${act}" data-tip="${tip}" aria-label="${tip}">${icon(ic, 18)}</button>`;
const SEP = '<span class="sep"></span>';

let ctxSig = '';
let textToolSig = '';
let sizingText = false;

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
  const images = sel.filter((i) => i.type === 'image');
  if (images.length) {
    const rounds = new Set(images.map((i) => (i.type === 'image' ? i.round ?? 0 : 0)));
    const names: Record<CornerKey, [string, string]> = {
      square: ['cornerSquare', 'Square corners'], soft: ['cornerSoft', 'Slightly rounded'],
      round: ['cornerRound', 'Rounded corners'], full: ['cornerFull', 'Fully rounded'],
    };
    parts.push('<div class="corners" role="group" aria-label="Image corners">' + (Object.keys(CORNERS) as CornerKey[]).map((k) => {
      const on = rounds.size === 1 && rounds.has(CORNERS[k]);
      const [ic, tip] = names[k];
      return `<button class="cbtn ${on ? 'on' : ''}" data-corners="${k}" data-tip="${tip}" aria-label="${tip}" aria-pressed="${on}">${icon(ic, 18)}</button>`;
    }).join('') + '</div>');
  }
  if (sel.some(canEditText)) {
    const fonts = Object.entries(FONTS).map(([id, [name, family]]) =>
      `<button data-font="${id}" style="font-family:${family.replaceAll('"', '&quot;')}">${name}</button>`).join('');
    parts.push(`<details class="font-picker"><summary aria-label="Choose font"><span>Font</span>${icon('chevron', 14)}</summary>
      <div class="font-list panel">${fonts}</div></details>` +
      '<button class="cbtn" data-act="bold" aria-label="Bold" title="Bold · ⌘B"><b>B</b></button>' +
      '<button class="cbtn" data-act="underline" aria-label="Underline" title="Underline · ⌘U"><u>U</u></button>' +
      btn('font-down', 'sizeDown', 'Smaller text') + btn('font-up', 'sizeUp', 'Larger text'));
  }
  const nodes = sel.filter((i) => i.type !== 'edge').length;
  if (nodes >= 2) {
    const align = (k: ArrangeKind) => { const a = ARRANGE[k]; return `<button class="arr-btn" data-arrange="${k}" title="${a.tip} · ${a.key}">${icon(a.icon, 20)}<span>${a.label}</span></button>`; };
    const row = (k: ArrangeKind) => {
      const a = ARRANGE[k];
      return `<button class="arr-row" data-arrange="${k}" title="${a.tip}" ${arrangeAvailable(k, nodes) ? '' : 'disabled'}>${icon(a.icon, 18)}<span>${a.label}</span><kbd>${a.key}</kbd></button>`;
    };
    parts.push(`<details class="arrange-picker"><summary aria-label="Align and space" data-tip="Align &amp; space">${icon('alignLeft', 18)}${icon('chevron', 14)}</summary>
      <div class="arrange-menu panel">
        <div class="arr-title">Align</div>
        <div class="arr-grid">${(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map(align).join('')}</div>
        <div class="arr-title">Spacing</div>
        ${(['space-h', 'space-v', 'tidy'] as const).map(row).join('')}
        ${nodes < 3 ? '<p class="arr-note">Select 3 or more to space them evenly</p>' : ''}
      </div></details>`);
  }
  const tail: string[] = [];
  if (sel.length === 1 && canEditText(sel[0])) tail.push(btn('edit', 'type', sel[0].type === 'edge' ? 'Label · Enter' : 'Edit text · Enter'));
  if (sel.some((i) => i.type !== 'edge')) {
    tail.push(btn('duplicate', 'copy', 'Duplicate · ⌘D'), btn('front', 'front', 'Bring to front · ]'), btn('back', 'back', 'Send to back · ['));
  }
  tail.push(btn('delete', 'trash', 'Delete · ⌫', 'danger'));
  parts.push(tail.join(''));
  ctx.innerHTML = keyLabel(parts.join(SEP));
  textToolSig = '';
}

function updateTextTools(sel: Item[]) {
  const items = sel.filter(canEditText);
  if (!items.length) return;
  const style = currentTextStyle(items);
  const sig = `${style.bold}|${style.underline}|${style.font}`;
  if (sig === textToolSig) return;
  textToolSig = sig;
  for (const key of ['bold', 'underline'] as const) {
    const b = ctx.querySelector<HTMLElement>(`[data-act="${key}"]`)!;
    b.classList.toggle('on', style[key]);
    b.setAttribute('aria-pressed', String(style[key]));
  }
  ctx.querySelector('.font-picker summary span')!.textContent = style.font ? FONTS[style.font]?.[0] ?? 'Font' : 'Font';
  for (const b of ctx.querySelectorAll<HTMLElement>('[data-font]')) b.setAttribute('aria-pressed', String(b.dataset.font === style.font));
}

function updateCtxBar() {
  const sel = S.items.filter((i) => S.selected.has(i.id));
  if (!sel.length || !selBounds) {
    clearFontPreview();
    ctx.classList.remove('show', 'glide');
    ctxSig = '';
    return;
  }
  const sig = sel.map((i) => `${i.id}:${'color' in i ? i.color : ''}:${i.type === 'shape' ? i.shape : ''}:${i.type === 'image' ? i.round ?? 0 : ''}`).join('|');
  if (sig !== ctxSig) {
    clearFontPreview();
    ctxSig = sig;
    sizingText = false;
    buildCtx(sel);
  }
  updateTextTools(sel);
  const wasVisible = ctx.classList.contains('show');
  ctx.classList.add('show');
  if (!sizingText) positionCtxBar(wasVisible);
}

function beginTextSizing() {
  if (sizingText) return;
  sizingText = true;
  // A click can land mid-glide. Hold the menu exactly where the user pressed it.
  const transform = getComputedStyle(ctx).transform;
  ctx.classList.remove('glide');
  ctx.style.transform = transform;
}

function finishTextSizing() {
  if (!sizingText) return;
  sizingText = false;
  positionCtxBar(true);
}

function positionCtxBar(glide: boolean) {
  if (!ctx.classList.contains('show') || !selBounds) return;
  ctx.classList.toggle('glide', glide);
  const { x, y, z } = S.cam;
  const b = selBounds;
  const L = b.x * z + x, T = b.y * z + y, R = (b.x + b.w) * z + x, B = (b.y + b.h) * z + y;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  const left = clamp((L + R) / 2 - w / 2, 12, Math.max(12, innerWidth - w - 12));
  // Stay clear of the bars along the bottom, however many rows they stack into on this screen.
  let floor = innerHeight - 72;
  for (const id of ['toolbar', 'undobar', 'collab']) {
    const r = $(id).getBoundingClientRect();
    if (r.height && r.top > innerHeight / 2) floor = Math.min(floor, r.top);
  }
  let top = T - h - 18;
  if (top < 64) top = B + 18;
  top = clamp(top, 64, Math.max(64, floor - h - 12));
  const roomBelow = innerHeight - top - h;
  ctx.classList.toggle('fonts-above', roomBelow < 210 ? top > roomBelow : top < T && top >= 210);
  ctx.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  placeArrangeMenu(top);
}

/** Open the arrange menu above the bar when it fits there, otherwise below. */
function placeArrangeMenu(top = ctx.getBoundingClientRect().top) {
  const menu = ctx.querySelector<HTMLElement>('.arrange-picker[open] .arrange-menu');
  if (!menu) return;
  const h = menu.offsetHeight + 8;
  const below = innerHeight - (top + ctx.offsetHeight) - 76; // leave the toolbar clear
  ctx.classList.toggle('arrange-above', top - 60 >= h || (below < h && top > below));
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
  initReleaseNotes();
  // ⌘Z, ⌥N… read Ctrl+Z, Alt+N… on Windows and Linux.
  localizeKeys();
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon!));
  });

  $('toolbar').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool as Tool);
    else if (b.id === 'img-btn') openImagePicker();
  });

  const penColors = $('pen-colors');
  const showPenColors = () => { penColors.innerHTML = COLORS.map((c) => swatch(c, c === S.pen.color)).join(''); };
  showPenColors();
  $('pen-presets').innerHTML = [2, 4, 8, 16].map((s) =>
    `<button class="size" data-size="${s}" aria-label="Set size to ${s} pixels" title="${s} px"><i style="width:${s}px;height:${s}px"></i></button>`).join('');
  penbar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (!isBrushTool(S.tool)) return;
    if (b.id === 'beauty-btn') {
      S.pen.beauty = !S.pen.beauty;
      updateToolUI();
      savePrefs();
      toast(S.pen.beauty ? 'Beautify on: smoother ink, and shapes snap clean' : 'Beautify off: ink exactly as drawn');
    } else if (b.dataset.eraseMode === 'partial' || b.dataset.eraseMode === 'whole') {
      S.eraser.mode = b.dataset.eraseMode;
      updateToolUI();
      savePrefs();
    } else if (b.dataset.size) setBrushSize(Number(b.dataset.size));
    else if (b.dataset.step) setBrushSize(S[S.tool].size + Number(b.dataset.step));
    else if (b.dataset.color) {
      S.pen.color = b.dataset.color as ColorKey;
      showPenColors();
      savePrefs();
    }
  });

  document.addEventListener('selectionchange', () => {
    if (S.editing && ctx.classList.contains('show')) {
      clearFontPreview();
      const it = getItem(S.editing);
      if (it && ctx.querySelector('.font-picker')) updateTextTools([it]);
    }
  });
  const fontOption = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('.font-picker[open] [data-font]') : null;
  const previewOption = (e: Event) => {
    const key = fontOption(e.target)?.dataset.font;
    if (key && Object.hasOwn(FONTS, key)) previewFont(key as FontKey);
  };
  ctx.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch') previewOption(e); });
  ctx.addEventListener('pointerout', (e) => { if (!fontOption(e.relatedTarget)) clearFontPreview(); });
  ctx.addEventListener('focusin', previewOption);
  ctx.addEventListener('toggle', (e) => {
    if (!(e.target instanceof HTMLDetailsElement)) return;
    if (!e.target.open) clearFontPreview();
    // One menu at a time.
    else for (const d of ctx.querySelectorAll<HTMLDetailsElement>('details[open]')) if (d !== e.target) d.open = false;
    placeArrangeMenu();
  }, true);
  window.addEventListener('blur', clearFontPreview);
  ctx.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // keep text focus while styling
    if ((e.target as Element).closest('[data-act="font-down"], [data-act="font-up"]')) beginTextSizing();
  });
  ctx.addEventListener('pointerleave', (e) => {
    // Touch leaves after every tap, even when the next tap is on the same button.
    if (e.pointerType !== 'touch') finishTextSizing();
  });
  ctx.addEventListener('focusout', (e) => {
    if (!fontOption(e.relatedTarget)) clearFontPreview();
    if (!ctx.contains(e.relatedTarget as Node | null)) finishTextSizing();
  });
  ctx.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.font && Object.hasOwn(FONTS, b.dataset.font)) {
      clearFontPreview();
      formatSelection('font', b.dataset.font as FontKey);
      ctx.querySelector<HTMLDetailsElement>('.font-picker')!.open = false;
      return;
    }
    if (b.dataset.color) return setColor(b.dataset.color as ColorKey);
    if (b.dataset.shape) return setShape(b.dataset.shape as ShapeKind);
    if (b.dataset.arrange && Object.hasOwn(ARRANGE, b.dataset.arrange)) return void arrange(b.dataset.arrange as ArrangeKind);
    if (b.dataset.corners && Object.hasOwn(CORNERS, b.dataset.corners)) return setCorners(CORNERS[b.dataset.corners as CornerKey]);
    switch (b.dataset.act) {
      case 'bold': case 'underline': return formatSelection(b.dataset.act);
      case 'font-down':
      case 'font-up':
        beginTextSizing();
        return bumpFont(b.dataset.act === 'font-up' ? 'larger' : 'smaller');
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
      case 'export': openExport(); break;
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
      case 'home': openHome(); break;
      case 'rename': startRename(); break;
      case 'delete-board': void deleteCurrentBoard(); break;
    }
  });
  window.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!ctx.contains(t)) finishTextSizing();
    for (const picker of ctx.querySelectorAll<HTMLDetailsElement>('details[open]')) if (!picker.contains(t)) picker.open = false;
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
    hint.classList.toggle('show', S.items.length === 0 && !uploadsPending());
    ($('undo-btn') as HTMLButtonElement).disabled = !canUndo();
    ($('redo-btn') as HTMLButtonElement).disabled = !canRedo();
  };
  hooks.afterCamera = () => {
    saveCamera();
    sizingText = false;
    positionCtxBar(false);
    zoomLabel.textContent = `${Math.round(S.cam.z * 100)}%`;
  };
  viewport.dataset.tool = S.tool;

  events.addEventListener('peers', () => { if (!menu.hidden && !session.invite) renderBoardList(); });
  $('board-list').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-board]');
    if (!b) return;
    closePopovers();
    openBoard(b.dataset.board!, b.querySelector('.board-row-name')?.textContent ?? undefined);
  });
  $('board-name').addEventListener('dblclick', (e) => { e.stopPropagation(); if (!session.invite) startRename(); });
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN' && !session.invite && !S.editing) { e.preventDefault(); void newBoard(); }
  });

  const syncTitle = () => {
    const name = session.boardName || 'brainboard';
    if (!renaming) $('board-name').textContent = name;
    document.title = session.boardName ? `${session.boardName} · Brainboard` : 'Brainboard';
  };
  const syncStatus = () => {
    const dot = $('status-dot');
    dot.dataset.status = session.status;
    dot.title = session.status === 'live' ? 'Live · changes save automatically'
      : session.status === 'draft' ? 'Not saved yet · it saves once you add something'
      : session.status === 'connecting' ? 'Connecting…' : 'Offline · reconnecting';
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
  renderBoardList();
}

function renderBoardList() {
  $('board-list').innerHTML = boardCache.map((b) => `
    <button class="board-row ${b.id === session.boardId ? 'current' : ''}" data-board="${b.id}">
      <span class="board-row-name">${escapeHtml(b.name)}</span>
      <span class="board-row-meta">${boardCallBadge(b)}${b.live ? `<i class="live-dot"></i>${b.live} live · ` : ''}${relTime(b.updated)}</span>
    </button>`).join('');
}

export async function newBoard() {
  closePopovers();
  try {
    const b = await api.createBoard('Untitled board');
    openBoard(b.id, b.name);
    setTimeout(startRename, 150);
  } catch (err) {
    toast(`Couldn’t create a board: ${(err as Error).message}`);
  }
}

let renaming = false;
function startRename() {
  if ((!session.boardId && !session.draft) || session.invite) return;
  closePopovers();
  const el = $('board-name');
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
    if (!session.boardId) { await ensureBoard(); return; } // a blank draft is created with this name
    showBoardInUrl();
    try { await api.renameBoard(session.boardId, name); } catch { toast('Rename failed'); }
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
    if (rest[0]) openBoard(rest[0].id, rest[0].name);
    else openDraft();
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
