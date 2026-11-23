// Writing help: the browser's spellcheck in notes and labels, plus a suggested ending for the word being
// typed, shown as grey text at the caret. Tab or → accepts it. On by default; people can turn it off.
import { S } from './state';
import { hooks, textElOf, viewport, world } from './render';
import { readEditor } from './format';
import { collectWords, completion, parseDictionary, type BoardWords, type Dictionary } from './predict';

const KEY = 'bb-writing-help';
let on = true;
try { on = localStorage.getItem(KEY) !== '0'; } catch { /* ignore */ }

export const isWritingHelp = () => on;

export function setWritingHelp(next: boolean) {
  on = next;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  const label = document.getElementById('writing-label');
  if (label) label.textContent = on ? 'On' : 'Off';
  const editor = S.editing ? textElOf(S.editing) : null;
  if (editor) prepareEditor(editor);
  refreshSuggestion();
}

/** A phone or tablet keyboard already suggests words above its keys, and has no Tab to accept ours. */
const onScreenKeyboard = matchMedia('(hover: none) and (pointer: coarse)').matches;

let dict: Dictionary | null = null;
let loading: Promise<void> | null = null;
function loadDictionary() {
  loading ??= import('./words.txt?raw')
    .then((file) => { dict = parseDictionary(file.default); refreshSuggestion(); })
    .catch(() => { loading = null; });
}

/** Words in every other item, gathered when editing starts. The item being typed in is read as it changes. */
let elsewhere: BoardWords = new Map();

/** Call just before a note, shape or label becomes editable. */
export function prepareEditor(editor: HTMLElement) {
  editor.spellcheck = on;
  editor.setAttribute('autocorrect', on ? 'on' : 'off');
  if (!on || onScreenKeyboard) return;
  loadDictionary();
  elsewhere = collectWords(S.items.map((it) => (it.id === S.editing ? '' : it.type === 'edge' ? it.label : 'text' in it ? it.text : '')));
}

// ---------------------------------------------------------------- the word at the caret

/** Characters that make the letters after them part of something longer, like an address or a file name. */
const JOINED = /[\p{L}\p{N}'’_@./\\#:]/u;
const TYPED = /\p{L}+$/u;

const breaksLine = (n: Node) => n instanceof HTMLElement && /^(BR|DIV|P)$/.test(n.tagName);

/** The character next to a text node on the same line, or '' where the line stops. */
function beside(root: Node, node: Node, forward: boolean): string {
  const sibling = (n: Node) => (forward ? n.nextSibling : n.previousSibling);
  const child = (n: Node) => (forward ? n.firstChild : n.lastChild);
  let n = node;
  for (;;) {
    while (!sibling(n)) {
      const up = n.parentNode;
      if (!up || up === root || breaksLine(up)) return '';
      n = up;
    }
    n = sibling(n)!;
    while (!breaksLine(n) && child(n)) n = child(n)!;
    if (breaksLine(n)) return '';
    if (n instanceof Text && n.length) return forward ? n.data[0] : n.data[n.length - 1];
  }
}

/** The unfinished word just before the caret, when the caret is at the end of its line. */
function typedWord(root: HTMLElement): { node: Text; offset: number; typed: string } | null {
  const sel = getSelection();
  if (!sel || !sel.isCollapsed || !sel.rangeCount) return null;
  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!(node instanceof Text) || !root.contains(node)) return null;
  const after = offset < node.length ? node.data[offset] : beside(root, node, true);
  if (after && after !== '\n') return null;
  const typed = TYPED.exec(node.data.slice(0, offset))?.[0];
  if (!typed) return null;
  const before = typed.length < offset ? node.data[offset - typed.length - 1] : beside(root, node, false);
  if (JOINED.test(before)) return null;
  return { node, offset, typed };
}

// ---------------------------------------------------------------- the grey suggestion

const ghost = document.createElement('div');
ghost.id = 'ghost';
ghost.hidden = true;
ghost.setAttribute('aria-hidden', 'true');
const ghostText = document.createElement('span');
const ghostKey = document.createElement('kbd');
ghostKey.textContent = 'Tab';
ghost.append(ghostText, ghostKey);

/** What accepting would write, and where: `text` replaces the `typed` letters before the caret. */
let offer: { node: Text; offset: number; typed: number; text: string } | null = null;
let composing = false;

function place() {
  if (!offer) return;
  const { node, offset } = offer;
  if (!node.isConnected || offset > node.length || !node.parentElement) { clear(); return; }
  const lastLetter = document.createRange();
  lastLetter.setStart(node, offset - 1);
  lastLetter.setEnd(node, offset);
  const box = [...lastLetter.getClientRects()].at(-1);
  if (!box || !box.height) { clear(); return; }
  const { x, y, z } = S.cam;
  const from = getComputedStyle(node.parentElement);
  const st = ghost.style;
  st.transform = `translate(${(box.right - x) / z}px,${(box.top - y) / z}px)`;
  st.height = st.lineHeight = `${box.height / z}px`;
  st.fontFamily = from.fontFamily;
  st.fontSize = from.fontSize;
  st.fontWeight = from.fontWeight;
  st.fontStyle = from.fontStyle;
  st.letterSpacing = from.letterSpacing;
  st.color = from.color;
  ghost.hidden = false;
}

function clear() {
  offer = null;
  ghost.hidden = true;
}

export function refreshSuggestion() {
  const editor = on && !onScreenKeyboard && !composing && S.editing ? textElOf(S.editing) : null;
  const at = editor && typedWord(editor);
  if (!editor || !at) { clear(); return; }
  // Words written earlier in this same note count too, except the unfinished one at the caret.
  const here = collectWords([readEditor(editor).text]);
  const key = at.typed.toLowerCase();
  const unfinished = here.get(key);
  if (unfinished && --unfinished.count === 0) here.delete(key);
  const guess = completion(at.typed, [elsewhere, here], dict);
  if (!guess) { clear(); return; }
  offer = { node: at.node, offset: at.offset, typed: at.typed.length, text: guess.start + guess.rest };
  ghostText.textContent = guess.rest;
  place();
}

/** Finish the word with the suggestion on screen. Returns false when there isn't one. */
export function acceptSuggestion(): boolean {
  refreshSuggestion();
  if (!offer) return false;
  const { node, offset, typed, text } = offer;
  clear();
  // Rewrite the word from its first letter, so a name picks up its capitals in the same undo step.
  getSelection()?.setBaseAndExtent(node, offset - typed, node, offset);
  document.execCommand('insertText', false, text);
  return true;
}

export function initWriting() {
  world.append(ghost);
  setWritingHelp(on);
  viewport.addEventListener('input', refreshSuggestion);
  document.addEventListener('selectionchange', () => { if (S.editing || offer) refreshSuggestion(); });
  viewport.addEventListener('compositionstart', () => { composing = true; clear(); });
  viewport.addEventListener('compositionend', () => { composing = false; refreshSuggestion(); });
  // The text can move under the suggestion without a keystroke: someone drags the note, or it reflows.
  const afterRender = hooks.afterRender;
  hooks.afterRender = () => {
    afterRender();
    if (!offer) return;
    if (S.editing) place();
    else clear();
  };
}
