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
  | { t: 'view'; put?: BoardView; del?: string };

export type ServerMsg =
  | {
      t: 'welcome';
      you: PeerInfo;
      board: { id: string; name: string; items: Item[]; views?: BoardView[] };
      peers: PeerInfo[];
      presenter: string | null;
      settings: BoardSettings;
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
  | { t: 'views'; views: BoardView[] };
