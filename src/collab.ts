// Collaboration UI: people, live cursors, follow & present, sharing and roles.
import { S, requestRender } from './state';
import { hooks, nodeElOf, viewport } from './render';
import { icon } from './icons';
import { paintLogos } from './brand';
import {
  account, api, canEdit, events, isOwner, kick, present, saveProfile, session, setAccount, setPresence, updateSettings,
  type Invite,
} from './net';
import { addPasskey, ensureScreenName, openAuth, signOut } from './account';
import { canModerate, decorateVoice, mute } from './voice';
import { directorRunning, getFollowMode, observe, setFollowMode, startDirector, stopDirector, type FollowMode } from './director';
import { animateCam, setTool, stopEditing } from './actions';
import { catchUpOps, catchUpPresence, catchUpReset, initCatchUp, updateCatchUp } from './catchup';
import { toast } from './ui';
import type { PeerInfo, Role } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };

// ---------------------------------------------------------------- local prefs

let showCursors = true;
try { showCursors = localStorage.getItem('bb-show-cursors') !== '0'; } catch { /* ignore */ }

// ---------------------------------------------------------------- follow

let following: string | null = null;
let followAuto = false; // started because someone is presenting

const followLocked = () =>
  !!session.presenter && session.presenter === following && session.settings.lockFollow && session.role !== 'owner';

export function follow(id: string | null, auto = false) {
  following = id;
  followAuto = auto && !!id;
  const p = id ? session.peers.get(id) : undefined;
  viewport.classList.toggle('following', !!p);
  viewport.style.setProperty('--follow', p?.color ?? 'transparent');
  stopDirector();
  if (p && getFollowMode() === 'cinematic') startDirector(p);
  else if (p?.p?.view) followView(p);
  renderBanner();
  renderAvatars();
  updateCatchUp();
}

/** The user moved the camera themselves: stop following unless the presenter locked it. */
export function userMovedCamera() {
  if (!following) return true;
  if (followLocked()) {
    toast('The presenter has locked the view');
    return false;
  }
  follow(null);
  return true;
}

function followView(p: PeerInfo) {
  const v = p.p?.view;
  if (!v) return;
  const z = Math.min(innerWidth / v.w, innerHeight / v.h);
  const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
  animateCam({ x: innerWidth / 2 - cx * z, y: innerHeight / 2 - cy * z, z }, 140);
}

// ---------------------------------------------------------------- cursors & peer highlights

const cursorEls = new Map<string, HTMLDivElement>();
const lastMove = new Map<string, number>();

function cursorEl(p: PeerInfo) {
  let el = cursorEls.get(p.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor';
    el.dataset.peer = p.id;
    el.innerHTML = '<svg viewBox="0 0 16 20" width="16" height="20"><path d="M1.5 1.5v14l3.8-3.6 2.6 6 2.4-1-2.6-5.9h5.3z"/></svg><span></span>';
    $('cursors').append(el);
    cursorEls.set(p.id, el);
  }
  el.style.setProperty('--c', p.color);
  el.lastElementChild!.textContent = p.name;
  return el;
}

function placeCursors() {
  const { x, y, z } = S.cam;
  const now = Date.now();
  for (const [id, el] of cursorEls) {
    const p = session.peers.get(id);
    const c = p?.p?.cursor;
    if (!p || !c || !showCursors) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.transform = `translate(${c.x * z + x}px, ${c.y * z + y}px)`;
    el.classList.toggle('idle', now - (lastMove.get(id) ?? 0) > 8000);
  }
}

const decorated = new Set<HTMLElement>();
function decoratePeers() {
  for (const el of decorated) {
    el.classList.remove('peer-sel', 'peer-editing');
    el.removeAttribute('data-peer');
  }
  decorated.clear();
  for (const p of session.peers.values()) {
    const ids = new Set(p.p?.sel ?? []);
    if (p.p?.editing) ids.add(p.p.editing);
    for (const id of ids) {
      const el = nodeElOf(id);
      if (!el || el.classList.contains('peer-sel')) continue;
      el.classList.add('peer-sel');
      el.style.setProperty('--peer', p.color);
      if (p.p?.editing === id) {
        el.classList.add('peer-editing');
        el.dataset.peer = `${p.name} is typing…`;
      } else el.dataset.peer = p.name;
      decorated.add(el);
    }
  }
}

