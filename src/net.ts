// Server connection: REST helpers + the live socket (item sync, presence, collaboration).
import { S, getItem, noteLocalChange, pruneSelection, requestRender, resetHistory, setCollector, setSyncScheduler } from './state';
import type { Item } from './types';
import type { BoardSettings, ClientMsg, Op, PeerInfo, Presence, Role, ServerMsg } from './protocol';
import { DEFAULT_SETTINGS } from './protocol';
import { applyOps, diffItems } from './ops';

// ---------------------------------------------------------------- identity & session

export interface BoardMeta { id: string; name: string; rev: number; updated: string; itemCount: number; live?: number }

const PEER_COLORS = ['#f2555a', '#f5871f', '#e0b400', '#2fb36d', '#14a3c7', '#4f6bff', '#9b5cf0', '#e0559c'];

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('bb-profile') ?? 'null');
    if (p?.name && p?.color) return p as { name: string; color: string };
  } catch { /* ignore */ }
  return { name: '', color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] };
}

export const session = {
  /** invite token when visiting as a guest */
  invite: null as string | null,
  boardId: null as string | null,
  boardName: '',
  role: 'owner' as Role,
  you: null as PeerInfo | null,
  peers: new Map<string, PeerInfo>(),
  presenter: null as string | null,
  settings: { ...DEFAULT_SETTINGS } as BoardSettings,
  status: 'offline' as 'offline' | 'connecting' | 'live',
  profile: loadProfile(),
};

export const canEdit = () => session.role !== 'viewer';
export const isOwner = () => session.role === 'owner';

export function saveProfile(name: string, color: string) {
  session.profile = { name: name.trim().slice(0, 40), color };
  try { localStorage.setItem('bb-profile', JSON.stringify(session.profile)); } catch { /* ignore */ }
  sendMsg({ t: 'profile', name: session.profile.name || defaultName(), color });
}
const defaultName = () => (session.invite ? 'Guest' : 'Owner');

/** UI subscribes to: status, welcome, peers, presence, presenter, settings, role, meta, fatal */
export const events = new EventTarget();
const emit = (type: string, detail?: unknown) => events.dispatchEvent(new CustomEvent(type, { detail }));

// ---------------------------------------------------------------- REST

async function j<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session.invite ? { 'x-invite': session.invite } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  boards: () => j<BoardMeta[]>('GET', '/api/boards'),
  board: (id: string) => j<{ id: string; name: string; items: Item[] }>('GET', `/api/boards/${id}`),
  createBoard: (name: string, items?: Item[]) => j<BoardMeta>('POST', '/api/boards', { name, items }),
  renameBoard: (id: string, name: string) => j<BoardMeta>('PATCH', `/api/boards/${id}`, { name }),
  deleteBoard: (id: string) => j<{ ok: true }>('DELETE', `/api/boards/${id}`),
  sharing: (id: string) => j<{ invites: Invite[]; settings: BoardSettings }>('GET', `/api/boards/${id}/share`),
  createInvite: (id: string, role: 'editor' | 'viewer', label = '') => j<Invite>('POST', `/api/boards/${id}/invites`, { role, label }),
  updateInvite: (id: string, token: string, patch: Partial<Pick<Invite, 'role' | 'label'>>) => j<Invite>('PATCH', `/api/boards/${id}/invites/${token}`, patch),
  revokeInvite: (id: string, token: string) => j<{ ok: true }>('DELETE', `/api/boards/${id}/invites/${token}`),
  net: () => j<{ lan: boolean; lanUrls: string[] }>('GET', '/api/net'),
  me: (board: string) => j<{ role: Role }>('GET', `/api/me?board=${encodeURIComponent(board)}`),
  async uploadImage(blob: Blob, id?: string): Promise<string> {
    const res = await fetch(`/api/images${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream', ...(session.invite ? { 'x-invite': session.invite } : {}) },
      body: blob,
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return ((await res.json()) as { id: string }).id;
  },
};
export interface Invite { token: string; role: 'editor' | 'viewer'; label: string; created: string }

export const imageUrl = (id: string) =>
  `/api/images/${encodeURIComponent(id)}${session.invite ? `?invite=${encodeURIComponent(session.invite)}` : ''}`;

// ---------------------------------------------------------------- item sync

// Item "keys" detect changes cheaply: pen-point arrays are compared by identity.
const arrIds = new WeakMap<object, number>();
let nextArr = 1;
export function itemKey(it: Item): string {
  return JSON.stringify(it, (k, v) => {
    if (k === 'points' && Array.isArray(v)) {
      let n = arrIds.get(v);
      if (!n) { n = nextArr++; arrIds.set(v, n); }
      return `#${n}`;
    }
    return v;
  });
}

