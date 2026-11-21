// Which board is open, and where each board's camera was left (per viewer).
import { S } from './state';
import { applyCamera } from './render';
import { adoptDraft, api, events, joinBoard, leaveBoard, session, startDraft } from './net';
import { zoomToFit } from './actions';
import type { Camera } from './types';

const camKey = (id: string) => `bb-cam-${id}`;

export function restoreCamera(id: string) {
  try {
    const c = JSON.parse(localStorage.getItem(camKey(id)) ?? 'null') as Camera | null;
    if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) { S.cam = c; applyCamera(); return; }
  } catch { /* ignore */ }
  S.cam = { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
  applyCamera();
  if (S.items.length) zoomToFit();
}

let camTimer = 0;
export function saveCamera() {
  clearTimeout(camTimer);
  camTimer = window.setTimeout(() => {
    if (session.boardId) try { localStorage.setItem(camKey(session.boardId), JSON.stringify(S.cam)); } catch { /* ignore */ }
  }, 300);
}

const setHash = (id: string) => history.replaceState(null, '', `${location.pathname}${location.search}${id ? `#${id}` : ''}`);

/** Put the open board in the URL (once it has been worked on, or picked on purpose). */
export function showBoardInUrl() {
  if (session.boardId && location.hash.slice(1) !== session.boardId) setHash(session.boardId);
}
events.addEventListener('local-change', () => { if (session.draft) void ensureBoard(); else showBoardInUrl(); });

let creating: Promise<string | null> | null = null;

/**
 * Make sure there is a real board to work with. A blank draft becomes one on its first edit (or when
 * someone renames, shares, presents or talks on it). Resolves once connected, or after a few seconds.
 */
export function ensureBoard(): Promise<string | null> {
  if (session.boardId) return Promise.resolve(session.boardId);
  if (!session.draft) return Promise.resolve(null);
  creating ??= (async () => {
    try {
      const b = await api.createBoard(session.boardName || 'Untitled board');
      const welcomed = new Promise<void>((r) => {
        events.addEventListener('welcome', () => r(), { once: true });
        setTimeout(r, 4000);
      });
      adoptDraft(b.id);
      setHash(b.id);
      try { localStorage.setItem('bb-last-board', b.id); } catch { /* ignore */ }
      await welcomed;
      return b.id;
    } catch {
      creating = null;
      return null;
    }
  })();
  return creating;
}

/** Land on a blank, unsaved board (nothing is created until it's used). */
export function openDraft() {
  if (session.draft) return;
  leaveBoard();
  creating = null;
  setHash('');
  startDraft();
}

/** Open a board you own or were invited to. */
export function openBoard(id: string) {
  if (id === session.boardId) return;
  leaveBoard();
  setHash(id);
  if (!session.invite) try { localStorage.setItem('bb-last-board', id); } catch { /* ignore */ }
  joinBoard(id);
}

