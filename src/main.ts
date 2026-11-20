import './style.css';
import { loadPrefs, requestRender } from './state';
import { applyCamera, render } from './render';
import { buildUI, showOverlay, updateToolUI } from './ui';
import { initInput } from './input';
import { api, events, session } from './net';
import { openBoard, restoreCamera } from './boards';
import { blobGet, kvGet, kvSet } from './db';
import type { Item } from './types';

/** One-time move of a board saved by the earlier browser-only version. */
async function migrateFromBrowser(): Promise<boolean> {
  try {
    if (await kvGet('migrated')) return false;
    const old = await kvGet<{ items: Item[] }>('board');
    if (!old?.items?.length) return false;
    for (const it of old.items) {
      if (it.type !== 'image') continue;
      const b = await blobGet(it.blob);
      if (b) await api.uploadImage(b, it.blob);
    }
    await api.createBoard('My board', old.items);
    await kvSet('migrated', true);
    return true;
  } catch (err) {
    console.warn('brainboard: migration skipped', err);
    return false;
  }
}

async function main() {
  loadPrefs();
  buildUI();
  initInput();
  updateToolUI();
  applyCamera();
  render();
  document.body.classList.add('ready');

  events.addEventListener('welcome', (e) => {
    if ((e as CustomEvent<boolean>).detail && session.boardId) restoreCamera(session.boardId);
    requestRender();
  });

  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  const hashId = location.hash.slice(1);

  if (invite) {
    // Guest: only this one board.
    session.invite = invite;
    document.body.classList.add('guest');
    try {
      await api.me(hashId);
    } catch {
      showOverlay('invalid');
      return;
    }
    showOverlay('join', () => openBoard(hashId));
    return;
  }

  let boards;
  try {
    boards = await api.boards();
  } catch {
    showOverlay('offline');
    return;
  }
  if (!boards.length) {
    await migrateFromBrowser();
    boards = await api.boards();
    if (!boards.length) boards = [await api.createBoard('My board')];
  }
  let last: string | null = null;
  try { last = localStorage.getItem('bb-last-board'); } catch { /* ignore */ }
  const id = boards.find((b) => b.id === hashId)?.id ?? boards.find((b) => b.id === last)?.id ?? boards[0].id;
  openBoard(id);

  window.addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (next && next !== session.boardId) openBoard(next);
  });
}

void main();
