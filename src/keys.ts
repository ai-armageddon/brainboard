// Shortcut labels are written the Mac way (⌘Z, ⌥N, ⇧⌘E). On Windows and Linux they read Ctrl+Z, Alt+N, Ctrl+Shift+E.
// The handlers already accept either: ⌘ shortcuts check metaKey || ctrlKey, and ⌥ shortcuts check altKey (Option = Alt).

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const NAMES: Record<string, string> = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
const ORDER = ['Ctrl', 'Alt', 'Shift'];

/** A Mac shortcut label for this platform. Works on plain text and on HTML strings. */
export function keyLabel(s: string): string {
  if (IS_MAC) return s;
  return s.replaceAll('⌫', 'Del').replace(/([⌘⌃⌥⇧]+)(.?)/gu, (_, mods: string, next: string) => {
    const names = [...new Set([...mods].map((m) => NAMES[m]))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    // ⌘Z → Ctrl+Z, but "⌘-drag", "⌘ + scroll" and a lone <kbd>⌘</kbd> keep what follows as it is.
    return names.join('+') + (next && !/[\s\-–<]/.test(next) ? `+${next}` : next);
  });
}

const ATTRS = ['data-tip', 'data-vim-tip', 'title', 'aria-label'];
const GLYPH = /[⌘⌃⌥⇧⌫]/;

/** Rewrite every shortcut label under `root`: text and tooltip attributes. */
export function localizeKeys(root: ParentNode = document.body) {
  if (IS_MAC) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (GLYPH.test(n.nodeValue!)) n.nodeValue = keyLabel(n.nodeValue!);
  }
  for (const el of root.querySelectorAll<HTMLElement>(ATTRS.map((a) => `[${a}]`).join(','))) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && GLYPH.test(v)) el.setAttribute(a, keyLabel(v));
    }
  }
}
