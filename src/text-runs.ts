import type { EdgeItem, TextRun, TextualItem } from './types';

/** Walk plain and formatted spans once, including the unstyled prefix. */
export function* textSpans(text: string, runs: TextRun[] = []) {
  let style: TextRun = { at: 0 };
  for (const next of runs) {
    if (!next || !Number.isInteger(next.at) || next.at < style.at || next.at > text.length) continue;
    if (next.at > style.at) yield { style, start: style.at, end: next.at };
    style = next;
  }
  if (style.at < text.length) yield { style, start: style.at, end: text.length };
}

/** Plain-text edits from a board command keep the spans on the unchanged prefix and suffix. */
export function replaceItemText(it: TextualItem | EdgeItem, next: string) {
  const prev = it.type === 'edge' ? it.label : it.text;
  if (it.runs?.length && prev.length !== next.length) {
    let start = 0, oldEnd = prev.length, newEnd = next.length;
    while (start < oldEnd && start < newEnd && prev[start] === next[start]) start++;
    while (oldEnd > start && newEnd > start && prev[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
    const runs: TextRun[] = [];
    for (const run of it.runs) {
      let at = run.at;
      if (at >= oldEnd && at !== 0) at += newEnd - oldEnd;
      else if (at > start) at = newEnd;
      if (at >= next.length && at !== 0) continue;
      if (runs.at(-1)?.at === at) runs.pop();
      runs.push({ ...run, at });
    }
    it.runs = runs;
  }
  if (it.type === 'edge') it.label = next;
  else it.text = next;
}