/** State the server has (plus what we've already sent). */
let known = new Map<string, string>();
let knownOrder: string[] = [];
/** Items with ops the server hasn't acknowledged yet → remote ops for them are stale. */
const pending = new Map<string, number>();
let pendingOrder = 0;
let seq = 0;
let ws: WebSocket | null = null;
let flushTimer = 0;
let firstWelcome = true;

const setKnown = (items: Item[]) => {
  known = new Map(items.map((i) => [i.id, itemKey(i)]));
  knownOrder = items.map((i) => i.id);
};

/** Diff local state against what the server knows; ship the changes. */
export function collect() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!session.boardId) return;
  const ops = diffItems(known, knownOrder, S.items, itemKey);
  if (!ops.length) return;
  noteLocalChange(ops.flatMap((o) => (o.k === 'put' ? [o.item.id] : o.k === 'del' ? [o.id] : [])), ops.some((o) => o.k === 'order'));
  if (!ws || ws.readyState !== WebSocket.OPEN || !canEdit()) return; // kept pending until we reconnect
  const s = ++seq;
  for (const o of ops) {
    if (o.k === 'put') { known.set(o.item.id, itemKey(o.item)); pending.set(o.item.id, s); }
    else if (o.k === 'del') { known.delete(o.id); pending.set(o.id, s); }
    else { knownOrder = o.ids; pendingOrder = s; }
  }
  sendMsg({ t: 'ops', ops, seq: s });
}
setCollector(collect);
setSyncScheduler(() => { flushTimer ||= window.setTimeout(collect, 40); });

function applyRemoteOps(ops: Op[]) {
  collect(); // our unsent edits go out first, so they are pending and win where they should
  const fresh = ops.filter((o) => (o.k === 'order' ? !pendingOrder : !pending.has(o.k === 'put' ? o.item.id : o.id)));
  if (!fresh.length) return;
  S.items = applyOps(S.items, fresh);
  for (const o of fresh) {
    if (o.k === 'put') known.set(o.item.id, itemKey(o.item));
    else if (o.k === 'del') known.delete(o.id);
  }
  if (fresh.some((o) => o.k === 'order') || fresh.some((o) => o.k === 'put')) knownOrder = S.items.map((i) => i.id);
  pruneSelection();
  requestRender();
}

function onAck(s: number) {
  for (const [id, v] of pending) if (v <= s) pending.delete(id);
  if (pendingOrder && pendingOrder <= s) pendingOrder = 0;
}

// ---------------------------------------------------------------- socket

function sendMsg(m: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

let retry = 0;
let retryTimer = 0;

function connect() {
  if (!session.boardId) return;
  const q = new URLSearchParams({ board: session.boardId, name: session.profile.name || defaultName(), color: session.profile.color });
  if (session.invite) q.set('invite', session.invite);
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
  ws = sock;
  session.status = 'connecting';
  emit('status');

  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let m: ServerMsg;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    handle(m);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    session.status = 'offline';
    session.peers.clear();
    session.presenter = null;
    emit('status');
    emit('peers');
    if (ev.code === 4403 || ev.code === 4404 || ev.code === 4410) {
      emit('fatal', ev.code === 4410 ? 'This board was deleted.' : ev.code === 4404 ? 'This board doesn’t exist any more.' : (ev.reason === 'revoked' ? 'Your invite was revoked.' : 'You were removed from this board.'));
      return;
    }
    retryTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
  };
}

