// Live rooms over WebSocket: item-level sync, presence, presenting, and per-board settings.
// The in-memory room is authoritative while people are connected; it is written to disk shortly
// after each change. Writes from other processes (the MCP server) are merged in via a file watcher.
import { WebSocketServer, type WebSocket } from 'ws';
import { watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { BOARDS_DIR, ensureDirs, isValidId, newId, readBoard, writeBoard, type Board } from './store.ts';
import { inviteToken, isCrossSite, ownerKeyOf, owns, principal } from './auth.ts';

/** How a client got in: as the board's owner, or with an invite token. */
type Identity = { owner: true; token: null } | { owner: false; token: string; key: string | null };
import { getSharing, inviteRole, noteInviteUse, revokeInvite, setSettings } from './sharing.ts';
import { applyOps, diffItems, validOp } from '../src/ops.ts';
import { MAX_VIEWS, cleanView, type BoardSettings, type ClientMsg, type Op, type PeerInfo, type Presence, type Role, type ServerMsg } from '../src/protocol.ts';
import { COLORS, type Item } from '../src/types.ts';

interface Client {
  ws: WebSocket;
  id: string;
  name: string;
  color: string;
  baseRole: Role;
  identity: Identity;
  p: Presence;
  alive: boolean;
  /** voice chat */
  voice: boolean;
  selfMuted: boolean;
}
interface Room {
  id: string;
  board: Board;
  /** item json + order as last written to / read from disk */
  known: Map<string, string>;
  knownOrder: string[];
  writtenRev: number;
  dirty: boolean;
  timer: NodeJS.Timeout | null;
  clients: Set<Client>;
  presenter: string | null;
  settings: BoardSettings;
  dead: boolean;
}

const rooms = new Map<string, Promise<Room | null>>();
const PEER_COLORS = ['#f2555a', '#f5871f', '#e0b400', '#2fb36d', '#14a3c7', '#4f6bff', '#9b5cf0', '#e0559c'];

function snapshot(items: Item[]) {
  return { known: new Map(items.map((i) => [i.id, JSON.stringify(i)])), order: items.map((i) => i.id) };
}

function getRoom(id: string): Promise<Room | null> {
  let p = rooms.get(id);
  if (!p) {
    p = (async () => {
      const board = await readBoard(id);
      if (!board) { rooms.delete(id); return null; }
      const s = snapshot(board.items);
      const sharing = await getSharing(id);
      return {
        id, board, known: s.known, knownOrder: s.order, writtenRev: board.rev, dirty: false, timer: null,
        clients: new Set(), presenter: null, settings: { ...sharing.settings }, dead: false,
      };
    })();
    rooms.set(id, p);
  }
  return p;
}

// ------------------------------------------------------------------ persistence

function schedulePersist(room: Room) {
  room.dirty = true;
  room.timer ??= setTimeout(() => void persist(room), 250);
}

async function persist(room: Room) {
  room.timer = null;
  if (room.dead || !room.dirty) return;
  room.dirty = false;
  room.board.rev = Math.max(room.board.rev, room.writtenRev) + 1;
  room.writtenRev = room.board.rev;
  const s = snapshot(room.board.items);
  room.known = s.known;
  room.knownOrder = s.order;
  try {
    await writeBoard(room.board);
  } catch (err) {
    console.error('[brainboard] failed to save board', room.id, err);
    room.dirty = true;
  }
}

/** Board files changed on disk: merge outside edits (e.g. from an AI agent) into the live room. */
async function onFileChange(id: string) {
  const p = rooms.get(id);
  if (!p) return;
  const room = await p;
  if (!room || room.dead) return;
  const b = await readBoard(id).catch(() => null);
  if (!b) {
    room.dead = true;
    if (room.timer) clearTimeout(room.timer);
    broadcast(room, { t: 'deleted' });
    for (const c of room.clients) c.ws.close(4410, 'board deleted');
    rooms.delete(id);
    return;
  }
  if (b.rev === room.writtenRev) return; // our own write
  const ops = diffItems(room.known, room.knownOrder, b.items);
  const s = snapshot(b.items);
  room.known = s.known;
  room.knownOrder = s.order;
  room.writtenRev = b.rev;
  room.board.rev = Math.max(room.board.rev, b.rev);
  if (b.name !== room.board.name) {
    room.board.name = b.name;
    broadcast(room, { t: 'meta', name: b.name });
  }
  const views = (b.views ?? []).map(cleanView).filter((v) => v !== null);
  if (JSON.stringify(views) !== JSON.stringify(room.board.views ?? [])) {
    room.board.views = views;
    broadcast(room, { t: 'views', views });
  }
  if (ops.length) {
    room.board.items = applyOps(room.board.items, ops);
    broadcast(room, { t: 'ops', ops, from: 'agent' });
  }
  if (room.dirty) schedulePersist(room);
}

let watcher: FSWatcher | null = null;
const fileTimers = new Map<string, NodeJS.Timeout>();
function startWatcher() {
  if (watcher) return;
  ensureDirs();
  watcher = watch(BOARDS_DIR, (_e, filename) => {
    const f = filename ? String(filename) : '';
    if (!f.endsWith('.json')) return;
    const id = f.slice(0, -5);
    clearTimeout(fileTimers.get(id));
    fileTimers.set(id, setTimeout(() => { fileTimers.delete(id); void onFileChange(id); }, 40));
  });
}

// ------------------------------------------------------------------ messaging

const send = (c: Client, m: ServerMsg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
function broadcast(room: Room, m: ServerMsg, except?: Client) {
  const data = JSON.stringify(m);
  for (const c of room.clients) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
}

const roleOf = (room: Room, c: Client): Role =>
  c.baseRole !== 'owner' && room.settings.paused ? 'viewer' : c.baseRole;

/** Owner and presenter can always talk; in stage mode nobody else can. */
const canSpeak = (room: Room, c: Client) => !room.settings.stage || c.baseRole === 'owner' || room.presenter === c.id;
const mutedNow = (room: Room, c: Client) => c.selfMuted || !canSpeak(room, c);
const moderates = (room: Room, c: Client) => c.baseRole === 'owner' || room.presenter === c.id;

const info = (room: Room, c: Client, withPresence = true): PeerInfo => ({
  id: c.id, name: c.name, color: c.color, role: roleOf(room, c),
  ...(c.voice ? { voice: true, muted: mutedNow(room, c) } : {}),
  ...(withPresence ? { p: c.p } : {}),
});

/** Re-announce everyone in voice (after stage mode or the presenter changes who may talk). */
const announceVoice = (room: Room) => {
  for (const o of room.clients) if (o.voice) broadcast(room, { t: 'peer', peer: info(room, o, false) });
};

const validSignal = (d: unknown): boolean => {
  if (!d || typeof d !== 'object') return false;
  const s = d as Record<string, unknown>;
  if ((s.kind === 'offer' || s.kind === 'answer') && typeof s.sdp === 'string') return s.sdp.length < 40_000;
  if (s.kind === 'ice' && s.candidate && typeof s.candidate === 'object') return JSON.stringify(s.candidate).length < 4_000;
  return false;
};

const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
const cleanColor = (s: unknown) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? s : null);

function sanitizePresence(p: Presence): Presence {
  const out: Presence = {};
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (p.cursor === null) out.cursor = null;
  else if (p.cursor && num(p.cursor.x) && num(p.cursor.y)) out.cursor = { x: p.cursor.x, y: p.cursor.y };
  if (p.view && num(p.view.x) && num(p.view.y) && num(p.view.w) && num(p.view.h)) out.view = { ...p.view };
  if (Array.isArray(p.sel)) out.sel = p.sel.filter((s) => typeof s === 'string').slice(0, 500);
  if (p.editing === null || typeof p.editing === 'string') out.editing = p.editing;
  return out;
}

/** Called by the API when invites change: re-evaluate everyone's access. */
export async function refreshAccess(boardId: string) {
  const p = rooms.get(boardId);
  const room = p && (await p);
  if (!room) return;
  for (const c of room.clients) {
    if (c.identity.owner) continue;
    const role = await inviteRole(boardId, c.identity.token);
    if (!role) {
      send(c, { t: 'error', msg: 'Your invite was revoked by the owner.' });
      c.ws.close(4403, 'revoked');
      continue;
    }
    if (role !== c.baseRole) {
      c.baseRole = role;
      send(c, { t: 'role', role: roleOf(room, c) });
      broadcast(room, { t: 'peer', peer: info(room, c, false) }, c);
    }
  }
}

/** Who is connected through each invite link right now (owner-only: feeds the Share dialog). */
export async function onlineByInvite(boardId: string): Promise<Record<string, { id: string; name: string; color: string }[]>> {
  const room = await rooms.get(boardId);
  const out: Record<string, { id: string; name: string; color: string }[]> = {};
  for (const c of room?.clients ?? []) {
    if (c.identity.token) (out[c.identity.token] ??= []).push({ id: c.id, name: c.name, color: c.color });
  }
  return out;
}

/** The board as everyone currently sees it (the open room is newer than the file on disk). */
export async function liveBoard(id: string): Promise<Board | null> {
  const p = rooms.get(id);
  const room = p && (await p);
  return room ? room.board : null;
}

/** Who is on each open board right now (names and colours only), for the boards home screen. */
export async function livePeople(): Promise<Record<string, { name: string; color: string }[]>> {
  const out: Record<string, { name: string; color: string }[]> = {};
  for (const [id, p] of rooms) {
    const r = await p;
    if (r && r.clients.size) out[id] = [...r.clients].map((c) => ({ name: c.name, color: c.color }));
  }
  return out;
}

export async function liveCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [id, p] of rooms) {
    const r = await p;
    if (r) out[id] = r.clients.size;
  }
  return out;
}

