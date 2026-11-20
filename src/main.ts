import './style.css';
import { S, load, saveNow } from './state';
import { applyCamera, render } from './render';
import { buildUI, updateToolUI } from './ui';
import { initInput } from './input';
import { gcBlobs } from './images';

async function main() {
  const restored = await load();
  if (!restored) S.cam = { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
  buildUI();
  initInput();
  updateToolUI();
  applyCamera();
  render();
  document.body.classList.add('ready');
  void gcBlobs(S.items);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveNow();
  });
  window.addEventListener('pagehide', () => void saveNow());
}

void main();
