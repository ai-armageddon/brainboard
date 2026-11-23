// Vim-style keys for the board: a `:` command line, `/` search, and normal-mode motions.
//
// Always on (none of these clash with the regular shortcuts):
//   :  /  u  ⌃R  x  yy  w  b  gg  G  a  zz  zi  zo  gt  gT  gv  m{a-z}  '{a-z}
// Vim mode (`:set vim`, or the menu) adds the keys that would otherwise pick a tool:
//   h j k l  H J K L  i  o O  gp P  n N  dd  cc  s  e
import { replaceItemText } from './text-runs';
import { S, changed, checkpoint, getItem, redo, requestRender, undo } from './state';
import { COLORS, type Box, type ColorKey, type Item, type NodeItem, type ShapeKind, type Tool } from './types';
import { hooks, selBounds, textElOf } from './render';
import {
  animateCam, canEditText, clearBoard, createSibling, deleteSelection, isNode, isTextual,
  panIntoView, selectionItems, setColor, setShape, setTool, setZoom, startEditing, zoomBy, zoomToFit,
} from './actions';
import { api, canEdit, isOwner, session } from './net';
import { isWritingHelp, setWritingHelp } from './writing';
import { closePopovers, getTheme, applyTheme, newBoard, openImagePicker, toggleShortcuts, type Theme } from './ui';
import { follow, userMovedCamera } from './collab';
import { openBoard } from './boards';
import { openViews } from './views';
import { saveCommand } from './account';
import { openExport } from './export';
import { openScreenshot } from './screenshot';
import { openMedia } from './media';
import { openBrowser } from './browse';
import { pointerWorld, putClip, yank, clipBounds } from './input';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- mode

let vimMode = false;
try { vimMode = localStorage.getItem('bb-vim') === '1'; } catch { /* ignore */ }

export const isVimMode = () => vimMode;

export function setVimMode(on: boolean) {
  vimMode = on;
  try { localStorage.setItem('bb-vim', on ? '1' : '0'); } catch { /* ignore */ }
  $('vim-label').textContent = on ? 'On' : 'Off';
  document.querySelectorAll<HTMLElement>('#toolbar [data-tip]').forEach((b) => {
    b.dataset.tipNormal ??= b.dataset.tip;
    const vt = b.dataset.vimTip;
    b.dataset.tip = on && vt ? vt : b.dataset.tipNormal;
  });
  showMode();
}

// ---------------------------------------------------------------- mode line (bottom-left): mode, pending keys, messages

let msgText = '';
let msgErr = false;
let msgTimer = 0;
let pending = '';
let pendTimer = 0;

function showMode() {
  const el = $('modeline');
  if (msgText) {
    el.textContent = msgText;
    el.classList.toggle('err', msgErr);
    el.hidden = false;
    return;
  }
  el.classList.remove('err');
  const mode = !vimMode ? '' : S.editing ? '-- INSERT --' : 'NORMAL';
  const text = [mode, pending].filter(Boolean).join('  ');
  el.textContent = text;
  el.hidden = !text;
}

/** Show a vim-style message in the mode line for a few seconds. */
export function message(text: string, err = false) {
  msgText = text;
  msgErr = err;
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => { msgText = ''; showMode(); }, err ? 4000 : 2600);
  showMode();
}
const fail = (text: string) => message(text, true);

// ---------------------------------------------------------------- spatial helpers

const navItems = () => S.items.filter((i): i is NodeItem => isNode(i) && i.type !== 'stroke');
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

function boxOf(it: Item): Box | null {
  if (it.type !== 'edge') return it;
  const a = getItem(it.from), b = getItem(it.to);
  if (!isNode(a) || !isNode(b)) return null;
  const ca = center(a), cb = center(b);
  return { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, w: 0, h: 0 };
}

/** Items in reading order: rows top to bottom, each row left to right. */
function readingOrder(list: Item[]): Item[] {
  const boxed = list.map((it) => ({ it, b: boxOf(it) })).filter((e): e is { it: Item; b: Box } => !!e.b);
  boxed.sort((p, q) => center(p.b).y - center(q.b).y);
  const rows: { cy: number; h: number; items: typeof boxed }[] = [];
  for (const e of boxed) {
    const cy = center(e.b).y;
    const row = rows[rows.length - 1];
    if (row && cy - row.cy < Math.max(row.h, e.b.h, 1) * 0.5) row.items.push(e);
    else rows.push({ cy, h: e.b.h, items: [e] });
  }
  return rows.flatMap((r) => r.items.sort((p, q) => p.b.x - q.b.x).map((e) => e.it));
}

function current(): Item | undefined {
  if (!S.selected.size) return undefined;
  return readingOrder(S.items.filter((i) => S.selected.has(i.id)))[0];
}

