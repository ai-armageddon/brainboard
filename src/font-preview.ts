// Preview in a separate layer so the editor selection and the board's measured bounds stay intact.
import { textElOf } from './render';
import { S } from './state';
import { FONTS, type FontKey } from './types';

const layers = new Map<HTMLElement, HTMLElement>();

function markRange(source: Node, copy: Node, range: Range) {
  if (!range.intersectsNode(source)) return;
  if (source.nodeType === Node.TEXT_NODE) {
    const start = source === range.startContainer ? range.startOffset : 0;
    const end = source === range.endContainer ? range.endOffset : (source as Text).length;
    if (start === end) return;
    const part = document.createRange();
    part.setStart(copy, start);
    part.setEnd(copy, end);
    const span = document.createElement('span');
    span.className = 'font-preview-run';
    part.surroundContents(span);
    return;
  }
  // Walk backwards because wrapping a text node can add siblings to the copy.
  for (let i = source.childNodes.length - 1; i >= 0; i--) markRange(source.childNodes[i], copy.childNodes[i], range);
}

export function previewFont(font: FontKey) {
  if (!layers.size) {
    const selection = getSelection();
    const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    for (const id of S.selected) {
      const source = textElOf(id);
      if (!source || !source.textContent) continue;
      const copy = source.cloneNode(true) as HTMLElement;
      copy.className = 'txt font-preview';
      copy.contentEditable = 'false';
      copy.inert = true;
      copy.setAttribute('aria-hidden', 'true');
      if (id === S.editing && range && source.contains(range.commonAncestorContainer)) markRange(source, copy, range);
      else copy.classList.add('font-preview-all');
      copy.style.left = `${source.offsetLeft}px`;
      copy.style.top = `${source.offsetTop}px`;
      copy.style.width = source.closest('.note, .shape') ? getComputedStyle(source).width : 'max-content';
      source.after(copy);
      source.classList.add('font-preview-source');
      layers.set(source, copy);
    }
  }
  for (const layer of layers.values()) layer.style.setProperty('--preview-font', FONTS[font][1]);
}

export function clearFontPreview() {
  for (const [source, layer] of layers) {
    source.classList.remove('font-preview-source');
    layer.remove();
  }
  layers.clear();
}
