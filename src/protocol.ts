// Messages exchanged over the /ws socket between the app and the server.
import type { Item } from './types';

export type Op =
  | { k: 'put'; item: Item }
  | { k: 'del'; id: string }
  | { k: 'order'; ids: string[] };

export type Role = 'owner' | 'editor' | 'viewer';

export interface Presence {
  cursor?: { x: number; y: number } | null;
  /** visible world rect */
  view?: { x: number; y: number; w: number; h: number };
  sel?: string[];
  editing?: string | null;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
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
  | { t: 'profile'; name: string; color: string }
  | { t: 'present'; on: boolean }
  | { t: 'settings'; s: Partial<BoardSettings> }
  | { t: 'kick'; id: string }
  | { t: 'voice'; on: boolean; muted: boolean }
  | { t: 'rtc'; to: string; data: RtcSignal }
  /** owner or presenter: mute someone ('*' = everyone else) */
  | { t: 'mute'; id: string };

export type ServerMsg =
  | {
      t: 'welcome';
      you: PeerInfo;
      board: { id: string; name: string; items: Item[] };
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
  | { t: 'muted'; by: string };
