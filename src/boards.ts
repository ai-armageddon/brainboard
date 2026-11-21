// Which board is open, and where each board's camera was left (per viewer).
import { S } from './state';
import { applyCamera } from './render';
import { events, joinBoard, leaveBoard, session } from './net';
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
events.addEventListener('local-change', showBoardInUrl);

/**
 * Open a board. `quiet` is for the board picked automatically on landing:
 * the URL stays clean until the user changes something.
 */
export function openBoard(id: string, { quiet = false } = {}) {
  if (id === session.boardId) return;
  leaveBoard();
  if (!quiet) setHash(id);
  else if (location.hash && location.hash.slice(1) !== id) setHash('');
  if (!session.invite) try { localStorage.setItem('bb-last-board', id); } catch { /* ignore */ }
  joinBoard(id);
}