function handle(m: ServerMsg) {
  switch (m.t) {
    case 'welcome': {
      retry = 0;
      session.status = 'live';
      session.you = m.you;
      session.role = m.you.role;
      session.boardName = m.board.name;
      session.peers = new Map(m.peers.map((p) => [p.id, p]));
      session.presenter = m.presenter;
      session.settings = m.settings;
      pending.clear();
      pendingOrder = 0;
      if (firstWelcome) {
        S.items = m.board.items;
        setKnown(m.board.items);
      } else {
        // Reconnected: replay whatever we changed while offline on top of the server state.
        const local = diffItems(known, knownOrder, S.items, itemKey);
        setKnown(m.board.items);
        S.items = applyOps(m.board.items, canEdit() ? local : []);
      }
      pruneSelection();
      const first = firstWelcome;
      firstWelcome = false;
      emit('welcome', first);
      emit('status');
      emit('peers');
      requestRender();
      collect();
      sendPresence(true);
      return;
    }
    case 'ops': applyRemoteOps(m.ops); emit('remote-ops', m.from); return;
    case 'ack': onAck(m.seq); return;
    case 'meta': session.boardName = m.name; emit('meta'); return;
    case 'deleted': emit('fatal', 'This board was deleted.'); return;
    case 'join': session.peers.set(m.peer.id, m.peer); emit('peers'); emit('join', m.peer); return;
    case 'leave': session.peers.delete(m.id); if (session.presenter === m.id) session.presenter = null; emit('peers'); emit('presenter'); return;
    case 'peer': {
      if (m.peer.id === session.you?.id) { session.you = m.peer; emit('peers'); return; }
      const prev = session.peers.get(m.peer.id);
      session.peers.set(m.peer.id, { ...m.peer, p: prev?.p });
      emit('peers');
      return;
    }
    case 'presence': {
      const peer = session.peers.get(m.id);
      if (peer) { peer.p = { ...peer.p, ...m.p }; emit('presence', m.id); }
      return;
    }
    case 'presenter': session.presenter = m.id; emit('presenter'); return;
    case 'settings': session.settings = m.s; emit('settings'); return;
    case 'role': {
      const was = session.role;
      session.role = m.role;
      if (session.you) session.you.role = m.role;
      emit('role', was);
      return;
    }
    case 'error': emit('notice', m.msg); return;
  }
}

/** Switch to a board (closes any previous connection). */
export function joinBoard(id: string) {
  clearTimeout(retryTimer);
  if (ws) { const old = ws; ws = null; old.close(); }
  session.boardId = id;
  session.peers.clear();
  session.presenter = null;
  firstWelcome = true;
  retry = 0;
  known = new Map();
  knownOrder = [];
  pending.clear();
  pendingOrder = 0;
  S.items = [];
  S.selected.clear();
  S.editing = null;
  resetHistory();
  requestRender();
  connect();
}

export function leaveBoard() {
  collect();
  clearTimeout(retryTimer);
  if (ws) { const old = ws; ws = null; old.close(); }
}

// ---------------------------------------------------------------- presence & collaboration

let lastPresence = '';
let presenceTimer = 0;
const outgoing: Presence = {};

/** Merge a presence update and send it (throttled ~20/s). */
export function setPresence(p: Presence) {
  Object.assign(outgoing, p);
  if (!presenceTimer) presenceTimer = window.setTimeout(() => sendPresence(false), 50);
}
function sendPresence(force: boolean) {
  clearTimeout(presenceTimer);
  presenceTimer = 0;
  const s = JSON.stringify(outgoing);
  if (!force && s === lastPresence) return;
  lastPresence = s;
  sendMsg({ t: 'presence', p: outgoing });
}

export const present = (on: boolean) => sendMsg({ t: 'present', on });
export const updateSettings = (s: Partial<BoardSettings>) => sendMsg({ t: 'settings', s });
export const kick = (id: string) => sendMsg({ t: 'kick', id });

/** Peer currently editing this item, if any. */
export function editorOf(id: string): PeerInfo | undefined {
  for (const p of session.peers.values()) if (p.p?.editing === id) return p;
  return undefined;
}
export const hasItem = (id: string) => !!getItem(id);