async function handle(room: Room, c: Client, raw: string) {
  let m: ClientMsg;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'ops': {
      if (roleOf(room, c) === 'viewer') {
        send(c, { t: 'role', role: 'viewer' });
        return;
      }
      if (!Array.isArray(m.ops)) return;
      const ops = m.ops.filter(validOp) as Op[];
      if (ops.length) {
        room.board.items = applyOps(room.board.items, ops);
        schedulePersist(room);
        broadcast(room, { t: 'ops', ops, from: c.id }, c);
      }
      send(c, { t: 'ack', seq: m.seq });
      return;
    }
    case 'presence': {
      c.p = { ...c.p, ...sanitizePresence(m.p ?? {}) };
      const p = { ...c.p };
      if (roleOf(room, c) === 'viewer' && !room.settings.viewerCursors) p.cursor = null;
      broadcast(room, { t: 'presence', id: c.id, p }, c);
      return;
    }
    case 'profile': {
      const was = c.name;
      c.name = cleanName(m.name) || c.name;
      c.color = cleanColor(m.color) ?? c.color;
      if (c.identity.token && c.name !== was) void noteInviteUse(room.id, c.identity.token, c.name);
      broadcast(room, { t: 'peer', peer: info(room, c, false) });
      return;
    }
    case 'present': {
      if (roleOf(room, c) === 'viewer') return;
      if (m.on) room.presenter = c.id;
      else if (room.presenter === c.id) room.presenter = null;
      broadcast(room, { t: 'presenter', id: room.presenter });
      if (room.settings.stage) announceVoice(room);
      return;
    }
    case 'settings': {
      if (c.baseRole !== 'owner') return;
      const wasPaused = room.settings.paused;
      const wasStage = room.settings.stage;
      room.settings = await setSettings(room.id, m.s ?? {});
      broadcast(room, { t: 'settings', s: room.settings });
      if (wasStage !== room.settings.stage) announceVoice(room);
      if (wasPaused !== room.settings.paused) {
        for (const o of room.clients) {
          if (o.baseRole === 'owner') continue;
          send(o, { t: 'role', role: roleOf(room, o) });
          broadcast(room, { t: 'peer', peer: info(room, o, false) }, o);
        }
      }
      return;
    }
    case 'voice': {
      c.voice = !!m.on;
      c.selfMuted = !m.on || !!m.muted;
      broadcast(room, { t: 'peer', peer: info(room, c, false) });
      if (c.voice && !m.muted && !canSpeak(room, c)) send(c, { t: 'muted', by: 'stage' });
      return;
    }
    case 'rtc': {
      if (!c.voice || !validSignal(m.data)) return;
      for (const o of room.clients) if (o.id === m.to && o.voice) send(o, { t: 'rtc', from: c.id, data: m.data });
      return;
    }
    case 'mute': {
      if (!moderates(room, c)) return;
      for (const o of room.clients) {
        if (o === c || !o.voice || o.selfMuted || (m.id !== '*' && o.id !== m.id)) continue;
        o.selfMuted = true;
        send(o, { t: 'muted', by: c.name });
        broadcast(room, { t: 'peer', peer: info(room, o, false) });
      }
      return;
    }
    case 'view': {
      if (roleOf(room, c) === 'viewer') return;
      const list = room.board.views ?? [];
      if (m.put) {
        const v = cleanView(m.put);
        if (!v) return;
        const i = list.findIndex((o) => o.id === v.id);
        if (i >= 0) list[i] = v;
        else if (list.length < MAX_VIEWS) list.push(v);
        else return;
        room.board.views = list;
        schedulePersist(room);
        broadcast(room, { t: 'view', put: v }, c);
      } else if (typeof m.del === 'string') {
        room.board.views = list.filter((o) => o.id !== m.del);
        schedulePersist(room);
        broadcast(room, { t: 'view', del: m.del }, c);
      }
      return;
    }
    case 'ink': {
      // Live pen strokes: pass them on to everyone else as-is, never store them.
      if (roleOf(room, c) === 'viewer') return;
      const k = m.ink;
      if (!k || typeof k.id !== 'string' || k.id.length > 64 || !COLORS.includes(k.color)) return;
      if (typeof k.size !== 'number' || !Number.isFinite(k.size) || k.size <= 0) return;
      if (!Array.isArray(k.add) || k.add.length > 8000 || k.add.length % 2 || !k.add.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      const end = k.end === 'done' || k.end === 'cancel' ? { end: k.end } : {};
      broadcast(room, { t: 'ink', from: c.id, ink: { id: k.id, color: k.color, size: k.size, add: k.add, ...end } }, c);
      return;
    }
    case 'kick': {
      if (c.baseRole !== 'owner') return;
      const target = [...room.clients].find((o) => o.id === m.id);
      if (!target || target.identity.owner) return;
      // Retire their link too, or they could simply reload and walk back in.
      const token = target.identity.token;
      await revokeInvite(room.id, token);
      for (const o of room.clients) {
        if (o.identity.token !== token) continue;
        send(o, { t: 'error', msg: 'The owner removed you from this board.' });
        o.ws.close(4403, 'removed');
      }
      return;
    }
  }
}

