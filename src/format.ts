import { FONTS, type FontKey, type TextRun } from './types';
import { textSpans } from './text-runs';

export type TextStyle = Omit<TextRun, 'at'>;
export const sameStyle = (a: TextStyle, b: TextStyle) =>
  a.bold === b.bold && a.underline === b.underline && a.font === b.font;

export function appendStyle(runs: TextRun[], at: number, style: TextStyle) {
  if (!sameStyle(runs.at(-1) ?? {}, style)) runs.push({ at, ...style });
}

const fontName = (name: string) => name.split(',')[0].trim().replace(/["']/g, '').toLowerCase();
const fontKeys = new Map(Object.entries(FONTS).map(([id, [, stack]]) => [fontName(stack), id as FontKey]));

/** Read only the three styles Brainboard supports. No editor HTML is stored. */
export function readEditor(root: HTMLElement) {
  const runs: TextRun[] = [];
  if (!root.childElementCount) return { text: root.textContent.replace(/\n+$/, ''), runs };
  let text = '';
  function walk(node: Node, style: TextStyle) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) {
        appendStyle(runs, text.length, style);
        text += node.nodeValue;
      }
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      if (node.nextSibling || node.previousSibling) text += '\n';
      return;
    }
    const next = { ...style };
    const weight = node.style.fontWeight;
    if (weight) next.bold = weight === 'bold' || Number(weight) >= 600 || undefined;
    else if (node.matches('b,strong')) next.bold = true;
    if (node.matches('u') || node.style.textDecoration.includes('underline')) next.underline = true;
    const face = node.getAttribute('face') || node.style.fontFamily;
    if (face) next.font = fontKeys.get(fontName(face));
    let afterBlock = false;
    for (const child of node.childNodes) {
      const block = child instanceof HTMLElement && child.matches('div,p');
      if (child.previousSibling && (block || afterBlock)) text += '\n';
      walk(child, next);
      afterBlock = block;
    }
  }
  walk(root, {});
  text = text.replace(/\n+$/, '');
  while (runs.length && runs.at(-1)!.at >= text.length) runs.pop();
  return { text, runs };
}

const drawn = new WeakMap<HTMLElement, { text: string; runs?: TextRun[] }>();

export function drawText(root: HTMLElement, text: string, runs?: TextRun[]) {
  const prev = drawn.get(root);
  if (prev?.text === text && prev.runs === runs) return;
  drawn.set(root, { text, runs });
  if (!Array.isArray(runs) || !runs.length) {
    root.textContent = text;
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const { style: run, start, end } of textSpans(text, runs)) {
    let node: Node = document.createTextNode(text.slice(start, end));
    const wrap = (tag: string) => { const el = document.createElement(tag); el.append(node); node = el; return el; };
    if (run.bold) wrap('b');
    if (run.underline) wrap('u');
    if (run.font && Object.hasOwn(FONTS, run.font)) wrap('font').setAttribute('face', FONTS[run.font][1]);
    fragment.append(node);
  }
  root.replaceChildren(fragment);
}

export function editorFont(): FontKey {
  return fontKeys.get(fontName(document.queryCommandValue('fontName') || '')) ?? 'geist';
}

export function forgetDrawnText(root: HTMLElement) { drawn.delete(root); }