let lastJump: { x: number; y: number; z: number } | null = null;
const rememberJump = () => { lastJump = { ...S.cam }; };

/** Select one item and bring it on screen. */
function focusItem(it: Item, centerIt = false) {
  S.selected = new Set([it.id]);
  requestRender();
  const b = boxOf(it);
  if (!b || !userMovedCamera()) return;
  if (centerIt) centerOn(b);
  else panIntoView(b);
}

function centerOn(b: Box) {
  const { z } = S.cam;
  const c = center(b);
  animateCam({ x: innerWidth / 2 - c.x * z, y: innerHeight / 2 - c.y * z, z });
}

function nearestToView(): NodeItem | undefined {
  const c = { x: (innerWidth / 2 - S.cam.x) / S.cam.z, y: (innerHeight / 2 - S.cam.y) / S.cam.z };
  let best: NodeItem | undefined, bd = Infinity;
  for (const it of navItems()) {
    const p = center(it);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

/** h/j/k/l: hop to the closest item in that direction, preferring ones that are straight ahead. */
function move(dir: 'h' | 'j' | 'k' | 'l') {
  const cur = current();
  const from = cur && boxOf(cur);
  if (!from) {
    const n = nearestToView();
    if (n) focusItem(n);
    return;
  }
  const c = center(from);
  let best: NodeItem | undefined, bs = Infinity;
  for (const o of navItems()) {
    if (o.id === cur!.id) continue;
    const p = center(o);
    const dx = p.x - c.x, dy = p.y - c.y;
    const along = dir === 'l' ? dx : dir === 'h' ? -dx : dir === 'j' ? dy : -dy;
    const across = dir === 'h' || dir === 'l' ? dy : dx;
    if (along <= 0.001) continue;
    const s = along + Math.abs(across) * 2.5;
    if (s < bs) { bs = s; best = o; }
  }
  if (best) focusItem(best);
}

function step(delta: number) {
  const order = readingOrder(navItems());
  if (!order.length) return;
  const cur = current();
  const i = cur ? order.findIndex((o) => o.id === cur.id) : -1;
  const next = i < 0 ? (delta > 0 ? order[0] : order[order.length - 1]) : order[(i + delta + order.length) % order.length];
  focusItem(next);
}

function edge(last: boolean) {
  const order = readingOrder(navItems());
  if (!order.length) return;
  rememberJump();
  focusItem(last ? order[order.length - 1] : order[0], true);
}

function panScreen(dir: 'H' | 'J' | 'K' | 'L') {
  if (!userMovedCamera()) return;
  const { x, y, z } = S.cam;
  const dx = dir === 'H' ? innerWidth / 3 : dir === 'L' ? -innerWidth / 3 : 0;
  const dy = dir === 'K' ? innerHeight / 3 : dir === 'J' ? -innerHeight / 3 : 0;
  animateCam({ x: x + dx, y: y + dy, z }, 180);
}

// ---------------------------------------------------------------- editing helpers

function editAt(where: 'start' | 'end' | 'all') {
  if (!canEdit()) return;
  const cur = current();
  if (!cur || !canEditText(cur)) return;
  startEditing(cur.id);
  if (where === 'all') return;
  const t = textElOf(cur.id);
  const sel = getSelection();
  if (!t || !sel) return;
  const r = document.createRange();
  r.selectNodeContents(t);
  r.collapse(where === 'start');
  sel.removeAllRanges();
  sel.addRange(r);
}

function yankSelection(): number {
  const items = selectionItems();
  if (items.length) yank(items);
  return items.filter(isNode).length;
}

function put(before: boolean) {
  if (!canEdit()) return;
  const cb = clipBounds();
  if (!cb) return fail('E353: Nothing in register "');
  let at = pointerWorld();
  if (selBounds) {
    const b = selBounds;
    const gap = 40 / S.cam.z;
    at = { x: before ? b.x - gap - cb.w / 2 : b.x + b.w + gap + cb.w / 2, y: b.y + b.h / 2 };
  }
  putClip(at);
}

// ---------------------------------------------------------------- marks

const marksKey = () => `bb-marks-${session.boardId}`;
type Marks = Record<string, { x: number; y: number; z: number }>;
function getMarks(): Marks {
  try { return JSON.parse(localStorage.getItem(marksKey()) ?? '{}') as Marks; } catch { return {}; }
}
function saveMarks(m: Marks) {
  try { localStorage.setItem(marksKey(), JSON.stringify(m)); } catch { /* ignore */ }
}

function setMark(ch: string) {
  if (!/^[a-zA-Z]$/.test(ch)) return;
  const m = getMarks();
  const { x, y, z } = S.cam;
  m[ch] = { x: (innerWidth / 2 - x) / z, y: (innerHeight / 2 - y) / z, z };
  saveMarks(m);
  message(`mark '${ch}' set`);
}

function jumpMark(ch: string) {
  if (ch === "'" || ch === '`') {
    if (!lastJump) return fail('E20: Mark not set');
    if (!userMovedCamera()) return;
    const to = lastJump;
    rememberJump();
    animateCam(to);
    return;
  }
  const v = getMarks()[ch];
  if (!v) return fail('E20: Mark not set');
  if (!userMovedCamera()) return;
  rememberJump();
  animateCam({ x: innerWidth / 2 - v.x * v.z, y: innerHeight / 2 - v.y * v.z, z: v.z });
}

// ---------------------------------------------------------------- search

let lastSearch = '';

function matcher(q: string): (s: string) => boolean {
  const cs = /[A-Z]/.test(q); // smartcase
  const needle = cs ? q : q.toLowerCase();
  return (s) => (cs ? s : s.toLowerCase()).includes(needle);
}

function searchable(it: Item) {
  return it.type === 'edge' ? it.label : isTextual(it) ? it.text : '';
}

/** Find the next match for `q` after (or before) `from`. Returns the item and its position among matches. */
function findMatch(q: string, dir: 1 | -1, from?: Item) {
  const order = readingOrder(S.items.filter((i) => i.type !== 'stroke' && i.type !== 'image'));
  const test = matcher(q);
  const hits = order.filter((i) => test(searchable(i)));
  if (!hits.length) return null;
  const pos = from ? order.indexOf(from) : -1;
  let idx: number;
  let wrapped = false;
  if (dir > 0) {
    idx = hits.findIndex((h) => order.indexOf(h) > pos);
    if (idx < 0) { idx = 0; wrapped = pos >= 0; }
  } else {
    idx = -1;
    for (let i = hits.length - 1; i >= 0; i--) if (order.indexOf(hits[i]) < (pos < 0 ? order.length : pos)) { idx = i; break; }
    if (idx < 0) { idx = hits.length - 1; wrapped = true; }
  }
  return { it: hits[idx], n: idx + 1, total: hits.length, wrapped };
}

function searchNext(dir: 1 | -1) {
  if (!lastSearch) return fail('E35: No previous regular expression');
  const m = findMatch(lastSearch, dir, current());
  if (!m) return fail(`E486: Pattern not found: ${lastSearch}`);
  rememberJump();
  focusItem(m.it);
  if (m.wrapped) message(dir > 0 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM', true);
  else message(`${dir > 0 ? '/' : '?'}${lastSearch}  [${m.n}/${m.total}]`);
}

// ---------------------------------------------------------------- :s/pattern/replacement/flags

function splitDelim(body: string, d: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === d) { cur += d; i++; continue; }
    if (c === '\\' && i + 1 < body.length) { cur += c + body[i + 1]; i++; continue; }
    if (c === d) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Vim replacement syntax (&, \1, \n) → JS replacement syntax. */
function vimReplacement(rep: string) {
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\' && i + 1 < rep.length) {
      const n = rep[++i];
      out += /\d/.test(n) ? `$${n}` : n === 'n' || n === 'r' ? '\n' : n === 't' ? '\t' : n === '&' ? '&' : n === '$' ? '$$' : n;
    } else if (c === '&') out += '$&';
    else if (c === '$') out += '$$';
    else out += c;
  }
  return out;
}

function substitute(whole: boolean, body: string) {
  if (!canEdit()) return fail('E21: Cannot make changes, board is view-only');
  const d = body[0];
  if (!d) return fail('E35: No previous regular expression');
  const [pat0 = '', rep = '', flags = ''] = splitDelim(body.slice(1), d);
  const pat = pat0 || lastSearch;
  if (!pat) return fail('E35: No previous regular expression');
  const ci = flags.includes('i') || (!flags.includes('I') && !/[A-Z]/.test(pat));
  let re: RegExp;
  try { re = new RegExp(pat, `${flags.includes('g') ? 'g' : ''}${ci ? 'i' : ''}`); } catch (e) {
    return fail(`E486: Bad pattern: ${(e as Error).message}`);
  }
  const counter = new RegExp(re.source, `g${ci ? 'i' : ''}`);
  const targets = whole ? S.items : S.items.filter((i) => S.selected.has(i.id));
  if (!targets.length) return fail(whole ? 'E486: Board is empty' : 'Nothing selected. Use :%s for the whole board');
  const replacement = vimReplacement(rep);
  let subs = 0, items = 0, began = false;
  for (const it of targets) {
    const before = searchable(it);
    if (!before) continue;
    const found = before.match(counter)?.length ?? 0;
    if (!found) continue;
    const after = before.replace(re, replacement);
    if (after === before) continue;
    if (!began) { checkpoint(); began = true; }
    if (canEditText(it)) replaceItemText(it, after);
    subs += flags.includes('g') ? found : 1;
    items++;
  }
  lastSearch = pat;
  if (!items) return fail(`E486: Pattern not found: ${pat}`);
  changed();
  message(`${subs} substitution${subs === 1 ? '' : 's'} on ${items} item${items === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------- boards

let boardNames: { id: string; name: string }[] = [];
async function loadBoards() {
  if (session.invite) return [];
  try { boardNames = (await api.boards()).map((b) => ({ id: b.id, name: b.name })); } catch { /* ignore */ }
  return boardNames;
}

function ownerOnly(): boolean {
  if (isOwner() && !session.invite) return true;
  fail('Only the board owner can do that');
  return false;
}

async function cycleBoard(delta: number) {
  if (!ownerOnly()) return;
  const list = (await loadBoards()).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (list.length < 2) return message('Only one board');
  const i = list.findIndex((b) => b.id === session.boardId);
  const next = list[(i + delta + list.length) % list.length];
  openBoard(next.id, next.name);
  message(`"${next.name}"`);
}

async function editBoard(name: string) {
  if (!ownerOnly()) return;
  if (!name) { $('menu-btn').click(); return; }
  const list = await loadBoards();
  const q = name.toLowerCase();
  const exact = list.filter((b) => b.name.toLowerCase() === q);
  const pre = list.filter((b) => b.name.toLowerCase().startsWith(q));
  const sub = list.filter((b) => b.name.toLowerCase().includes(q));
  const pick = exact.length === 1 ? exact : pre.length ? pre : sub;
  if (pick.length === 1) { openBoard(pick[0].id, pick[0].name); message(`"${pick[0].name}"`); return; }
  if (!pick.length) return fail(`E94: No matching board for ${name}`);
  fail(`E93: More than one match for ${name}`);
}

async function renameTo(name: string) {
  if (!ownerOnly() || !session.boardId) return;
  try {
    await api.renameBoard(session.boardId, name);
    session.boardName = name;
    $('board-name').textContent = name;
    document.title = `${name} · Brainboard`;
    message(`"${name}"`);
  } catch { fail('Rename failed'); }
}

// ---------------------------------------------------------------- commands

interface Cmd {
  names: string[];
  usage?: string;
  desc: string;
  run: (arg: string, bang: boolean) => void | Promise<void>;
  complete?: (arg: string) => string[];
}

const TOOL_CMDS: [string[], Tool, string][] = [
  [['select'], 'select', 'Select tool'],
  [['hand', 'pan'], 'hand', 'Pan tool'],
  [['pen', 'draw'], 'pen', 'Pen'],
  [['eraser'], 'eraser', 'Eraser'],
  [['note', 'sticky'], 'note', 'Sticky note tool'],
  [['text'], 'text', 'Text tool'],
  [['bubble', 'ellipse'], 'ellipse', 'Bubble tool'],
  [['box', 'rect'], 'rect', 'Box tool'],
  [['decision', 'diamond'], 'diamond', 'Decision tool'],
  [['connect', 'arrow'], 'connect', 'Connector tool'],
];
const SHAPE_NAMES: Record<string, ShapeKind> = { bubble: 'ellipse', ellipse: 'ellipse', pill: 'pill', box: 'rect', rect: 'rect', decision: 'diamond', diamond: 'diamond' };
const THEMES: Theme[] = ['auto', 'light', 'dark'];
const filterPrefix = (opts: string[], a: string) => opts.filter((o) => o.toLowerCase().startsWith(a.toLowerCase()));

const peerNames = () =>
  [...session.peers.values()].filter((p) => p.id !== session.you?.id).map((p) => p.name);

const COMMANDS: Cmd[] = [
  { names: ['write', 'w', 'update'], desc: 'Save (to an account if this board isn’t yet)', run: () => {
    if (session.status !== 'live') return message('Offline: changes will sync when you reconnect', true);
    saveCommand();
  } },
  { names: ['quit', 'q', 'wq', 'x', 'xit', 'qa', 'qall', 'wqa', 'close'], desc: 'Close menus and clear the selection', run: () => {
    closePopovers();
    S.selected.clear();
    requestRender();
    message('Nothing to quit: brainboard saves as you go');
  } },
  { names: ['edit', 'e', 'buffer', 'b', 'open'], usage: '{board}', desc: 'Open a board', run: (a) => editBoard(a),
    complete: (a) => filterPrefix(boardNames.map((b) => b.name), a) },
  { names: ['bnext', 'bn', 'tabnext', 'tabn'], desc: 'Next board', run: () => cycleBoard(1) },
  { names: ['bprevious', 'bp', 'bprev', 'bN', 'tabprevious', 'tabp'], desc: 'Previous board', run: () => cycleBoard(-1) },
  { names: ['ls', 'boards', 'buffers', 'files'], desc: 'List boards', run: () => { if (ownerOnly()) $('menu-btn').click(); } },
  { names: ['views'], desc: 'Open saved views', run: openViews },
  { names: ['new', 'enew', 'tabnew', 'tabe'], usage: '[name]', desc: 'Create a board', run: async (a) => {
    if (!ownerOnly()) return;
    if (!a) { void newBoard(); return; }
    try { const b = await api.createBoard(a); openBoard(b.id, b.name); message(`"${b.name}" created`); } catch (e) { fail((e as Error).message); }
  } },
  { names: ['file', 'f', 'rename', 'saveas', 'sav'], usage: '[name]', desc: 'Rename this board (or show its info)', run: (a) => {
    if (a) return renameTo(a);
    const n = S.items.length;
    message(`"${session.boardName}" ${n} item${n === 1 ? '' : 's'} --${session.status}--`);
  } },
  { names: ['fit', 'zf'], desc: 'Zoom to fit everything', run: () => { if (userMovedCamera()) zoomToFit(); } },
  { names: ['zoom', 'z'], usage: '{percent}', desc: 'Set the zoom level', run: (a) => {
    const n = parseFloat(a);
    if (!a) return message(`${Math.round(S.cam.z * 100)}%`);
    if (!Number.isFinite(n) || n <= 0) return fail(`E475: Invalid argument: ${a}`);
    if (userMovedCamera()) setZoom(n / 100);
  } },
  { names: ['theme', 'colorscheme', 'colo'], usage: '{auto|light|dark}', desc: 'Change the theme', run: (a) => {
    const t = (a === 'default' ? 'auto' : a) as Theme;
    if (!a) return message(`theme=${getTheme()}`);
    if (!THEMES.includes(t)) return fail(`E185: Cannot find theme '${a}'`);
    applyTheme(t);
  }, complete: (a) => filterPrefix(THEMES, a) },
  { names: ['set', 'se'], usage: '{vim|nospell|bg=dark}', desc: 'Set an option', run: (a) => {
    if (!a) return message(`${vimMode ? '' : 'no'}vim  ${isWritingHelp() ? '' : 'no'}spell  background=${getTheme()}`);
    for (const opt of a.split(/\s+/)) {
      if (opt === 'vim') setVimMode(true);
      else if (opt === 'novim') setVimMode(false);
      else if (opt === 'vim!' || opt === 'invvim') setVimMode(!vimMode);
      else if (opt === 'vim?') message(`${vimMode ? '' : 'no'}vim`);
      else if (/^(no|inv)?spell[!?]?$/.test(opt)) {
        if (!opt.endsWith('?')) setWritingHelp(opt === 'spell' ? true : opt === 'nospell' ? false : !isWritingHelp());
        message(isWritingHelp() ? 'Spelling and suggestions on' : 'Spelling and suggestions off');
      }
      else if (/^(bg|background)=/.test(opt)) {
        const v = opt.split('=')[1] as Theme;
        if (!THEMES.includes(v)) return fail(`E474: Invalid argument: ${opt}`);
        applyTheme(v);
      } else return fail(`E518: Unknown option: ${opt}`);
    }
    if (/\b(no|inv)?vim!?\b/.test(a)) message(vimMode ? 'Vim mode on: hjkl, i, o, gp, dd…' : 'Vim mode off');
  }, complete: (a) => filterPrefix(['vim', 'novim', 'spell', 'nospell', 'bg=light', 'bg=dark', 'bg=auto'], a) },
  ...TOOL_CMDS.map(([names, tool, desc]): Cmd => ({ names, desc, run: () => {
    if (!canEdit() && tool !== 'select' && tool !== 'hand') return fail('E21: Cannot make changes, board is view-only');
    setTool(tool);
  } })),
  { names: ['image', 'img'], desc: 'Insert an image', run: () => { if (canEdit()) openImagePicker(); } },
  { names: ['color', 'colour'], usage: '{name}', desc: 'Colour the selection', run: (a) => {
    if (!COLORS.includes(a as ColorKey)) return fail(`E475: Unknown colour: ${a || '(none)'}. Try ${COLORS.join(', ')}`);
    if (!S.selected.size) return fail('Nothing selected');
    setColor(a as ColorKey);
  }, complete: (a) => filterPrefix(COLORS, a) },
  { names: ['shape'], usage: '{bubble|pill|box|decision}', desc: 'Change the selected shapes', run: (a) => {
    const k = SHAPE_NAMES[a];
    if (!k) return fail(`E475: Unknown shape: ${a || '(none)'}`);
    setShape(k);
  }, complete: (a) => filterPrefix(['bubble', 'pill', 'box', 'decision'], a) },
  { names: ['substitute', 's', '%s'], usage: '/pat/rep/[gi]', desc: 'Find & replace text (selection, or % for the whole board)', run: () => fail('Usage: :s/pattern/replacement/g  (or :%s for the whole board)') },
  { names: ['nohlsearch', 'noh'], desc: 'Forget the last search', run: () => { lastSearch = ''; } },
  { names: ['marks'], desc: 'List view marks', run: () => {
    const m = Object.keys(getMarks()).sort();
    if (m.length) message(`marks: ${m.join(' ')}`);
    else fail('E283: No marks set');
  } },
  { names: ['delmarks', 'delm'], usage: '{a-z} | !', desc: 'Delete view marks', run: (a, bang) => {
    if (bang) { saveMarks({}); return message('All marks deleted'); }
    const m = getMarks();
    for (const ch of a.replace(/\s/g, '')) delete m[ch];
    saveMarks(m);
  } },
  { names: ['share'], desc: 'Invite people', run: () => { if (ownerOnly()) $('share-btn').click(); } },
  { names: ['present'], desc: 'Start or stop presenting', run: () => { $('present-btn').click(); } },
  { names: ['browse', 'web'], usage: '[address or search]', desc: 'Browse a site together: everyone follows along', run: (a) => openBrowser(a) },
  { names: ['follow'], usage: '[name]', desc: 'Follow someone (no name: stop)', run: (a) => {
    if (!a) { follow(null); return; }
    const q = a.toLowerCase();
    const p = [...session.peers.values()].find((x) => x.id !== session.you?.id && x.name.toLowerCase().startsWith(q));
    if (!p) return fail(`Nobody called ${a} is here`);
    follow(p.id);
  }, complete: (a) => filterPrefix(peerNames(), a) },
  { names: ['export', 'exp'], desc: 'Export as PNG, PDF, SVG, Markdown or a brainboard file', run: () => openExport() },
  { names: ['screenshot', 'shot', 'snap'], desc: 'Take a screenshot: the screen, an area, the selection or a view', run: () => openScreenshot() },
  { names: ['media', 'shots'], desc: 'Open your screenshots', run: () => openMedia(undefined, openScreenshot) },
  { names: ['import', 'r', 'read'], desc: 'Import a board file', run: () => { if (ownerOnly()) $('file-board').click(); } },
  { names: ['clear', '%d', '%delete'], desc: 'Clear the board (undoable)', run: () => clearBoard() },
  { names: ['undo', 'u', 'un'], desc: 'Undo', run: () => undo() },
  { names: ['redo', 'red'], desc: 'Redo', run: () => redo() },
  { names: ['help', 'h', 'keys'], desc: 'Show all shortcuts', run: () => toggleShortcuts(true) },
];

function lookup(word: string): Cmd | undefined {
  const exact = COMMANDS.find((c) => c.names.includes(word));
  if (exact) return exact;
  const pre = COMMANDS.filter((c) => c.names[0].startsWith(word));
  return pre.length === 1 ? pre[0] : undefined;
}

async function runCommand(line: string) {
  const src = line.trim().replace(/^:+/, '');
  if (!src) return;
  const sub = /^(%)?s(?:u|ub|ubs|ubst|ubsti|ubstit|ubstitu|ubstitut|ubstitute)?([^\w\s"|])(.*)$/.exec(src);
  if (sub) return substitute(!!sub[1], sub[2] + sub[3]);
  const m = /^(%?[a-zA-Z]+)(!?)\s*(.*)$/.exec(src);
  if (!m) return fail(`E492: Not an editor command: ${src}`);
  const cmd = lookup(m[1]);
  if (!cmd) return fail(`E492: Not an editor command: ${src}`);
  try { await cmd.run(m[3].trim(), m[2] === '!'); } catch (e) { fail((e as Error).message); }
}

// ---------------------------------------------------------------- command line UI

let cmdKind: ':' | '/' = ':';
let searchOrigin: { sel: Set<string>; cam: { x: number; y: number; z: number } } | null = null;
const history: Record<string, string[]> = { ':': [], '/': [] };
let histIdx = -1;
let comps: { value: string; label: string; desc?: string }[] = [];
let compIdx = -1;
let compBase = '';

const input = () => $<HTMLInputElement>('cmd-input');

export function openCmdline(kind: ':' | '/', initial = '') {
  cmdKind = kind;
  closePopovers();
  $('cmd-prefix').textContent = kind;
  $('cmdline').hidden = false;
  document.body.classList.add('cmd-open');
  const el = input();
  el.value = initial;
  el.placeholder = kind === ':' ? 'command  ·  Tab completes  ·  :help' : 'search the board';
  histIdx = -1;
  $('cmd-count').textContent = '';
  if (kind === '/') searchOrigin = { sel: new Set(S.selected), cam: { ...S.cam } };
  else void loadBoards();
  el.focus();
  updateComps();
}

function closeCmdline() {
  $('cmdline').hidden = true;
  document.body.classList.remove('cmd-open');
  comps = [];
  renderComps();
  input().blur();
}

function cancel() {
  if (cmdKind === '/' && searchOrigin) {
    S.selected = searchOrigin.sel;
    requestRender();
    animateCam(searchOrigin.cam, 160);
  }
  searchOrigin = null;
  closeCmdline();
}

function submit() {
  const v = input().value;
  const kind = cmdKind;
  if (v.trim()) {
    const h = history[kind];
    if (h[h.length - 1] !== v) h.push(v);
  }
  closeCmdline();
  if (kind === ':') { void runCommand(v); return; }
  searchOrigin = null;
  if (!v) { if (lastSearch) searchNext(1); return; }
  lastSearch = v;
  const m = findMatch(v, 1, current());
  if (!m) return fail(`E486: Pattern not found: ${v}`);
  message(`/${v}  [${m.n}/${m.total}]`);
}

/** Incremental search: jump to the first match as you type. */
function incsearch() {
  if (!searchOrigin) return;
  const q = input().value;
  const count = $('cmd-count');
  if (!q) {
    S.selected = new Set(searchOrigin.sel);
    requestRender();
    count.textContent = '';
    return;
  }
  const from = readingOrder(S.items.filter((i) => searchOrigin!.sel.has(i.id)))[0];
  const m = findMatch(q, 1, from);
  count.textContent = m ? `${m.n}/${m.total}` : 'no match';
  count.classList.toggle('err', !m);
  if (!m) return;
  S.selected = new Set([m.it.id]);
  requestRender();
  const b = boxOf(m.it);
  if (b && userMovedCamera()) panIntoView(b);
}

function updateComps() {
  comps = [];
  compIdx = -1;
  if (cmdKind !== ':') return renderComps();
  const v = input().value.replace(/^:+/, '');
  compBase = v;
  const sp = v.search(/\s/);
  if (sp < 0) {
    const w = v;
    const seen = new Set<Cmd>();
    for (const c of COMMANDS) {
      const n = c.names.find((x) => x.startsWith(w) && /^[a-z]/.test(x));
      if (!n || seen.has(c)) continue;
      seen.add(c);
      comps.push({ value: c.names[0].startsWith(w) ? c.names[0] : n, label: `${c.names[0]}${c.usage ? ` ${c.usage}` : ''}`, desc: c.desc });
    }
    if (!w) comps = []; // nothing typed yet: keep it quiet
  } else {
    const cmd = lookup(v.slice(0, sp).replace(/!$/, ''));
    const arg = v.slice(sp).trimStart();
    if (cmd?.complete) comps = cmd.complete(arg).map((o) => ({ value: `${v.slice(0, sp)} ${o}`, label: o }));
  }
  comps = comps.slice(0, 8);
  renderComps();
}

function renderComps() {
  const el = $('wildmenu');
  el.innerHTML = comps.map((c, i) =>
    `<div class="wm ${i === compIdx ? 'on' : ''}"><span>${esc(c.label)}</span>${c.desc ? `<em>${esc(c.desc)}</em>` : ''}</div>`).join('');
  el.hidden = !comps.length;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function tabComplete(dir: 1 | -1) {
  if (!comps.length) return;
  compIdx = compIdx < 0 ? (dir > 0 ? 0 : comps.length - 1) : (compIdx + dir + comps.length) % comps.length;
  const c = comps[compIdx];
  // A single command-name match gets a trailing space so you can type its argument straight away.
  const isName = !/\s/.test(compBase);
  input().value = c.value + (isName && comps.length === 1 && COMMANDS.find((x) => x.names.includes(c.value))?.usage ? ' ' : '');
  renderComps();
  if (comps.length === 1) updateComps();
}

function onCmdKey(e: KeyboardEvent) {
  e.stopPropagation(); // keep Escape etc. away from the rest of the app
  const el = input();
  switch (e.key) {
    case 'Escape': e.preventDefault(); cancel(); return;
    case 'Enter': e.preventDefault(); submit(); return;
    case 'Tab': e.preventDefault(); tabComplete(e.shiftKey ? -1 : 1); return;
    case 'Backspace': if (!el.value) { e.preventDefault(); cancel(); } return;
    case 'ArrowUp': case 'ArrowDown': {
      e.preventDefault();
      const h = history[cmdKind];
      if (!h.length) return;
      histIdx = e.key === 'ArrowUp' ? (histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1)) : histIdx < 0 ? -1 : histIdx + 1;
      if (histIdx >= h.length) histIdx = -1;
      el.value = histIdx < 0 ? '' : h[histIdx];
      if (cmdKind === '/') incsearch(); else updateComps();
      return;
    }
  }
  if (e.ctrlKey && e.key === 'c') { e.preventDefault(); cancel(); }
}

// ---------------------------------------------------------------- normal-mode keys

type Fn = (e: KeyboardEvent) => void;

const ALWAYS: Record<string, Fn> = {
  ':': () => openCmdline(':'),
  ';': () => openCmdline(':'), // the popular `nnoremap ; :`
  '/': () => openCmdline('/'),
  u: () => undo(),
  x: () => { if (canEdit() && yankSelection()) deleteSelection(); },
  w: () => step(1),
  b: () => step(-1),
  G: () => edge(true),
  a: () => editAt('end'),
  A: () => editAt('end'),
};

const VIM: Record<string, Fn> = {
  h: () => move('h'), j: () => move('j'), k: () => move('k'), l: () => move('l'),
  H: () => panScreen('H'), J: () => panScreen('J'), K: () => panScreen('K'), L: () => panScreen('L'),
  e: () => step(1),
  i: () => editAt('start'), I: () => editAt('start'),
  s: () => editAt('all'), S: () => editAt('all'),
  o: () => { const c = current(); if (c && c.type !== 'edge') createSibling(c.id, 's'); },
  O: () => { const c = current(); if (c && c.type !== 'edge') createSibling(c.id, 'n'); },
  P: () => put(true),
  n: () => searchNext(1), N: () => searchNext(-1),
};

const SEQS: Record<string, Fn> = {
  gg: () => edge(false),
  gt: () => void cycleBoard(1),
  gT: () => void cycleBoard(-1),
  gv: openViews,
  yy: () => { const n = yankSelection(); if (n) message(`${n} item${n === 1 ? '' : 's'} yanked`); },
  zz: () => { if (selBounds && userMovedCamera()) centerOn(selBounds); },
  zi: () => { if (userMovedCamera()) zoomBy(1.25); },
  zo: () => { if (userMovedCamera()) zoomBy(0.8); },
};
const VIM_SEQS: Record<string, Fn> = {
  gp: () => put(false),
  dd: () => { if (canEdit() && yankSelection()) deleteSelection(); },
  cc: () => editAt('all'),
};
const PREFIXES = new Set(['g', 'y', 'z', 'm', "'", '`']);
const VIM_PREFIXES = new Set(['d', 'c']);

function clearPending() {
  pending = '';
  clearTimeout(pendTimer);
  showMode();
}

/** Returns true if the key was handled here. Called for unmodified keys outside text editing. */
export function vimKey(e: KeyboardEvent): boolean {
  const k = e.key;
  if (pending) {
    if (k === 'Shift') return true;
    const seq = pending + k;
    const p = pending;
    clearPending();
    if (k === 'Escape') return true;
    e.preventDefault();
    if (p === 'm') setMark(k);
    else if (p === "'" || p === '`') jumpMark(k);
    else (SEQS[seq] ?? (vimMode ? VIM_SEQS[seq] : undefined))?.(e);
    return true;
  }
  if (k.length !== 1) return false;
  if (PREFIXES.has(k) || (vimMode && VIM_PREFIXES.has(k))) {
    e.preventDefault();
    pending = k;
    clearTimeout(pendTimer);
    pendTimer = window.setTimeout(clearPending, 1500);
    showMode();
    return true;
  }
  const fn = (vimMode ? VIM[k] : undefined) ?? ALWAYS[k];
  if (!fn) return false;
  e.preventDefault();
  fn(e);
  return true;
}

// ---------------------------------------------------------------- wiring

export function initVim() {
  const el = input();
  el.addEventListener('keydown', onCmdKey);
  el.addEventListener('input', () => { if (cmdKind === '/') incsearch(); else updateComps(); });
  el.addEventListener('blur', () => { if (!$('cmdline').hidden) setTimeout(() => { if (document.activeElement !== el && !$('cmdline').hidden) cancel(); }, 0); });
  $('wildmenu').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rows = [...$('wildmenu').children];
    const i = rows.indexOf((e.target as Element).closest('.wm')!);
    if (i < 0) return;
    compIdx = i - 1;
    tabComplete(1);
  });

  const prev = hooks.afterRender;
  hooks.afterRender = () => { prev(); showMode(); };
  setVimMode(vimMode);
}