// ---------------------------------------------------------------- avatars & banner

function avatar(p: PeerInfo, extra = '') {
  return `<button class="avatar ${extra}" data-peer="${p.id}" style="--c:${p.color}" aria-label="${esc(p.name)}" data-tip="${esc(p.name)} · ${ROLE_LABEL[p.role]}">${esc(initials(p.name))}</button>`;
}

function renderAvatars() {
  const box = $('avatars');
  const others = [...session.peers.values()];
  const shown = others.slice(0, 5);
  let html = shown.map((p) => avatar(p, `${p.id === following ? 'followed' : ''} ${p.id === session.presenter ? 'presenting' : ''}`)).join('');
  if (others.length > shown.length) html += `<span class="avatar more">+${others.length - shown.length}</span>`;
  if (session.you) html += avatar({ ...session.you, name: session.you.name }, 'me');
  box.innerHTML = html;
  $('collab').classList.toggle('solo', others.length === 0);
  const pres = $('present-btn');
  pres.hidden = !canEdit() && session.presenter !== session.you?.id;
  pres.classList.toggle('on', !!session.you && session.presenter === session.you.id);
  decorateVoice();
}

function renderBanner() {
  const el = $('follow-banner');
  const me = session.you?.id;
  if (session.presenter && session.presenter === me) {
    el.innerHTML = `<i style="background:${session.you!.color}"></i>You’re presenting. Everyone follows your view.<button data-act="stop-present">Stop</button>`;
    el.hidden = false;
    return;
  }
  const p = following ? session.peers.get(following) : undefined;
  if (!p) { el.hidden = true; return; }
  const presenting = session.presenter === p.id;
  const mode = getFollowMode();
  const seg = (m: FollowMode, label: string, tip: string) =>
    `<button class="seg ${mode === m ? 'on' : ''}" data-act="mode" data-mode="${m}" aria-pressed="${mode === m}" data-tip="${tip}">${label}</button>`;
  el.innerHTML = `<i style="background:${p.color}"></i>${presenting ? `${esc(p.name)} is presenting` : `Following ${esc(p.name)}`}` +
    `<span class="segs" role="group" aria-label="Camera">${seg('cinematic', 'Cinematic', 'Smoothly frames what they’re working on')}${seg('exact', 'Exact', 'Mirrors their screen exactly')}</span>` +
    (followLocked() ? '<span class="muted">· view locked</span>' : `<button data-act="unfollow">${presenting ? 'Look around' : 'Stop'}</button>`);
  el.hidden = false;
}

// ---------------------------------------------------------------- people popover

