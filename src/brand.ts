// Brainboard mark: a lowercase "b" whose bowl is a thought-bubble, with a connected idea-spark.
let n = 0;

export function logoSvg(size = 32): string {
  const id = `bbg${n++}`;
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#9a5cf5"/></linearGradient></defs>
  <rect width="32" height="32" rx="9" fill="url(#${id})"/>
  <path d="M10.4 7.6V18.4" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="16.4" cy="18.4" r="6" fill="none" stroke="#fff" stroke-width="3.4"/>
  <path d="M20.6 13.9 22.5 11" stroke="#fff" stroke-opacity=".75" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="23.9" cy="8.6" r="2.5" fill="#fff" fill-opacity=".92"/>
</svg>`;
}

/** Fill every `.logo` placeholder in the page (and any added later via `root`). */
export function paintLogos(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.logo:empty').forEach((el) => {
    el.innerHTML = logoSvg();
  });
}

export const WORDMARK = '<span class="wordmark">brain<span>board</span></span>';
