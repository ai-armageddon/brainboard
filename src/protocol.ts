// Messages exchanged over the /ws socket between the app and the server.
import type { ColorKey, Item } from './types';

/**
 * A pen stroke while it's being drawn, streamed in small batches so others watch it appear.
 * Relayed only, never stored: the finished stroke arrives as a normal item with the same id.
 */
export interface Ink { id: string; color: ColorKey; size: number; add: number[]; end?: 'done' | 'cancel' }

export type Op =
  | { k: 'put'; item: Item }
  | { k: 'del'; id: string }
  | { k: 'order'; ids: string[] };

export type Role = 'owner' | 'editor' | 'viewer';

/** A named area of a board (world coordinates) that everyone can jump between. Saved with the board. */
export interface BoardView { id: string; name: string; x: number; y: number; w: number; h: number }
export const MAX_VIEWS = 60;

/** Validate a view from the network or disk; null if it isn't one. */
export function cleanView(v: unknown): BoardView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) && Math.abs(o[k] as number) < 1e8 ? (o[k] as number) : null);
  const [x, y, w, h] = [num('x'), num('y'), num('w'), num('h')];
  if (typeof o.id !== 'string' || !o.id || o.id.length > 64 || x === null || y === null || !w || !h || w <= 0 || h <= 0) return null;
  const name = String(o.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'View';
  return { id: o.id, name, x, y, w, h };
}

export interface Presence {
  cursor?: { x: number; y: number } | null;
  /** visible world rect */
  view?: { x: number; y: number; w: number; h: number };
  sel?: string[];
  editing?: string | null;
}

export interface LivePerson { name: string; color: string; picture?: string }

export interface PeerInfo extends LivePerson {
  id: string;
  role: Role;
  p?: Presence;
  /** in the voice chat */
  voice?: boolean;
  /** muted (by themselves, the owner/presenter, or stage mode). Everyone else silences them locally. */
  muted?: boolean;
}

/** WebRTC signalling, relayed by the server between two people in the voice chat. */
export type RtcSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } };

export interface BoardSettings {
  /** Temporarily make every guest read-only. */
  paused: boolean;
  /** Show everyone's cursors to viewers too. */
  viewerCursors: boolean;
  /** While presenting, followers can't wander off. */
  lockFollow: boolean;
  /** Voice: only the owner and the presenter can talk. */
  stage: boolean;
}
export const DEFAULT_SETTINGS: BoardSettings = { paused: false, viewerCursors: true, lockFollow: false, stage: false };

/**
 * The shared browser window. One person drives and everyone else's copy mirrors the page: where they are,
 * what they point at, click and type. Live only, like presenting: nothing about it is saved with the board.
 */
export interface BrowserState {
  /** lets people on this board load pages through /api/browse */
  key: string;
  url: string;
  /** goes up with every page load (a reload too), so everyone loads the same copy */
  n: number;
  /** who is browsing; null once they have left and nobody has taken over */
  driver: string | null;
  /** the driver's page size in CSS pixels. Watchers lay the page out at this size and scale it to fit their window. */
  w: number;
  h: number;
  back: boolean;
  fwd: boolean;
  /** where the driver is on the page, for people who arrive part-way */
  scroll?: Extract<BrowserEvent, { k: 'scroll' }>;
}

/** An element (child indexes down from <body>) and a point inside it, as fractions of its box. */
export interface BrowserAnchor { p: number[]; fx: number; fy: number }

/** What the driver does on the page. Relayed to the watchers' copies of the page, never stored. */
export type BrowserEvent =
  /** the page scrolled: pixels, plus what was in the middle of the window (pages don't lay out identically everywhere) */
  | { k: 'scroll'; x: number; y: number; a?: BrowserAnchor }
  /** something inside the page scrolled */
  | { k: 'escroll'; p: number[]; x: number; y: number }
  /** the pointer; x < 0 when it left the page */
  | { k: 'cursor'; x: number; y: number; a?: BrowserAnchor }
  | { k: 'click'; p: number[]; x: number; y: number; a?: BrowserAnchor }
  /** a form field changed: its text, or whether it is ticked */
  | { k: 'input'; p: number[]; v?: string; c?: boolean };