async function onConnection(ws: WebSocket, identity: Identity, baseRole: Role, boardId: string, url: URL) {
  const room = await getRoom(boardId);
  if (!room) { ws.close(4404, 'board not found'); return; }
  const used = new Set([...room.clients].map((c) => c.color));
  const c: Client = {
    ws,
    id: newId(),
    name: cleanName(url.searchParams.get('name')) || (identity.owner ? 'Owner' : 'Guest'),
    color: cleanColor(url.searchParams.get('color')) ?? PEER_COLORS.find((col) => !used.has(col)) ?? PEER_COLORS[room.clients.size % PEER_COLORS.length],
    baseRole,
    identity,
    p: {},
    alive: true,
    voice: false,
    selfMuted: true,
  };
  room.clients.add(c);
  if (!identity.owner) void noteInviteUse(room.id, identity.token, c.name, identity.key);
  send(c, {
    t: 'welcome',
    you: info(room, c, false),
    board: { id: room.id, name: room.board.name, items: room.board.items, views: room.board.views ?? [] },
    peers: [...room.clients].filter((o) => o !== c).map((o) => info(room, o)),
    presenter: room.presenter,
    settings: room.settings,
  });
  broadcast(room, { t: 'join', peer: info(room, c, false) }, c);

  ws.on('message', (data) => { void handle(room, c, String(data)); });
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => {
    room.clients.delete(c);
    if (c.identity.token) void noteInviteUse(room.id, c.identity.token, c.name);
    broadcast(room, { t: 'leave', id: c.id });
    if (room.presenter === c.id) {
      room.presenter = null;
      broadcast(room, { t: 'presenter', id: null });
    }
  });
}

