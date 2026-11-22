// Saved views and nearby groups of items give even an unbookmarked board destinations.
import { intersects, unionBox } from './geometry';
import { events, session } from './net';
import { hooks } from './render';
import { S } from './state';
import type { Box, NodeItem } from './types';
import { goToView } from './views';

interface Area { key: string; name: string; detail: string; box: Box; saved: boolean }

function boardAreas(): Area[] {
  const areas: Area[] = session.views.map((v) => ({
    key: 'view-' + v.id, name: v.name, detail: 'View', box: v, saved: true,
  }));
  // Fixed board-space cells keep destinations stable as the camera moves or zooms.
  const groups = new Map<string, NodeItem[]>();
  for (const item of S.items) {
    if (item.type === 'edge') continue;
    const col = Math.floor((item.x + item.w / 2) / 1000);
    const row = Math.floor((item.y + item.h / 2) / 800);
    const key = `area-${col},${row}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const names = { note: 'Sticky note', text: 'Text', shape: 'Shape', image: 'Image', stroke: 'Sketch' };
  for (const [key, group] of groups) {
    const titled = group.find((item) => 'text' in item && item.text.trim());
    const name = titled && 'text' in titled ? titled.text.trim().split(/\r?\n/, 1)[0] : names[group[0].type];
    areas.push({ key, name, detail: group.length === 1 ? '1 item' : `${group.length} items`, box: unionBox(group), saved: false });
  }
  return areas;
}

const directions = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
const directionNames = ['right', 'lower right', 'below', 'lower left', 'left', 'upper left', 'above', 'upper right'];

export function initBoardAreas() {
  const panel = document.getElementById('board-areas')!;
  const toggle = document.getElementById('areas-toggle')!;
  const list = document.getElementById('areas-list')!;
  const rows = new Map<string, HTMLButtonElement>();
  let areas: Area[] = [];
  let boardId = session.boardId;
  let manual: boolean | undefined;
  let wasFar = false;

  function updateCamera() {
    panel.hidden = !areas.length;
    if (panel.hidden) return;
    const { x, y, z } = S.cam;
    const screen = { x: -x / z, y: -y / z, w: innerWidth / z, h: innerHeight / z };
    const far = z <= 0.25 || !areas.some((area) => intersects(area.box, screen));
    if (far && !wasFar && manual === false) manual = undefined;
    wasFar = far;
    const open = manual ?? far;
    if (!open && list.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) return;
    for (const area of areas) {
      const b = area.box;
      const dx = b.x + b.w / 2 - (screen.x + screen.w / 2);
      const dy = b.y + b.h / 2 - (screen.y + screen.h / 2);
      const octant = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
      const visible = intersects(b, screen);
      const btn = rows.get(area.key)!;
      const arrow = visible ? '●' : directions[octant];
      if (btn.firstChild!.textContent !== arrow) btn.firstChild!.textContent = arrow;
      const label = `${area.name} · ${area.detail} · ${visible ? 'on screen' : directionNames[octant]}`;
      if (btn.title !== label) {
        btn.title = label;
        btn.setAttribute('aria-label', label);
      }
    }
  }

  function rebuild() {
    if (boardId !== session.boardId) { manual = undefined; boardId = session.boardId; }
    areas = boardAreas();
    const keys = new Set(areas.map((area) => area.key));
    for (const [key, btn] of rows) {
      if (!keys.has(key)) { btn.remove(); rows.delete(key); }
    }
    for (const area of areas) {
      let btn = rows.get(area.key);
      if (!btn) {
        btn = document.createElement('button');
        btn.dataset.area = area.key;
        btn.innerHTML = '<span class="area-arrow" aria-hidden="true"></span><span class="area-name"></span><small></small>';
        rows.set(area.key, btn);
        list.append(btn);
      }
      if (btn.children[1].textContent !== area.name) btn.children[1].textContent = area.name;
      if (btn.lastChild!.textContent !== area.detail) btn.lastChild!.textContent = area.detail;
    }
    updateCamera();
  }

  toggle.addEventListener('click', () => { manual = list.hidden; updateCamera(); });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) { manual = false; updateCamera(); }
    if (['Escape', 'Enter', ' '].includes(e.key)) e.stopPropagation();
  });
  list.addEventListener('click', (e) => {
    const key = (e.target as Element).closest<HTMLButtonElement>('[data-area]')?.dataset.area;
    const area = areas.find((v) => v.key === key);
    if (area) goToView(area.box, area.saved ? 4 : 1);
  });

  events.addEventListener('views', rebuild);
  const afterRender = hooks.afterRender, afterCamera = hooks.afterCamera;
  hooks.afterRender = () => { afterRender(); rebuild(); };
  hooks.afterCamera = () => { afterCamera(); updateCamera(); };
  rebuild();
}