export type BrowserAction =
  /** go to an address or search for something. Opens the browser when it isn't open. */
  | { a: 'nav'; q: string; w?: number; h?: number }
  | { a: 'back' | 'fwd' | 'reload' | 'take' | 'close' }
  /** the page ended up at another address (a redirect, or the site changed it) */
  | { a: 'loc'; url: string; n: number }
  | { a: 'size'; w: number; h: number };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
const cleanPath = (p: unknown): number[] | null =>
  Array.isArray(p) && p.length <= 64 && p.every((n) => Number.isInteger(n) && n >= 0 && n < 100_000) ? (p as number[]) : null;
function cleanAnchor(a: unknown): BrowserAnchor | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Record<string, unknown>;
  const p = cleanPath(o.p);
  return p && finite(o.fx) && finite(o.fy) ? { p, fx: o.fx, fy: o.fy } : undefined;
}

/** Validate a browser event from the network or from a page; null if it isn't one. */
export function cleanBrowserEvent(e: unknown): BrowserEvent | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  const a = cleanAnchor(o.a);
  switch (o.k) {
    case 'scroll': return finite(o.x) && finite(o.y) ? { k: 'scroll', x: o.x, y: o.y, ...(a ? { a } : {}) } : null;
    case 'cursor': return finite(o.x) && finite(o.y) ? { k: 'cursor', x: o.x, y: o.y, ...(a ? { a } : {}) } : null;
    case 'escroll': {
      const p = cleanPath(o.p);
      return p && finite(o.x) && finite(o.y) ? { k: 'escroll', p, x: o.x, y: o.y } : null;
    }
    case 'click': {
      const p = cleanPath(o.p);
      return p && finite(o.x) && finite(o.y) ? { k: 'click', p, x: o.x, y: o.y, ...(a ? { a } : {}) } : null;
    }
    case 'input': {
      const p = cleanPath(o.p);
      if (!p) return null;
      if (typeof o.c === 'boolean') return { k: 'input', p, c: o.c };
      return typeof o.v === 'string' && o.v.length <= 4000 ? { k: 'input', p, v: o.v } : null;
    }
  }
  return null;
}

export type ClientMsg =
  | { t: 'ops'; ops: Op[]; seq: number }
  | { t: 'presence'; p: Presence }
  | { t: 'profile'; name: string; color: string; picture?: string }
  | { t: 'present'; on: boolean }
  | { t: 'settings'; s: Partial<BoardSettings> }
  | { t: 'kick'; id: string }
  | { t: 'voice'; on: boolean; muted: boolean }
  | { t: 'rtc'; to: string; data: RtcSignal }
  /** owner or presenter: mute someone ('*' = everyone else) */
  | { t: 'mute'; id: string }
  | { t: 'ink'; ink: Ink }
  /** add/replace a view, or delete one by id */
  | { t: 'view'; put?: BoardView; del?: string }
  | { t: 'browser'; do: BrowserAction }
  /** the driver's page activity on page load `n` */
  | { t: 'bev'; n: number; e: BrowserEvent };

export type ServerMsg =
  | {
      t: 'welcome';
      you: PeerInfo;
      board: { id: string; name: string; items: Item[]; views?: BoardView[] };
      peers: PeerInfo[];
      presenter: string | null;
      settings: BoardSettings;
      browser?: BrowserState | null;
    }
  | { t: 'ops'; ops: Op[]; from: string }
  | { t: 'ack'; seq: number }
  | { t: 'meta'; name: string }
  | { t: 'deleted' }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'leave'; id: string }
  | { t: 'peer'; peer: PeerInfo }
  | { t: 'presence'; id: string; p: Presence }
  | { t: 'presenter'; id: string | null }
  | { t: 'settings'; s: BoardSettings }
  | { t: 'role'; role: Role }
  | { t: 'error'; msg: string }
  | { t: 'rtc'; from: string; data: RtcSignal }
  | { t: 'muted'; by: string }
  | { t: 'ink'; from: string; ink: Ink }
  | { t: 'view'; put?: BoardView; del?: string }
  /** the whole list (e.g. after an agent edited the board file) */
  | { t: 'views'; views: BoardView[] }
  /** the shared browser opened, changed or (null) closed */
  | { t: 'browser'; s: BrowserState | null }
  | { t: 'bev'; n: number; e: BrowserEvent };