function reject(socket: Duplex, status: number, msg: string) {
  socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return; // leave other sockets (e.g. Vite HMR) alone
    void (async () => {
      if (isCrossSite(req)) return reject(socket, 403, 'Forbidden');
      const boardId = url.searchParams.get('board') ?? '';
      if (!isValidId(boardId)) return reject(socket, 403, 'Forbidden');
      let identity: Identity;
      let role: Role | null;
      const who = principal(req);
      if (await owns(who, boardId)) {
        identity = { owner: true, token: null };
        role = 'owner';
      } else {
        const token = inviteToken(req, url);
        if (!token) return reject(socket, 403, 'Forbidden');
        // Remember who joined (their browser or account), so the board shows under "Shared with you" for them.
        identity = { owner: false, token, key: ownerKeyOf(who) };
        role = await inviteRole(boardId, token);
      }
      if (!role) return reject(socket, 403, 'Forbidden');
      wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, identity, role, boardId, url));
    })();
  });
  startWatcher();
  const ping = setInterval(() => {
    for (const p of rooms.values()) {
      void p.then((room) => {
        for (const c of room?.clients ?? []) {
          if (!c.alive) { c.ws.terminate(); continue; }
          c.alive = false;
          c.ws.ping();
        }
      });
    }
  }, 30_000);
  ping.unref();
  server.on('close', () => clearInterval(ping));
}
