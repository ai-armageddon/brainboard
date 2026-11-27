import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import { paintLogos } from './brand';
import { initVim } from './vim';
import { initAccount } from './account';
import { initVoice } from './voice';
import { startFirstTour, tourSeen } from './tour';
import { loadPrefs, requestRender } from './state';
import { applyCamera, render } from './render';
import { buildUI, showOverlay, updateToolUI } from './ui';
import { initInput } from './input';
import { api, events, loadSession, session } from './net';
import { openBoard, openDraft, restoreCamera } from './boards';
import { initCollab } from './collab';
import { initInk } from './ink';
import { initHome, loadBoards } from './home';
import { initViews } from './views';
import { initBoardAreas } from './board-areas';
import { initWriting } from './writing';
import { initScreenshot } from './screenshot';
import { initBrowse } from './browse';
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

let tourStarted = false;

async function main() {
  loadPrefs();
  paintLogos();
  buildUI();
  initCollab();
  initInk();
  initHome();
  initViews();
  initBoardAreas();
  initScreenshot();
  initVim();
  initWriting();
  initAccount();
  initVoice();
  initBrowse();
  initInput();
  updateToolUI();
  applyCamera();
  render();
  document.body.classList.add('ready');

  events.addEventListener('welcome', (e) => {
    if ((e as CustomEvent<boolean>).detail && session.boardId) restoreCamera(session.boardId);
    document.body.classList.add('loaded');
    requestRender();
    if (!tourSeen() && !tourStarted) {
      tourStarted = true;
      setTimeout(startFirstTour, 900);
    }
  });

  // Who are we? (Also hands this browser an anonymous identity, so nobody has to sign in.)
  try {
    await loadSession();
  } catch {
    showOverlay('offline');
    return;
  }

  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  const hashId = location.hash.slice(1);

  if (invite) {
    // Guest: only this one board.
    session.invite = invite;
    document.body.classList.add('guest');
    let details;
    try {
      details = await api.me(hashId);
    } catch {
      showOverlay('invalid');
      return;
    }
    showOverlay('join', () => openBoard(hashId), undefined, details);
    return;
  }

  let boards;
  try {
    boards = await api.boards();
  } catch {
    showOverlay('offline');
    return;
  }
  if (!boards.length && await migrateFromBrowser()) boards = await api.boards();
  // A link to one of your boards opens it. With no link you start blank: your boards are in the menu,
  // and a visit alone never shows (or creates) a board.
  if (boards.some((b) => b.id === hashId)) openBoard(hashId);
  else if (hashId) await openSomeoneElses(hashId);
  else {
    openDraft();
    void loadBoards(boards);
  }

  window.addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (!next || next === session.boardId) return;
    void api.boards().then((mine) => (mine.some((b) => b.id === next) ? openBoard(next) : openSomeoneElses(next)), () => openBoard(next));
  });
}

/**
 * The link names a board that isn't yours. A board's address alone lets nobody in, so say so: quietly
 * showing a blank board instead leaves the visitor thinking they joined, on a board of their own.
 */
async function openSomeoneElses(id: string) {
  // Been invited to it before? Go back in through that invite.
  const invited = (await api.shared().catch(() => [])).find((b) => b.id === id);
  if (invited) {
    location.replace(`/?invite=${encodeURIComponent(invited.token)}#${id}`);
    return;
  }
  openDraft();
  showOverlay('private');
}

void main();
