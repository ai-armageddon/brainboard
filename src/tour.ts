// A small first-run tour: a card that steps through the main ideas and rings the relevant control.
import { account, canEdit, isOwner, session } from './net';
import { keyLabel } from './keys';

interface Step {
  target?: string; // CSS selector to ring; none = card floats above the toolbar
  title: string;
  body: string;
}

const SEEN = 'bb-tour-done';

function steps(): Step[] {
  const owner = isOwner() && !session.invite;
  const edit = canEdit();
  const list: Step[] = [];
  if (edit) {
    list.push(
      { target: '#toolbar', title: 'Pick a tool', body: 'Notes, text, a pen and shapes for flow charts. Hover a tool to see its one-key shortcut.' },
      { title: 'Paste and write anywhere', body: '<kbd>⌘V</kbd> drops in an image or text. Double-click empty space to start typing.' },
      { target: '#toolbar [data-tool="ellipse"]', title: 'Map a flow', body: 'Press <kbd>O</kbd> for a bubble, then <kbd>Tab</kbd> to grow a connected one. Drag a shape’s dot onto another to link them.' },
    );
  } else {
    list.push({ title: 'Look around', body: 'Scroll to pan. Pinch or <kbd>⌘</kbd>-scroll to zoom. This board is view-only for you.' });
  }
  if (owner) {
    list.push(
      { target: '#menu-btn', title: 'Your boards', body: 'Switch, rename and export boards here. Everything saves as you go.' },
      { target: '#share-btn', title: 'Invite people', body: 'Share a link that can edit or only view. Everyone’s cursor shows up live. All you need is a screen name.' },
    );
    if (!account.user) list.push({ target: '#save-btn', title: 'Keep your work', body: 'Boards live in this browser until you save them to a free account. With a passkey it takes one tap. <kbd>⌘S</kbd> works too.' });
  } else {
    list.push({ target: '#viewnav', title: 'Follow along', body: 'When others are here, choose Follow next to Views and pick a name to follow their camera.' });
  }
  list.push({ title: 'Keyboard first', body: 'Press <kbd>?</kbd> for every shortcut, or <kbd>:</kbd> for vim-style commands.' });
  return list;
}

let card: HTMLDivElement | null = null;
let ring: HTMLDivElement | null = null;
let list: Step[] = [];
let idx = 0;

export function tourSeen() {
  try { return localStorage.getItem(SEEN) === '1'; } catch { return true; }
}

export function startTour() {
  endTour(false);
  list = steps();
  idx = 0;
  card = document.createElement('div');
  card.id = 'tour';
  card.className = 'panel';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  ring = document.createElement('div');
  ring.id = 'tour-ring';
  document.body.append(ring, card);
  card.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-tour]')?.dataset.tour;
    if (act === 'next') go(1);
    else if (act === 'back') go(-1);
    else if (act === 'skip') endTour(true);
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  show();
}

function go(d: number) {
  const next = idx + d;
  if (next >= list.length) return endTour(true);
  if (next < 0) return;
  idx = next;
  show();
}

function onKey(e: KeyboardEvent) {
  if (!card || (e.target as Element)?.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  const map: Record<string, () => void> = {
    Escape: () => endTour(true),
    ArrowRight: () => go(1),
    Enter: () => go(1),
    ArrowLeft: () => go(-1),
  };
  const fn = map[e.key];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  fn();
}

function show() {
  if (!card) return;
  const s = list[idx];
  const last = idx === list.length - 1;
  card.innerHTML = `
    <div class="tour-top"><span class="tour-count">${idx + 1}/${list.length}</span><button class="tour-skip" data-tour="skip">${last ? 'Close' : 'Skip'}</button></div>
    <h4>${s.title}</h4>
    <p>${keyLabel(s.body)}</p>
    <div class="tour-foot">
      <div class="tour-dots">${list.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('')}</div>
      ${idx > 0 ? '<button class="tour-back" data-tour="back">Back</button>' : ''}
      <button class="tour-next" data-tour="next">${last ? 'Done' : 'Next'}</button>
    </div>`;
  card.classList.remove('in');
  void card.offsetWidth; // restart the entrance animation
  card.classList.add('in');
  place();
  card.querySelector<HTMLElement>('.tour-next')?.focus({ preventScroll: true });
}

function place() {
  if (!card || !ring) return;
  const s = list[idx];
  const t = s.target ? document.querySelector<HTMLElement>(s.target) : null;
  const tr = t?.getBoundingClientRect();
  const r = tr && tr.width > 0 && tr.height > 0 ? tr : null; // hidden targets have an empty box
  const cw = card.offsetWidth, ch = card.offsetHeight, m = 14;
  if (!r) {
    ring.hidden = true;
    const tb = document.getElementById('toolbar')!.getBoundingClientRect();
    card.style.left = `${Math.round((innerWidth - cw) / 2)}px`;
    card.style.top = `${Math.round(Math.max(m, tb.top - ch - 18))}px`;
    card.dataset.arrow = '';
    return;
  }
  ring.hidden = false;
  const pad = 5;
  Object.assign(ring.style, {
    left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
  });
  const below = r.top + r.height / 2 < innerHeight / 2;
  const top = below ? r.bottom + 16 : r.top - ch - 16;
  const left = Math.min(Math.max(m, r.left + r.width / 2 - cw / 2), innerWidth - cw - m);
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(Math.min(Math.max(m, top), innerHeight - ch - m))}px`;
  card.dataset.arrow = below ? 'up' : 'down';
  card.style.setProperty('--ax', `${Math.round(Math.min(Math.max(16, r.left + r.width / 2 - left), cw - 16))}px`);
}

export function endTour(markSeen: boolean) {
  if (markSeen) try { localStorage.setItem(SEEN, '1'); } catch { /* ignore */ }
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  card?.remove();
  ring?.remove();
  card = ring = null;
}