function openPeerPop(anchor: HTMLElement, id: string) {
  const pop = $('peer-pop');
  const me = session.you?.id === id;
  const p = me ? session.you! : session.peers.get(id);
  if (!p) return;
  if (me) {
    pop.innerHTML = `
      <form class="me-form">
        <div class="pop-title">You</div>
        <label class="field"><span>Name</span><input name="name" maxlength="40" value="${esc(session.profile.name || p.name)}" /></label>
        <div class="colors">${['#f2555a', '#f5871f', '#e0b400', '#2fb36d', '#14a3c7', '#4f6bff', '#9b5cf0', '#e0559c'].map((c) => `<label class="color-pick"><input type="radio" name="color" value="${c}" ${c === p.color ? 'checked' : ''}/><i style="background:${c}"></i></label>`).join('')}</div>
        <label class="toggle"><input type="checkbox" name="cursors" ${showCursors ? 'checked' : ''}/><span>Show other people’s cursors</span></label>
        <button class="primary" type="submit">Save</button>
      </form>
      ${session.invite ? '' : `<div class="pop-account">
        ${account.user
          ? `<div class="pop-acc-who">Signed in${account.user.email ? ` as <b>${esc(account.user.email)}</b>` : ` · ${account.user.passkeys} passkey${account.user.passkeys === 1 ? '' : 's'}`}</div>
             ${account.passkeys ? `<button class="pop-btn" data-acc="passkey">${icon('passkey', 18)}Add a passkey</button>` : ''}
             <button class="pop-btn" data-acc="signout">${icon('logout', 18)}Sign out</button>`
          : `<div class="pop-acc-who">Not signed in. Your boards live in this browser.</div>
             <button class="pop-btn" data-acc="save">${icon('save', 18)}Save to an account</button>`}
      </div>`}`;
    const form = pop.querySelector('form')!;
    pop.querySelector('.pop-account')?.addEventListener('click', (e) => {
      const act = (e.target as Element).closest<HTMLElement>('[data-acc]')?.dataset.acc;
      if (!act) return;
      pop.hidden = true;
      if (act === 'passkey') void addPasskey();
      if (act === 'signout') void signOut();
      if (act === 'save') openAuth('save');
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const newName = String(fd.get('name') ?? '').trim();
      saveProfile(newName, String(fd.get('color') ?? p.color));
      if (account.user && newName && newName !== account.user.name) {
        void api.auth<{ user: NonNullable<typeof account.user> }>('me', { name: newName }, 'PATCH').then((r) => setAccount(r.user)).catch(() => toast('Couldn’t rename your account'));
      }
      showCursors = fd.get('cursors') === 'on';
      try { localStorage.setItem('bb-show-cursors', showCursors ? '1' : '0'); } catch { /* ignore */ }
      placeCursors();
      pop.hidden = true;
    });
  } else {
    pop.innerHTML = `
      <div class="pop-person"><span class="avatar" style="--c:${p.color}">${esc(initials(p.name))}</span><div><b>${esc(p.name)}</b><div class="muted">${ROLE_LABEL[p.role]}${session.presenter === p.id ? ' · presenting' : ''}</div></div></div>
      <button class="pop-btn" data-act="follow">${icon('eye', 18)}${following === p.id ? 'Stop following' : 'Follow their view'}</button>
      ${canModerate() && p.voice && !p.muted ? `<button class="pop-btn" data-act="mute">${icon('micOff', 18)}Mute</button>` : ''}
      ${isOwner() && p.role !== 'owner' ? `<button class="pop-btn danger" data-act="kick">${icon('close', 18)}Remove from board</button>` : ''}`;
    pop.onclick = (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'follow') follow(following === p.id ? null : p.id);
      if (b.dataset.act === 'kick') { kick(p.id); toast(`Removed ${p.name}`); }
      if (b.dataset.act === 'mute') { mute(p); toast(`Muted ${p.name}`); }
      pop.hidden = true;
    };
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 10}px`;
  pop.style.right = `${Math.max(12, innerWidth - r.right)}px`;
  (pop.querySelector('input[name="name"]') as HTMLInputElement | null)?.focus();
}

// ---------------------------------------------------------------- share dialog

const linkBaseKey = 'bb-link-base';
let linkBase = '';

const inviteUrl = (inv: Invite) => `${linkBase.replace(/\/+$/, '')}/?invite=${encodeURIComponent(inv.token)}#${session.boardId}`;

