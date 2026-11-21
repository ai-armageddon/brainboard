// The boards screen: what's live now, what you opened recently, what was shared with you, and all your boards.
// It only ever lists boards you own or that were shared with you (a link you opened, or an invite to your account).
import { avatarFace } from './avatar';
import { account, api, session, type BoardMeta, type LivePerson, type SharedBoard } from './net';
import { openBoard, openedAt } from './boards';
import { closePopovers, newBoard } from './ui';
import { icon } from './icons';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function ago(iso: string | number) {
  const s = (Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

type Entry =
  | { kind: 'own'; b: BoardMeta; people: LivePerson[]; seen: number }
  | { kind: 'shared'; b: SharedBoard; people: LivePerson[]; seen: number };

let owned: BoardMeta[] = [];
let shared: SharedBoard[] = [];
let query = '';
let refreshTimer = 0;

/** Leave yourself out of "who's here" on the board you're on. */
function others(id: string, people: LivePerson[] = []) {
  if (id !== session.boardId || !session.you) return people;
  const i = people.findIndex((p) => p.name === session.you!.name && p.color === session.you!.color);
  return i < 0 ? people : people.filter((_, j) => j !== i);
}

function entries(): Entry[] {
  const opened = openedAt();
  return [
    ...owned.map((b): Entry => ({ kind: 'own', b, people: others(b.id, b.people), seen: Math.max(opened[b.id] ?? 0, Date.parse(b.updated) || 0) })),
    ...shared.map((b): Entry => ({
      kind: 'shared', b, people: others(b.id, b.people),
      seen: Math.max(opened[b.id] ?? 0, Date.parse(b.lastHere ?? '') || 0, Date.parse(b.updated) || 0),
    })),
  ];
}

const matches = (e: Entry) => !query || e.b.name.toLowerCase().includes(query);

function faces(people: LivePerson[]) {
  if (!people.length) return '';
  const shown = people.slice(0, 4).map((p) => `<b style="--c:${esc(p.color)}" title="${esc(p.name)}">${avatarFace(p.name, p.picture)}</b>`).join('');
  return `<span class="hc-live"><span class="hc-faces">${shown}</span><i class="live-dot"></i>${people.length} here</span>`;
}

function card(e: Entry) {
  const cur = e.b.id === session.boardId ? ' current' : '';
  const meta = e.kind === 'own'
    ? `${ago(e.b.updated)} · ${e.b.itemCount} item${e.b.itemCount === 1 ? '' : 's'}`
    : `${e.b.from ? `From ${esc(e.b.from)} · ` : ''}${e.b.role === 'editor' ? 'Can edit' : 'Can view'}`;
  return `<button class="home-card${cur}" data-id="${esc(e.b.id)}" data-kind="${e.kind}">
    <span class="hc-name">${esc(e.b.name)}</span>
    <span class="hc-meta">${meta}</span>
    ${faces(e.people)}
    ${e.kind === 'shared' ? `<span class="hc-tag">${icon('users', 13)}Shared</span>` : ''}
    ${cur ? '<span class="hc-tag here">Open now</span>' : ''}
  </button>`;
}

function render() {
  const body = $('home').querySelector<HTMLElement>('.home-body')!;
  const all = entries();
  const live = all.filter((e) => e.people.length && matches(e)).sort((a, b) => b.people.length - a.people.length);
  const recent = all.filter(matches).sort((a, b) => b.seen - a.seen).slice(0, 6);
  const sharedE = all.filter((e) => e.kind === 'shared' && matches(e)).sort((a, b) => b.seen - a.seen);
  const mine = all.filter((e): e is Extract<Entry, { kind: 'own' }> => e.kind === 'own' && matches(e))
    .sort((a, b) => Date.parse(b.b.updated) - Date.parse(a.b.updated));
  const signedOut = !account.user && !session.invite;
  const section = (title: string, count: number | null, inner: string, cls = '') =>
    `<section class="${cls}"><h3>${title}${count !== null ? ` <span class="count">${count}</span>` : ''}</h3>${inner}</section>`;

  body.querySelector('.home-sections')!.innerHTML = [
    live.length ? section(`<i class="live-dot"></i>Live now`, live.length, `<div class="home-grid">${live.map(card).join('')}</div>`, 'home-live') : '',
    recent.length && !query ? section('Recent', null, `<div class="home-grid">${recent.map(card).join('')}</div>`) : '',
    section('Shared with you', sharedE.length, sharedE.length
      ? `<div class="home-grid">${sharedE.map(card).join('')}</div>`
      : `<p class="muted small">${query ? 'No shared boards match.' : `Nothing shared with you yet. Boards show up here when you open someone’s invite link, or when they invite your account’s email.${signedOut ? ' Sign in so they follow you to your other devices.' : ''}`}</p>`),
    section('All your boards', mine.length, mine.length
      ? `<div class="home-list">${mine.map((e) => `
          <button class="home-row${e.b.id === session.boardId ? ' current' : ''}" data-id="${esc(e.b.id)}" data-kind="own">
            <span class="hr-name">${esc(e.b.name)}</span>
            ${e.people.length ? `<span class="hr-live"><i class="live-dot"></i>${e.people.length} here</span>` : ''}
            <span class="hr-meta">${e.b.itemCount} item${e.b.itemCount === 1 ? '' : 's'} · ${ago(e.b.updated)}</span>
          </button>`).join('')}</div>`
      : `<p class="muted small">${query ? 'No boards match.' : 'No boards yet. Anything you add to a blank board saves it here.'}</p>`),
  ].join('');
}

async function load() {
  try {
    [owned, shared] = await Promise.all([api.boards().catch(() => []), api.shared().catch(() => [])]);
  } catch { /* keep what we have */ }
  if (!$('home').hidden) render();
}

function go(id: string, kind: string) {
  if (id === session.boardId) return closeHome();
  if (kind === 'shared') {
    const b = shared.find((x) => x.id === id);
    if (!b) return;
    // Guest boards open through their invite (a fresh page, so the guest flow and permissions apply).
    location.href = `/?invite=${encodeURIComponent(b.token)}#${id}`;
    return;
  }
  const b = owned.find((x) => x.id === id);
  closeHome();
  // From a guest page, your own boards need a clean page (no invite).
  if (session.invite) { location.href = `/#${id}`; return; }
  openBoard(id, b?.name);
}

export function openHome() {
  closePopovers();
  const el = $('home');
  el.hidden = false;
  query = '';
  const input = el.querySelector<HTMLInputElement>('.home-search')!;
  input.value = '';
  render();
  void load();
  setTimeout(() => input.focus(), 0);
  clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => { if (el.hidden) clearInterval(refreshTimer); else void load(); }, 15_000);
}

export function closeHome() {
  $('home').hidden = true;
  clearInterval(refreshTimer);
}

export function initHome() {
  const el = $('home');
  el.querySelector('.home-body')!.innerHTML = `
    <div class="home-top">
      <input class="home-search" type="search" placeholder="Search boards" aria-label="Search boards" />
      ${session.invite ? '' : `<button class="primary home-new">${icon('plus', 16)} New board</button>`}
    </div>
    <div class="home-sections"></div>`;
  el.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t === el || t.closest('.close')) return closeHome();
    if (t.closest('.home-new')) { closeHome(); void newBoard(); return; }
    const b = t.closest<HTMLElement>('[data-id]');
    if (b) go(b.dataset.id!, b.dataset.kind!);
  });
  el.querySelector<HTMLInputElement>('.home-search')!.addEventListener('input', (e) => {
    query = (e.target as HTMLInputElement).value.trim().toLowerCase();
    render();
  });
  el.querySelector<HTMLInputElement>('.home-search')!.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Enter opens the first match.
    const first = el.querySelector<HTMLElement>('.home-sections [data-id]');
    if (first) go(first.dataset.id!, first.dataset.kind!);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) { e.preventDefault(); closeHome(); return; }
    // ⌥B: boards
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyB') {
      const typing = (e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');
      if (typing && el.hidden) return;
      e.preventDefault();
      if (el.hidden) openHome(); else closeHome();
    }
  });
}
