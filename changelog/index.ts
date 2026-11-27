// The changelog page. It stays short however long the history gets:
//   - only the newest release is open, and it shows its highlights, not every line
//   - older releases are one row each, and their contents are built when opened
//   - only the latest few rows are listed until you ask for more
//   - filtering by area or by text shows just the matching lines
// Highlights come from src/releases.json (shared with the in-app "What's new"); the full list of
// changes lives in history.json, which only this page loads.
import { releases } from '../src/releases';
import history from './history.json';

type Past = { version: string; date: string; title?: string; highlights?: string[]; changes: Record<string, string[]> };
type Entry = { version: string; date?: string; title: string; highlights: string[]; changes: Record<string, string[]> };
type Groups = [area: string, lines: string[]][];

const PAGE = 5; // releases listed before "Show older"

// Each release has its own set of areas, which TypeScript reads as many different shapes.
const past = history as unknown as Past[];
const log: Entry[] = [
  // A release that has notes but no detailed history yet still gets a row.
  ...releases.filter((r) => !past.some((p) => p.version === r.version)).map((r) => ({ version: r.version, title: r.title, highlights: r.changes, changes: {} })),
  ...past.map((p) => {
    const notes = releases.find((r) => r.version === p.version);
    return { version: p.version, date: p.date, title: notes?.title ?? p.title ?? '', highlights: notes?.changes ?? p.highlights ?? [], changes: p.changes };
  }),
];
const areas = [...new Set(log.flatMap((e) => Object.keys(e.changes)))];
const size = (list: Groups) => list.reduce((n, [, lines]) => n + lines.length, 0);
const total = (e: Entry) => size(Object.entries(e.changes));

const state = { area: '', query: '', shown: PAGE };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso?: string) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/** The lines of a release that pass the current filter, by area. */
function matching(e: Entry): Groups {
  const q = state.query.toLowerCase();
  return Object.entries(e.changes)
    .filter(([area]) => !state.area || area === state.area)
    .map(([area, lines]): Groups[number] => [area, q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines])
    .filter(([, lines]) => lines.length);
}

function groups(list: Groups) {
  const box = el('div', 'groups');
  for (const [area, lines] of list) {
    box.append(el('h3', '', area));
    const ul = el('ul');
    for (const line of lines) ul.append(el('li', '', line));
    box.append(ul);
  }
  return box;
}

/** What a release shows when opened: its highlights, with every change one more click away. */
function body(e: Entry) {
  const box = el('div', 'body');
  if (e.highlights.length) {
    const ul = el('ul', 'highlights');
    for (const line of e.highlights) ul.append(el('li', '', line));
    box.append(ul);
  }
  const n = total(e);
  if (n) {
    const all = el('details', 'all');
    all.append(el('summary', '', `All ${count(n, 'update')}`));
    all.addEventListener('toggle', () => { if (all.open && all.childElementCount === 1) all.append(groups(Object.entries(e.changes))); });
    box.append(all);
  }
  return box;
}

/** One release. With `found` (a filter is on) it is open and lists just those lines. */
function row(e: Entry, found?: Groups) {
  const item = el('details', 'release');
  item.id = `v${e.version}`;
  const head = el('summary');
  const tally = found ? count(size(found), 'match', 'matches') : total(e) ? count(total(e), 'update') : '';
  head.append(el('span', 'ver', `v${e.version}`), el('span', 'title', e.title), el('span', 'meta', [day(e.date), tally].filter(Boolean).join(' · ')));
  item.append(head);
  if (found) {
    item.open = true;
    item.append(groups(found));
  } else {
    item.addEventListener('toggle', () => { if (item.open && item.childElementCount === 1) item.append(body(e)); });
  }
  return item;
}

const root = document.querySelector<HTMLElement>('#releases')!;

function render() {
  root.replaceChildren();
  if (state.area || state.query) {
    const hits = log.map((e) => ({ e, found: matching(e) })).filter((h) => h.found.length);
    for (const h of hits) root.append(row(h.e, h.found));
    if (!hits.length) root.append(el('p', 'empty', 'No updates match your filters.'));
    return;
  }
  log.slice(0, state.shown).forEach((e, i) => {
    const item = row(e);
    root.append(item);
    if (i === 0) item.open = true; // fires toggle, which builds its body
  });
  const rest = log.length - state.shown;
  if (rest > 0) {
    const more = el('button', 'more', `Show ${count(Math.min(rest, PAGE), 'older release')}`);
    more.type = 'button';
    more.addEventListener('click', () => { state.shown += PAGE; render(); });
    root.append(more);
  }
}

// ---------------------------------------------------------------- filter bar

const chips = document.querySelector<HTMLElement>('#areas')!;
const search = document.querySelector<HTMLInputElement>('#search')!;

function setFilter(area: string, query: string) {
  state.area = area;
  state.query = query;
  for (const c of chips.children) c.setAttribute('aria-pressed', String((c as HTMLElement).dataset.area === area));
  render();
}

for (const area of ['', ...areas]) {
  const chip = el('button', 'chip', area || 'All');
  chip.type = 'button';
  chip.dataset.area = area;
  chip.setAttribute('aria-pressed', String(area === ''));
  chip.addEventListener('click', () => setFilter(area, state.query));
  chips.append(chip);
}
search.addEventListener('input', () => setFilter(state.area, search.value.trim()));
document.querySelector('#stats')!.textContent = `${count(log.length, 'release')} · ${count(log.reduce((n, e) => n + total(e), 0), 'update')}`;

// A link to #v0.3.0 opens that release, even if it sits under "Show older".
function openFromHash() {
  const i = log.findIndex((e) => `#v${e.version}` === location.hash);
  if (i < 0) return;
  state.shown = Math.max(state.shown, i + 1);
  search.value = '';
  setFilter('', ''); // a link to a release shows that release, whatever was being filtered
  const item = document.getElementById(location.hash.slice(1)) as HTMLDetailsElement | null;
  if (!item) return;
  item.open = true;
  item.scrollIntoView({ block: 'start' });
}

render();
openFromHash();
addEventListener('hashchange', openFromHash);