async function openShare() {
  if (!session.boardId) return;
  if (!(await ensureScreenName('share'))) return;
  const sheet = $('share');
  sheet.hidden = false;
  const body = sheet.querySelector<HTMLElement>('.share-body')!;
  body.innerHTML = '<p class="muted">Loading…</p>';
  $('share-title').textContent = `Share “${session.boardName}”`;
  try {
    const [sharing, net] = await Promise.all([api.sharing(session.boardId), api.net()]);
    let saved = '';
    try { saved = localStorage.getItem(linkBaseKey) ?? ''; } catch { /* ignore */ }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    linkBase = net.hosted ? (net.publicUrl ?? location.origin) : saved || (local && net.lanUrls[0]) || location.origin;
    renderShare(sharing.invites, net);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn’t load sharing settings: ${esc((err as Error).message)}</p>`;
  }
}

function renderShare(invites: Invite[], net: { lan: boolean; lanUrls: string[]; hosted: boolean }) {
  const body = $('share').querySelector<HTMLElement>('.share-body')!;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(linkBase).hostname);
  const reachNote = net.hosted ? '' : !net.lan && (local || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
    ? `<div class="note warn"><b>Only this computer can open links right now.</b> To invite people on the same Wi-Fi, restart with <code>npm run share</code>. To invite anyone else, put Brainboard behind a tunnel such as <code>cloudflared</code> or <code>ngrok</code> and paste its address below.</div>`
    : local ? `<div class="note warn">Links that point at <b>localhost</b> only work on this computer. Pick your network address below.</div>` : '';
  const people = [...session.peers.values()];
  body.innerHTML = `
    ${reachNote}
    <section>
      <h3>Invite people</h3>
      <form class="invite-form">
        <select name="role" aria-label="Permission"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
        <input name="label" maxlength="40" placeholder="Their name (optional)" aria-label="Who the link is for" />
        <button class="primary" type="submit">${icon('link', 16)} Create link</button>
      </form>
      <label class="field base" ${net.hosted ? 'hidden' : ''}><span>Link address</span>
        <input name="base" list="base-options" value="${esc(linkBase)}" spellcheck="false" />
        <datalist id="base-options">${[...net.lanUrls, location.origin].map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
      </label>
    </section>
    <section>
      <h3>Links <span class="count">${invites.length}</span></h3>
      ${invites.length ? '' : '<p class="muted small">No links yet. Anyone you send a link to can join with the permission you pick, until you revoke it.</p>'}
      <div class="invites">${invites.map((inv) => `
        <div class="invite" data-token="${esc(inv.token)}">
          <div class="invite-main"><b>${esc(inv.label)}</b><code>${esc(inviteUrl(inv))}</code></div>
          <select data-act="role" aria-label="Permission"><option value="editor" ${inv.role === 'editor' ? 'selected' : ''}>Can edit</option><option value="viewer" ${inv.role === 'viewer' ? 'selected' : ''}>Can view</option></select>
          <button class="cbtn" data-act="copy" data-tip="Copy link" aria-label="Copy link">${icon('copy', 17)}</button>
          <button class="cbtn danger" data-act="revoke" data-tip="Revoke" aria-label="Revoke link">${icon('trash', 17)}</button>
        </div>`).join('')}</div>
    </section>
    <section>
      <h3>Live session</h3>
      <label class="toggle"><input type="checkbox" data-setting="paused" ${session.settings.paused ? 'checked' : ''}/><span><b>Pause editing</b><em>Everyone except you becomes view-only until you turn this off</em></span></label>
      <label class="toggle"><input type="checkbox" data-setting="lockFollow" ${session.settings.lockFollow ? 'checked' : ''}/><span><b>Lock view while presenting</b><em>People can’t wander off while you present</em></span></label>
      <label class="toggle"><input type="checkbox" data-setting="viewerCursors" ${session.settings.viewerCursors ? 'checked' : ''}/><span><b>Show viewers’ cursors</b><em>Turn off for big audiences to keep the board calm</em></span></label>
      <label class="toggle"><input type="checkbox" data-setting="stage" ${session.settings.stage ? 'checked' : ''}/><span><b>Stage mode for voice</b><em>Only you and the presenter can talk; everyone else listens</em></span></label>
      ${people.some((x) => x.voice && !x.muted) ? '<button class="link-btn" data-mute-all>Mute everyone in voice</button>' : ''}
    </section>
    <section>
      <h3>Here now <span class="count">${people.length + 1}</span></h3>
      <div class="people">
        ${session.you ? `<div class="person"><span class="avatar" style="--c:${session.you.color}">${esc(initials(session.you.name))}</span><b>${esc(session.you.name)} <span class="muted">(you)</span></b><button class="link-btn" data-me>${session.profile.name ? 'Edit' : 'Set your name'}</button></div>` : ''}
        ${people.map((p) => `<div class="person"><span class="avatar" style="--c:${p.color}">${esc(initials(p.name))}</span><b>${esc(p.name)}</b><span class="muted">${ROLE_LABEL[p.role]}</span>${p.role !== 'owner' ? `<button class="link-btn danger" data-kick="${p.id}">Remove</button>` : ''}</div>`).join('')}
      </div>
    </section>`;

  const reload = async () => renderShare((await api.sharing(session.boardId!)).invites, net);

  body.querySelector<HTMLFormElement>('.invite-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const inv = await api.createInvite(session.boardId!, fd.get('role') === 'viewer' ? 'viewer' : 'editor', String(fd.get('label') ?? ''));
    await copy(inviteUrl(inv));
    await reload();
  });
  body.querySelector<HTMLInputElement>('input[name="base"]')!.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    try { new URL(v); } catch { toast('That isn’t a valid address'); return; }
    linkBase = v;
    try { localStorage.setItem(linkBaseKey, v); } catch { /* ignore */ }
    void reload();
  });
  body.querySelectorAll<HTMLElement>('.invite').forEach((row) => {
    const token = row.dataset.token!;
    const inv = invites.find((i) => i.token === token)!;
    row.querySelector('[data-act="copy"]')!.addEventListener('click', () => void copy(inviteUrl(inv)));
    row.querySelector('[data-act="revoke"]')!.addEventListener('click', async () => {
      await api.revokeInvite(session.boardId!, token);
      toast('Link revoked. Anyone using it was disconnected');
      await reload();
    });
    row.querySelector<HTMLSelectElement>('[data-act="role"]')!.addEventListener('change', async (e) => {
      await api.updateInvite(session.boardId!, token, { role: (e.target as HTMLSelectElement).value as 'editor' | 'viewer' });
      toast('Permission updated for everyone using this link');
    });
  });
  body.querySelector('[data-mute-all]')?.addEventListener('click', () => { mute('*'); toast('Muted everyone in voice'); });
  body.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((cb) => {
    cb.addEventListener('change', () => updateSettings({ [cb.dataset.setting!]: cb.checked }));
  });
  body.querySelector<HTMLElement>('[data-me]')?.addEventListener('click', () => {
    $('share').hidden = true;
    const me = document.querySelector<HTMLElement>('#avatars .avatar.me');
    if (me && session.you) openPeerPop(me, session.you.id);
  });
  body.querySelectorAll<HTMLElement>('[data-kick]').forEach((b) => {
    b.addEventListener('click', () => { kick(b.dataset.kick!); setTimeout(() => void reload(), 300); });
  });
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    toast(text);
  }
}

// ---------------------------------------------------------------- roles

function applyRole(prev?: Role) {
  const viewer = !canEdit();
  document.body.classList.toggle('viewer', viewer);
  $('role-badge').hidden = !(session.invite || viewer);
  $('role-badge').textContent = viewer ? (session.settings.paused ? 'View only · paused' : 'View only') : ROLE_LABEL[session.role];
  if (viewer) {
    stopEditing();
    if (S.tool !== 'select' && S.tool !== 'hand') setTool('select');
  }
  if (prev && prev !== session.role) {
    toast(viewer ? 'You can view this board, but not edit it' : 'You can edit this board now');
  }
  renderAvatars();
}

// ---------------------------------------------------------------- wiring

/**
 * The follow banner, catch-up pill and toasts sit top-centre, between the board menu (left) and the collab bar (right).
 * When those corners grow wide enough to collide (many avatars, voice, a long board name), drop below them.
 */
function dodgeCorners() {
  const corners = [$('topbar'), $('collab')].map((el) => el.getBoundingClientRect()).filter((r) => r.width);
  for (const el of [$('follow-banner'), $('catch-up'), $('toast')]) {
    el.style.top = '';
    if (el.hidden) continue;
    // Measure the resting position (offset* ignore the entry animation's transform); both are centred.
    const left = (innerWidth - el.offsetWidth) / 2, right = left + el.offsetWidth;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    const hit = corners.filter((c) => left < c.right && right > c.left && top < c.bottom && bottom > c.top);
    if (hit.length) el.style.top = `${Math.round(Math.max(...hit.map((c) => c.bottom))) + 8}px`;
  }
}

export function initCollab() {
  const ro = new ResizeObserver(dodgeCorners);
  for (const id of ['topbar', 'collab', 'follow-banner', 'catch-up', 'toast']) ro.observe($(id));
  window.addEventListener('resize', dodgeCorners);
  paintLogos($('share'));
  $('present-btn').insertAdjacentHTML('afterbegin', icon('present', 18));
  $('share-btn').insertAdjacentHTML('afterbegin', icon('users', 17));

  $('share-btn').addEventListener('click', () => void openShare());
  $('share').addEventListener('click', (e) => {
    if (e.target === $('share') || (e.target as Element).closest('.close')) $('share').hidden = true;
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('share').hidden) $('share').hidden = true;
      else if (!$('peer-pop').hidden) $('peer-pop').hidden = true;
      else if (following && !followLocked()) follow(null);
    }
  });

  $('present-btn').addEventListener('click', async () => {
    const on = session.presenter !== session.you?.id;
    if (on && !(await ensureScreenName('present'))) return;
    present(on);
    if (on) toast('Presenting. Everyone now follows your view');
  });
  $('avatars').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-peer]');
    if (b) openPeerPop(b, b.dataset.peer!);
  });
  window.addEventListener('pointerdown', (e) => {
    const pop = $('peer-pop');
    if (!pop.hidden && !(e.target as Element).closest('#peer-pop, #avatars')) pop.hidden = true;
  });
  $('follow-banner').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (b?.dataset.act === 'unfollow') follow(null);
    if (b?.dataset.act === 'mode' && following) {
      setFollowMode(b.dataset.mode as FollowMode);
      follow(following, followAuto);
    }
    if (b?.dataset.act === 'stop-present') present(false);
  });

  // outgoing presence
  viewport.addEventListener('pointermove', (e) => {
    setPresence({ cursor: { x: (e.clientX - S.cam.x) / S.cam.z, y: (e.clientY - S.cam.y) / S.cam.z } });
  });
  viewport.addEventListener('pointerleave', () => setPresence({ cursor: null }));
  const prevCam = hooks.afterCamera;
  hooks.afterCamera = () => {
    prevCam();
    const { x, y, z } = S.cam;
    setPresence({ view: { x: -x / z, y: -y / z, w: innerWidth / z, h: innerHeight / z } });
    placeCursors();
    updateCatchUp();
  };
  const prevRender = hooks.afterRender;
  hooks.afterRender = () => {
    prevRender();
    setPresence({ sel: [...S.selected].slice(0, 200), editing: S.editing });
    decoratePeers();
  };

  initCatchUp({ following: () => following, locked: followLocked, rejoin: (id) => follow(id, true) });

  // incoming
  events.addEventListener('welcome', () => {
    applyRole();
    renderAvatars();
    catchUpReset();
    if (session.presenter && session.presenter !== session.you?.id) follow(session.presenter, true);
    else renderBanner();
  });
  events.addEventListener('peers', () => {
    for (const [id, el] of cursorEls) if (!session.peers.has(id)) { el.remove(); cursorEls.delete(id); }
    if (following && !session.peers.has(following)) follow(null);
    for (const p of session.peers.values()) cursorEl(p);
    renderAvatars();
    placeCursors();
    decoratePeers();
  });
  events.addEventListener('join', (e) => toast(`${(e as CustomEvent<PeerInfo>).detail.name} joined`));
  events.addEventListener('presence', (e) => {
    const id = (e as CustomEvent<string>).detail;
    const p = session.peers.get(id);
    if (!p) return;
    cursorEl(p);
    if (p.p?.cursor) lastMove.set(id, Date.now());
    placeCursors();
    decoratePeers();
    if (following === id) {
      if (directorRunning()) observe(p);
      else followView(p);
    }
    catchUpPresence(p);
  });
  events.addEventListener('presenter', () => {
    catchUpReset();
    const pid = session.presenter;
    if (pid && pid !== session.you?.id) follow(pid, true);
    else if (followAuto) follow(null);
    else renderBanner();
    renderAvatars();
  });
  events.addEventListener('settings', () => { applyRole(); renderBanner(); updateCatchUp(); });
  events.addEventListener('role', (e) => applyRole((e as CustomEvent<Role>).detail));
  events.addEventListener('remote-ops', (e) => { requestRender(); catchUpOps((e as CustomEvent<string>).detail); });
  setInterval(placeCursors, 2000);
}
